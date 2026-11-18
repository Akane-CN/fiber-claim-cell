/**
 * The limits on claim cells, tested against a stand-in for the Fiber node.
 * Each case stops at the decision "open a claim cell or wait", so no chain
 * is needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ccc } from "../src/ccc.js";
import { CKB } from "../src/claim.js";
import type { FiberRpc, Hex, InvoiceStatus } from "../src/fiber.js";
import { AsyncReceiveLsp, type LspConfig } from "../src/lsp.js";

const HOUR = 3_600_000n;
const lock = (byte: string) =>
  ccc.Script.from({
    codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
    hashType: "type",
    args: "0x" + byte.repeat(20),
  });
const hash = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

/** A node that holds every invoice it issued, all arriving through `peer`. */
function fakeNode(peer = "02" + "aa".repeat(32)) {
  const status = new Map<Hex, InvoiceStatus>();
  const cancelled: Hex[] = [];
  const fiber = {
    nodeInfo: async () => ({ pubkey: "02" + "11".repeat(32), version: "test", commit_hash: "", addresses: [] }),
    newHoldInvoice: async (p: { paymentHash: Hex }) => {
      status.set(p.paymentHash, "Received");
      return { invoice_address: `invoice-${p.paymentHash}` };
    },
    invoiceStatus: async (h: Hex) => status.get(h) ?? "Open",
    incomingTlc: async () => ({ channelId: "0x01" as Hex, peer, expiryMs: BigInt(Date.now()) + 24n * HOUR }),
    cancelInvoice: async (h: Hex) => {
      cancelled.push(h);
      status.set(h, "Cancelled");
    },
  } as unknown as FiberRpc;
  return { fiber, cancelled, peer };
}

async function lspWith(overrides: Partial<LspConfig>, seed?: object) {
  const statePath = join(mkdtempSync(join(tmpdir(), "fcc-")), "state.json");
  if (seed) {
    writeFileSync(statePath, JSON.stringify(seed));
  }
  const node = fakeNode();
  const lsp = new AsyncReceiveLsp({
    fiber: node.fiber,
    client: {} as ccc.Client,
    signer: { getRecommendedAddressObj: async () => ({ script: lock("22") }) } as unknown as ccc.Signer,
    deployment: { txHash: hash(1), index: 0, codeHash: hash(2) },
    statePath,
    currency: "Fibt",
    feePathA: { base: 0n, ppm: 1000n },
    feePathB: { base: 1n * CKB, ppm: 1000n },
    dFinalMs: 24n * HOUR,
    dMinMs: 3n * HOUR,
    dRandMs: 4n * HOUR,
    dFwdMs: 4n * HOUR,
    deltaSettleMs: 4n * HOUR,
    tWakeMs: 0n,
    wMinMs: 6n * HOUR,
    deltaMarginMs: 1n * HOUR,
    invoiceExpirySeconds: 3600n,
    wake: async () => {},
    ...overrides,
  });
  await lsp.init();
  return { lsp, node };
}

/** One held payment for a fresh receiver; returns it after two ticks. */
async function hold(lsp: AsyncReceiveLsp, n: number, amount = 300n * CKB) {
  const { receiverId } = lsp.register({ lock: lock("11"), hashAlgorithm: "ckb_hash", hashes: [hash(n)] });
  const { paymentHash } = await lsp.requestInvoice({ receiverId, amount });
  await lsp.tick();
  await lsp.tick();
  return lsp.getPayment(paymentHash)!;
}

/** State with one claim cell already live for a payment that came through `peer`. */
const liveCell = (peer: string, receiverId = "other") => ({
  receivers: {
    [receiverId]: { id: receiverId, token: "t", lock: { codeHash: lock("33").codeHash, hashType: "type", args: lock("33").args }, hashAlgorithm: "ckb_hash", hashes: { [hash(900)]: "used" } },
  },
  payments: {
    [hash(900)]: {
      paymentHash: hash(900), receiverId, amount: "30000000000", invoice: "i", state: "CLAIMED", createdAtMs: 1, upstreamPeer: peer, history: [],
      // CLAIMED without a preimage never advances, which keeps the cell counted.
      cell: { txHash: hash(901), index: 0, args: "0x", capacity: (300n * CKB).toString(), receiverCapacity: "0", change: "0", expirySeconds: "0" },
    },
  },
});

test("the node's own figures are used for expiry and upstream peer", async () => {
  const { lsp, node } = await lspWith({ maxExposure: 0n });
  const payment = await hold(lsp, 1);
  assert.equal(payment.upstreamPeer, node.peer);
  assert.ok(payment.eInMs! > Date.now() + Number(23n * HOUR));
});

test("a payment over the per-peer limit waits; one through another peer would not", async () => {
  const peer = fakeNode().peer;
  const same = await lspWith({ maxExposurePerPeer: 500n * CKB }, liveCell(peer));
  const waiting = await hold(same.lsp, 2);
  assert.equal(waiting.state, "HELD");
  assert.match(waiting.note ?? "", /limit for the peer/);
  assert.equal(same.lsp.exposureThroughPeer(peer), 300n * CKB);

  // The same exposure, but through a different peer, does not count.
  const other = await lspWith({ maxExposurePerPeer: 500n * CKB, maxExposure: 0n }, liveCell("03" + "bb".repeat(32)));
  const next = await hold(other.lsp, 3);
  assert.match(next.note ?? "", /total limit/, "it got past the per-peer check and stopped at the next one");
});

test("the number of open cells is limited, in total and per receiver", async () => {
  const total = await lspWith({ maxCells: 1 }, liveCell("x"));
  assert.match((await hold(total.lsp, 4)).note ?? "", /as many claim cells open as it allows/);
  const perReceiver = await lspWith({ maxCellsPerReceiver: 0 });
  assert.match((await hold(perReceiver.lsp, 5)).note ?? "", /this receiver has as many/);
});

test("no claim cell is opened while a health check fails", async () => {
  const { lsp } = await lspWith({
    healthChecks: [async () => {}, async () => { throw new Error("the watchtower is not answering"); }],
  });
  const payment = await hold(lsp, 6);
  assert.equal(payment.state, "HELD");
  assert.equal(payment.cell, undefined);
  assert.match(payment.note ?? "", /not opening claim cells \(the watchtower is not answering\)/);
});

test("a payment too small for a claim cell is returned, not held", async () => {
  const { lsp, node } = await lspWith({ minPathBAmount: 500n * CKB });
  const payment = await hold(lsp, 7);
  assert.equal(payment.state, "FAILED");
  assert.deepEqual(node.cancelled, [payment.paymentHash]);
});

test("a waiting payment is returned once its claim window has closed", async () => {
  const { lsp, node } = await lspWith({ maxExposure: 0n });
  const payment = await hold(lsp, 8);
  assert.equal(payment.state, "HELD");
  payment.eInMs = Date.now() + Number(5n * HOUR); // too late for a 6-hour window plus margins
  await lsp.tick();
  assert.equal(payment.state, "FAILED");
  assert.deepEqual(node.cancelled, [payment.paymentHash]);
});
