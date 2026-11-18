/**
 * End-to-end run of RFC 0001 on real Fiber nodes and the CKB public testnet.
 *
 * Three scenarios, each paid by an ordinary Fiber node that knows nothing
 * about the protocol:
 *
 *   A  path A  — the receiver wakes up in time and is paid over its channel.
 *   B  path B  — the receiver stays offline, the LSP opens a claim cell, and
 *                the receiver later claims it on L1 with an empty wallet.
 *   C  refund  — nobody claims; the LSP refunds the cell and returns the
 *                payer's money.
 *   D  outage  — the LSP crashes while sending a claim cell, restarts, then is
 *                down when the cell expires; a separate watcher refunds it.
 *
 * Usage (from lsp/):
 *   TESTNET_PRIVATE_KEY=0x... NODE_USE_ENV_PROXY=1 npm run e2e
 */
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CKB, type Deployment } from "./claim.js";
import type { Hex, Payment } from "./fiber.js";
import { AsyncReceiveLsp, type LspConfig, type PendingPayment } from "./lsp.js";
import {
  buildClaimForVerifiedCell,
  ClaimCellRejected,
  createHashPool,
  verifyClaimCell,
} from "./receiver.js";
import { callLsp, createLspServer } from "./server.js";
import {
  type FiberNode,
  listChannels,
  sleep,
  startTestEnv,
  waitFor,
  WORK_DIR,
} from "./testnet-env.js";
import { sweepExpiredClaimCells } from "./watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = resolve(HERE, "../../e2e/deployment.testnet.json");
const REPORT_PATH = resolve(HERE, "../e2e-testnet-report.json");
const EXPLORER = "https://testnet.explorer.nervos.org/transaction/";
const LSP_PORT = 18300;
const WAKE_PORT = 18301;
const LSP_URL = `http://127.0.0.1:${LSP_PORT}`;

const HOUR = 3_600_000n;
const MINUTE = 60_000n;

type Check = { scenario: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function check(scenario: string, name: string, ok: boolean, detail: string) {
  checks.push({ scenario, name, ok, detail });
  log(`${ok ? "ok  " : "FAIL"} ${scenario} / ${name}: ${detail}`);
}

/** The payer's spendable balance in its channel with the LSP. */
async function payerBalance(payer: FiberNode, lspPubkey: string): Promise<bigint> {
  const channels = await listChannels(payer, lspPubkey);
  return channels.reduce((sum, c) => sum + BigInt(c.local_balance), 0n);
}

async function waitPayment(payer: FiberNode, hash: Hex, timeoutMs: number): Promise<Payment> {
  return waitFor(
    `payer payment ${hash.slice(0, 10)}… to finish`,
    async () => {
      const payment = await payer.rpc.getPayment(hash);
      return payment.status === "Success" || payment.status === "Failed" ? payment : undefined;
    },
    timeoutMs,
    3000,
  );
}

async function main() {
  const env = await startTestEnv(log);
  const { client, funder, nodes } = env;
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;

  // Each run starts the LSP with a clean slate; the chain and the nodes carry
  // whatever persists.
  const statePath = join(WORK_DIR, "lsp-state.json");
  rmSync(statePath, { force: true });

  const lspConfig: LspConfig = {
    fiber: nodes.lsp.rpc,
    client,
    signer: funder,
    deployment,
    statePath,
    currency: "Fibt",
    feePathA: { base: 0n, ppm: 1000n },
    feePathB: { base: 1n * CKB, ppm: 1000n },
    dFinalMs: 24n * HOUR,
    dMinMs: 160n * MINUTE,
    dRandMs: 4n * HOUR,
    dFwdMs: 4n * HOUR,
    deltaSettleMs: 4n * HOUR,
    tWakeMs: 20_000n,
    wMinMs: 6n * HOUR,
    deltaMarginMs: 1n * HOUR,
    invoiceExpirySeconds: 3600n,
    wake: async (endpoint) => {
      await fetch(endpoint, { method: "POST" });
    },
    log: (message) => log(`lsp: ${message}`),
  };
  const lsp = new AsyncReceiveLsp(lspConfig);
  await lsp.init();
  const lspServer = createLspServer(lsp);
  await new Promise<void>((r) => lspServer.listen(LSP_PORT, "127.0.0.1", r));
  const ticker = setInterval(() => void lsp.tick(), 3000);

  // The wake endpoint stands in for a push service: it only says "wake up".
  let wakes = 0;
  let onWake: (() => void) | undefined;
  const wakeServer = createServer((_, response) => {
    wakes += 1;
    onWake?.();
    response.end();
  });
  await new Promise<void>((r) => wakeServer.listen(WAKE_PORT, "127.0.0.1", r));

  const info = await callLsp<{
    refundLock: ccc.ScriptLike;
    nodePubkey: string;
    claimLock: Deployment;
  }>(LSP_URL, "lsp_async_get_info", {});
  const txs: Record<string, string> = {};

  const freshLock = async () =>
    (
      await new ccc.SignerCkbPrivateKey(
        client,
        ccc.hexFrom(randomBytes(32)),
      ).getRecommendedAddressObj()
    ).script;
  // Fiber's JSON uses snake_case field names.
  const fundingLock = (
    await nodes.receiver.rpc.call<{
      default_funding_lock_script: { code_hash: Hex; hash_type: string; args: Hex };
    }>("node_info")
  ).default_funding_lock_script;
  const receiverNodeLock = ccc.Script.from({
    codeHash: fundingLock.code_hash,
    hashType: fundingLock.hash_type,
    args: fundingLock.args,
  });

  const register = (lock: ccc.Script, hashes: Hex[], withNode: boolean) =>
    callLsp<{ receiverId: string; token: string }>(LSP_URL, "lsp_async_register", {
      lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args },
      node_pubkey: withNode ? nodes.receiver.pubkey : undefined,
      wake_endpoint: withNode ? `http://127.0.0.1:${WAKE_PORT}/` : undefined,
      hash_algorithm: "ckb_hash",
      hashes,
    });
  const requestInvoice = (receiverId: string, amount: bigint) =>
    callLsp<{ invoice: string; paymentHash: Hex }>(LSP_URL, "lsp_async_request_invoice", {
      receiver_id: receiverId,
      amount: amount.toString(),
    });
  const listPending = (receiverId: string, token: string) =>
    callLsp<PendingPayment[]>(LSP_URL, "lsp_async_list_pending", { receiver_id: receiverId }, token);
  const lspState = (hash: Hex) => lsp.getPayment(hash)?.state;
  const waitLspState = (hash: Hex, states: string[], timeoutMs: number) =>
    waitFor(
      `LSP payment ${hash.slice(0, 10)}… to reach ${states.join("/")}`,
      async () => (states.includes(lspState(hash) ?? "") ? lspState(hash) : undefined),
      timeoutMs,
      2000,
    );

  // ------------------------------------------------------------ A: path A
  {
    const s = "A: receiver wakes up, paid over its channel";
    const amount = 100n * CKB;
    const pool = createHashPool(2, "ckb_hash");
    const receiver = await register(receiverNodeLock, pool.map((e) => e.hash), true);
    const before = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    const { invoice, paymentHash } = await requestInvoice(receiver.receiverId, amount);
    const entry = pool.find((e) => e.hash === paymentHash)!;

    const woken = new Promise<void>((r) => (onWake = r));
    // Right after a restart a channel may need a moment before it can route.
    await waitFor("the payer's channel to be usable", () => nodes.payer.rpc.sendPayment({ invoice }), 120_000, 3000);
    log(`${s}: payer sent ${paymentHash}`);
    await woken;
    check(s, "LSP held the payment and sent a wake-up", lspState(paymentHash) === "HELD", `LSP state ${lspState(paymentHash)}, wake-ups ${wakes}`);
    const inflight = await nodes.payer.rpc.getPayment(paymentHash);
    check(s, "payer's payment is pending while held", inflight.status === "Inflight", `payer status ${inflight.status}`);

    // The receiver comes online: it asks what is waiting, and hands the LSP an
    // invoice for the same hash, which only it can settle.
    const pending = await listPending(receiver.receiverId, receiver.token);
    const mine = pending.find((p) => p.paymentHash === paymentHash)!;
    const net = BigInt(mine.netPathA);
    const own = await nodes.receiver.rpc.newInvoice({
      amount: net,
      paymentPreimage: entry.preimage,
      hashAlgorithm: "ckb_hash",
      currency: "Fibt",
    });
    await callLsp(LSP_URL, "lsp_async_receive", {
      receiver_id: receiver.receiverId,
      payment_hash: paymentHash,
      invoice: own.invoice_address,
    }, receiver.token);

    const paid = await waitPayment(nodes.payer, paymentHash, 180_000);
    check(s, "payer's payment succeeded", paid.status === "Success", `status ${paid.status}${paid.failed_error ? `: ${paid.failed_error}` : ""}`);
    check(s, "payer received the receiver's preimage as proof", paid.payment_preimage === entry.preimage, `preimage ${paid.payment_preimage}`);
    await waitLspState(paymentHash, ["SETTLED"], 120_000).catch(() => undefined);
    check(s, "LSP settled its incoming invoice", lspState(paymentHash) === "SETTLED", `LSP state ${lspState(paymentHash)}`);
    const receiverInvoice = await nodes.receiver.rpc.invoiceStatus(paymentHash);
    check(s, "receiver's invoice is paid", receiverInvoice === "Paid", `receiver invoice ${receiverInvoice}, net ${ccc.fixedPointToString(net)} CKB`);
    const after = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    check(s, "payer paid exactly the invoice amount plus routing fee", before - after === amount + BigInt(paid.fee), `paid ${ccc.fixedPointToString(before - after)} CKB (fee ${BigInt(paid.fee)} shannons)`);
    onWake = undefined;
  }

  // ------------------------------------------------------------ B: path B
  {
    const s = "B: receiver offline, claims on L1 with an empty wallet";
    const amount = 300n * CKB;
    // A wallet that has never held any CKB, and no Fiber node at all.
    const receiverLock = await freshLock();
    const pool = createHashPool(1, "ckb_hash");
    const receiver = await register(receiverLock, pool.map((e) => e.hash), false);
    const { invoice, paymentHash } = await requestInvoice(receiver.receiverId, amount);
    const entry = pool[0];
    await nodes.payer.rpc.sendPayment({ invoice });
    log(`${s}: payer sent ${paymentHash}`);

    await waitLspState(paymentHash, ["CELL_LIVE"], 300_000);
    const cell = lsp.getPayment(paymentHash)!.cell!;
    txs.claimCellCreate = EXPLORER + cell.txHash;
    check(s, "LSP opened a claim cell", true, EXPLORER + cell.txHash);
    const inflight = await nodes.payer.rpc.getPayment(paymentHash);
    check(s, "payer's payment is still pending", inflight.status === "Inflight", `payer status ${inflight.status}`);

    // The receiver comes online later and checks the cell against the chain
    // before revealing anything.
    const pending = await listPending(receiver.receiverId, receiver.token);
    const mine = pending.find((p) => p.paymentHash === paymentHash)!;
    const expectedNet = amount - 1n * CKB - amount / 1000n;
    const verifyParams = {
      client,
      deployment,
      outPoint: { txHash: mine.cell!.txHash, index: mine.cell!.index },
      entry,
      hashAlgorithm: "ckb_hash" as const,
      receiverLock,
      minReceiverCapacity: expectedNet,
      minConfirmations: 4n,
      marginSeconds: 3600n,
    };
    try {
      await verifyClaimCell({ ...verifyParams, minReceiverCapacity: expectedNet + 1n });
      check(s, "receiver refuses a cell that pays less than agreed", false, "accepted");
    } catch (err) {
      check(s, "receiver refuses a cell that pays less than agreed", err instanceof ClaimCellRejected, (err as Error).message);
    }
    const verified = await waitFor(
      "claim cell to reach the required confirmations",
      async () => {
        try {
          return await verifyClaimCell(verifyParams);
        } catch (err) {
          if (err instanceof ClaimCellRejected && /confirmations/.test(err.message)) {
            return undefined;
          }
          throw err;
        }
      },
      300_000,
      5000,
    );
    check(s, "receiver verified the claim cell on chain", true, `${verified.confirmations} confirmations, pays ${ccc.fixedPointToString(verified.args.receiverCapacity)} CKB`);

    const claim = buildClaimForVerifiedCell({
      deployment,
      cell: verified,
      preimage: entry.preimage,
      receiverLock,
      refundLock: info.refundLock,
    });
    const claimHash = await client.sendTransaction(claim);
    txs.claim = EXPLORER + claimHash;
    await client.waitTransaction(claimHash, 0, 600_000, 3000);
    const received = await client.getCell({ txHash: claimHash, index: 0 });
    check(
      s,
      "receiver claimed with no signature and no CKB of its own",
      !!received && received.cellOutput.lock.eq(receiverLock) && received.cellOutput.capacity === expectedNet,
      `${EXPLORER + claimHash} — receiver holds ${received ? ccc.fixedPointToString(received.cellOutput.capacity) : "?"} CKB`,
    );

    const paid = await waitPayment(nodes.payer, paymentHash, 300_000);
    check(s, "payer's payment succeeded after the claim", paid.status === "Success", `status ${paid.status}${paid.failed_error ? `: ${paid.failed_error}` : ""}`);
    check(s, "payer received the preimage the receiver put on chain", paid.payment_preimage === entry.preimage, `preimage ${paid.payment_preimage}`);
    await waitLspState(paymentHash, ["SETTLED"], 120_000).catch(() => undefined);
    check(s, "LSP read the preimage from L1 and settled upstream", lspState(paymentHash) === "SETTLED", `LSP state ${lspState(paymentHash)}`);
  }

  // ------------------------------------------------------------- C: refund
  {
    const s = "C: nobody claims, LSP refunds and the payer is made whole";
    const amount = 300n * CKB;
    const receiverLock = await freshLock();
    const pool = createHashPool(1, "ckb_hash");
    const receiver = await register(receiverLock, pool.map((e) => e.hash), false);
    // Test only: let the claim cell expire in 90 seconds instead of hours.
    (lsp as unknown as { config: { testClaimExpirySeconds?: bigint } }).config.testClaimExpirySeconds = 90n;
    const before = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    const { invoice, paymentHash } = await requestInvoice(receiver.receiverId, amount);
    await nodes.payer.rpc.sendPayment({ invoice });
    log(`${s}: payer sent ${paymentHash}`);

    await waitLspState(paymentHash, ["CELL_LIVE", "REFUNDING", "FAILED"], 300_000);
    const cell = lsp.getPayment(paymentHash)!.cell!;
    txs.refundCellCreate = EXPLORER + cell.txHash;
    try {
      await verifyClaimCell({
        client,
        deployment,
        outPoint: { txHash: cell.txHash, index: cell.index },
        entry: pool[0],
        hashAlgorithm: "ckb_hash",
        receiverLock,
        minReceiverCapacity: 0n,
        minConfirmations: 1n,
        marginSeconds: 3600n,
      });
      check(s, "receiver refuses to claim this close to expiry", false, "accepted");
    } catch (err) {
      check(s, "receiver refuses to claim this close to expiry", err instanceof ClaimCellRejected && /expiry/.test((err as Error).message), (err as Error).message);
    }

    await waitLspState(paymentHash, ["FAILED"], 20 * 60_000);
    const record = lsp.getPayment(paymentHash)!;
    txs.refund = EXPLORER + record.refundTxHash;
    check(s, "LSP refunded the claim cell after expiry", !!record.refundTxHash, EXPLORER + record.refundTxHash);
    const failed = await waitPayment(nodes.payer, paymentHash, 180_000);
    check(s, "payer's payment failed cleanly", failed.status === "Failed", `status ${failed.status}: ${failed.failed_error}`);
    await sleep(3000);
    const after = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    check(s, "payer's channel balance is back to what it was", after === before, `before ${ccc.fixedPointToString(before)} CKB, after ${ccc.fixedPointToString(after)} CKB`);
    const lspInvoice = await nodes.lsp.rpc.invoiceStatus(paymentHash);
    check(s, "LSP's invoice is cancelled", lspInvoice === "Cancelled", `invoice ${lspInvoice}`);
  }

  // ------------------------------------------------------------- D: outage
  {
    const s = "D: LSP crashes and is down at expiry; nothing is paid twice or lost";
    // The LSP process used so far stops here. Each "restart" below is a new
    // instance that knows only what is in the state file.
    clearInterval(ticker);
    await sleep(4000);
    const amount = 300n * CKB;
    const receiverLock = await freshLock();
    const pool = createHashPool(1, "ckb_hash");

    // First life: a limit that this payment does not fit under, and a node
    // connection that drops exactly when the claim cell is being sent.
    let dropSends = 1;
    const flaky = new Proxy(client, {
      get(target, prop, self) {
        if (prop === "sendTransaction" && dropSends > 0) {
          return async () => {
            dropSends -= 1;
            throw new Error("simulated crash: connection lost while sending");
          };
        }
        const value = Reflect.get(target, prop, self);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const config1: LspConfig = { ...lspConfig, client: flaky, testClaimExpirySeconds: 150n, maxExposurePerReceiver: 100n * CKB, log: (m) => log(`lsp#1: ${m}`) };
    const lsp1 = new AsyncReceiveLsp(config1);
    await lsp1.init();
    const receiver = lsp1.register({ lock: receiverLock, hashAlgorithm: "ckb_hash", hashes: pool.map((e) => e.hash) });
    const before = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    const { invoice, paymentHash } = await lsp1.requestInvoice({ receiverId: receiver.receiverId, amount });
    await nodes.payer.rpc.sendPayment({ invoice });
    log(`${s}: payer sent ${paymentHash}`);
    await waitFor("lsp#1 to hold the payment", async () => { await lsp1.tick(); return lsp1.getPayment(paymentHash)?.state === "HELD"; }, 120_000, 2000);
    await lsp1.tick();
    await lsp1.tick();
    const waiting = lsp1.getPayment(paymentHash)!;
    check(s, "a payment over the exposure limit waits instead of opening a cell", waiting.state === "HELD" && !waiting.cell && /limit/.test(waiting.note ?? ""), `state ${waiting.state}, note "${waiting.note}", exposure ${lsp1.exposure(receiver.receiverId)}`);

    config1.maxExposurePerReceiver = undefined;
    await lsp1.tick();
    const crashed = lsp1.getPayment(paymentHash)!;
    const recorded = crashed.cell?.txHash;
    const seen = recorded ? await client.getTransaction(recorded) : undefined;
    check(s, "the claim cell is on record before it is on the network", crashed.state === "CELL_PENDING" && !!recorded && dropSends === 0 && (!seen || seen.status === "unknown"), `state ${crashed.state}, recorded ${recorded}, node knows it: ${seen?.status ?? "no"}`);

    // Second life: restart from the state file.
    const lsp2 = new AsyncReceiveLsp({ ...lspConfig, testClaimExpirySeconds: 150n, log: (m) => log(`lsp#2: ${m}`) });
    await lsp2.init();
    await waitFor("lsp#2 to get the claim cell confirmed", async () => { await lsp2.tick(); return lsp2.getPayment(paymentHash)?.state === "CELL_LIVE"; }, 300_000, 3000);
    const cell = lsp2.getPayment(paymentHash)!.cell!;
    txs.outageCellCreate = EXPLORER + cell.txHash;
    let cellsForThisPayment = 0;
    for await (const found of client.findCells({ script: { codeHash: deployment.codeHash, hashType: "data2", args: cell.args }, scriptType: "lock", scriptSearchMode: "exact", withData: false })) {
      cellsForThisPayment += found ? 1 : 0;
    }
    check(s, "after the restart the same transaction was sent, and only one claim cell exists", cell.txHash === recorded && cellsForThisPayment === 1, `${EXPLORER + cell.txHash} — ${cellsForThisPayment} cell(s) for this payment`);

    // The LSP goes down again and stays down past the expiry. A watcher that
    // holds no key and none of the LSP's state returns the capacity.
    log(`${s}: LSP is down; waiting for the cell to expire`);
    const refundTx = await waitFor(
      "the watcher to refund the expired cell",
      async () => {
        const swept = await sweepExpiredClaimCells({ client, deployment, refundLocks: [info.refundLock] });
        return swept.refunded.find((r) => r.outPoint.txHash === cell.txHash && Number(r.outPoint.index) === cell.index)?.txHash;
      },
      25 * 60_000,
      10_000,
    );
    txs.outageRefund = EXPLORER + refundTx;
    await client.waitTransaction(refundTx, 0, 600_000, 3000);
    const refunded = await client.getCell({ txHash: refundTx, index: 0 });
    check(s, "a keyless watcher refunded the cell to the LSP while the LSP was down", !!refunded && refunded.cellOutput.lock.eq(ccc.Script.from(info.refundLock)), `${EXPLORER + refundTx} — ${refunded ? ccc.fixedPointToString(refunded.cellOutput.capacity) : "?"} CKB back under the LSP's lock`);

    // Third life: the LSP comes back, sees what happened on chain, and
    // returns the payer's money.
    const lsp3 = new AsyncReceiveLsp({ ...lspConfig, log: (m) => log(`lsp#3: ${m}`) });
    await lsp3.init();
    await waitFor("lsp#3 to resolve the payment", async () => { await lsp3.tick(); return lsp3.getPayment(paymentHash)?.state === "FAILED"; }, 300_000, 3000);
    check(s, "the restarted LSP recognised the refund and released the payment", /refunded in/.test(lsp3.getPayment(paymentHash)!.note ?? ""), lsp3.getPayment(paymentHash)!.note ?? "");
    const failed = await waitPayment(nodes.payer, paymentHash, 180_000);
    await sleep(3000);
    const after = await payerBalance(nodes.payer, nodes.lsp.pubkey);
    check(s, "payer's payment failed cleanly and its balance is back", failed.status === "Failed" && after === before, `status ${failed.status}; before ${ccc.fixedPointToString(before)} CKB, after ${ccc.fixedPointToString(after)} CKB`);
    check(s, "no CKB is left committed to claim cells", lsp3.exposure() === 0n, `exposure ${lsp3.exposure()}`);
  }

  // ---------------------------------------------------------------- report
  const lspInfo = await nodes.lsp.rpc.nodeInfo();
  const failed = checks.filter((c) => !c.ok);
  const report = {
    network: "ckb-testnet",
    finishedAt: new Date().toISOString(),
    fiber: { version: lspInfo.version, commit: lspInfo.commit_hash },
    claimLock: deployment,
    transactions: txs,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`${report.passed}/${checks.length} checks passed; report written to ${REPORT_PATH}`);
  lspServer.close();
  wakeServer.close();
  if (process.env.KEEP_NODES !== "1") {
    env.stop();
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
