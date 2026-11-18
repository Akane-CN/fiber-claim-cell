/**
 * Does the LSP still get paid if its node is down when a receiver claims?
 *
 * Real Fiber nodes on the CKB testnet, at Fiber's default timings. The LSP's
 * node hands its channel data to a standalone watchtower (another process).
 * Two payments are held, a claim cell is opened for each, and then the LSP's
 * node is killed. The receiver claims both cells on L1 while the node is down.
 *
 *   P1  watchtower — the node stays down for good. A keyless relay reads the
 *       preimage from L1 and stores it in the watchtower. The payer's node
 *       force-closes the channel on its own when the TLC nears expiry, and the
 *       watchtower collects the TLC on chain with the preimage.
 *   P2  recovery   — the node comes back before the TLC nears expiry, the LSP
 *       module reads the preimage from L1 and settles over the channel. Then
 *       the node is killed again so that P1 runs its course.
 *
 * The run takes about six hours: the payer force-closes roughly four hours
 * after paying, and the watchtower's claim opens a third of an epoch later.
 * Progress is kept in a file, so the script can be stopped and started again.
 *
 * Usage (from lsp/):
 *   FIBER_E2E_DIR=/path/to/fresh/dir TESTNET_PRIVATE_KEY=0x... NODE_USE_ENV_PROXY=1 npm run e2e:watchtower
 */
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CKB, type Deployment } from "./claim.js";
import { FiberRpc, type Hex } from "./fiber.js";
import { AsyncReceiveLsp, type LspConfig } from "./lsp.js";
import { buildClaimForVerifiedCell, ClaimCellRejected, createHashPool, type PoolEntry, verifyClaimCell } from "./receiver.js";
import {
  connectPeers,
  listChannels,
  rpcUrl,
  sleep,
  startCkbRpcForwarder,
  startNode,
  startTestEnv,
  stopNode,
  type TestEnv,
  waitFor,
  WORK_DIR,
} from "./testnet-env.js";
import { relayClaims, toWatchtower } from "./watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATH = resolve(HERE, "../../e2e/deployment.testnet.json");
const REPORT_PATH = resolve(HERE, "../e2e-watchtower-report.json");
const PROGRESS_PATH = join(WORK_DIR, "watchtower-run.json");
const EXPLORER = "https://testnet.explorer.nervos.org/transaction/";

const MINUTE = 60_000n;
const HOUR = 60n * MINUTE;
/** final_expiry_delta of the invoices: a little over Fiber's minimum of 160 minutes. */
const D_FINAL = 170n * MINUTE;
/** The payer lets the route add its minimum random delay (4 hours) and no more. */
const PAYER_EXPIRY_LIMIT = D_FINAL + 4n * HOUR + 5n * MINUTE;
const AMOUNT = 200n * CKB;

type Check = { name: string; ok: boolean; detail: string };
type Event = { at: string; minutesAfterPayment?: number; what: string };
type PaymentProgress = {
  entry: PoolEntry;
  receiverKey: Hex;
  receiverId: string;
  paymentHash: Hex;
  cellTx?: Hex;
  claimTx?: Hex;
};
type Progress = {
  paidAtMs?: number;
  tlcExpiryMs?: string;
  fundingOutPoint?: { txHash: Hex; index: number };
  p1?: PaymentProgress;
  p2?: PaymentProgress;
  nodeStoppedAtMs?: number;
  relayed?: boolean;
  p2Settled?: boolean;
  nodeStoppedAgainAtMs?: number;
  commitmentTx?: Hex;
  settlementTxs?: Hex[];
  watchtowerClaimTx?: Hex;
  checks: Check[];
  events: Event[];
};

const progress: Progress = existsSync(PROGRESS_PATH)
  ? (JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as Progress)
  : { checks: [], events: [] };
const save = () => writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}
function note(what: string) {
  const minutesAfterPayment = progress.paidAtMs
    ? Math.round((Date.now() - progress.paidAtMs) / 6000) / 10
    : undefined;
  progress.events.push({ at: new Date().toISOString(), minutesAfterPayment, what });
  save();
  log(what);
}
function check(name: string, ok: boolean, detail: string) {
  progress.checks = progress.checks.filter((c) => c.name !== name);
  progress.checks.push({ name, ok, detail });
  save();
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

async function resumeWithoutLsp(): Promise<TestEnv> {
  const forwarder = await startCkbRpcForwarder();
  const client = new ccc.ClientPublicTestnet({ url: process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/" });
  const funder = new ccc.SignerCkbPrivateKey(client, process.env.TESTNET_PRIVATE_KEY!);
  const nodes = {
    payer: await startNode("payer"),
    watchtower: await startNode("watchtower"),
    lsp: { name: "lsp", rpc: new FiberRpc(rpcUrl("lsp")), pubkey: "", address: "" },
  } as TestEnv["nodes"];
  log("resumed without starting the LSP node");
  return { client, funder, nodes, stop: () => forwarder.close() };
}

async function main() {
  // Once the LSP node has been killed for good, a restart of this script must
  // not bring it back, so the environment is put together without it.
  const env = progress.nodeStoppedAgainAtMs ? await resumeWithoutLsp() : await startTestEnv(log, { watchtower: true });
  const { client, funder, nodes } = env;
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
  const lspNodeUp = () => nodes.lsp.rpc.nodeInfo().then(() => true, () => false);

  const lspConfig: LspConfig = {
    fiber: nodes.lsp.rpc,
    client,
    signer: funder,
    deployment,
    statePath: join(WORK_DIR, "lsp-state-watchtower.json"),
    currency: "Fibt",
    feePathA: { base: 0n, ppm: 1000n },
    feePathB: { base: 1n * CKB, ppm: 1000n },
    dFinalMs: D_FINAL,
    dMinMs: 160n * MINUTE,
    dRandMs: 4n * HOUR,
    dFwdMs: 4n * HOUR,
    // Real expiries throughout: the claim cell expires Δ_settle before the TLC.
    deltaSettleMs: 4n * HOUR,
    tWakeMs: 0n,
    wMinMs: 1n * HOUR,
    deltaMarginMs: 10n * MINUTE,
    minConfirmations: 2,
    refundConfirmations: 2,
    invoiceExpirySeconds: 3600n,
    wake: async () => {},
    // The circuit breaker: no claim cell unless the watchtower answers.
    healthChecks: [
      async () => {
        await nodes.watchtower.rpc.nodeInfo().catch(() => {
          throw new Error("the watchtower is not answering");
        });
      },
    ],
    log: (message) => log(`lsp: ${message}`),
  };
  const newLsp = async () => {
    const lsp = new AsyncReceiveLsp(lspConfig);
    await lsp.init();
    return lsp;
  };
  const refundLock = (await funder.getRecommendedAddressObj()).script;
  const lockOf = async (key: Hex) =>
    (await new ccc.SignerCkbPrivateKey(client, key).getRecommendedAddressObj()).script;
  const watchtowerLock = await (async () => {
    const info = await nodes.watchtower.rpc.call<{
      default_funding_lock_script: { code_hash: Hex; hash_type: string; args: Hex };
    }>("node_info");
    const l = info.default_funding_lock_script;
    return ccc.Script.from({ codeHash: l.code_hash, hashType: l.hash_type, args: l.args });
  })();

  // ------------------------------------------------- pay, hold, claim cells
  if (!progress.p1?.cellTx || !progress.p2?.cellTx) {
    const lsp = await newLsp();
    const channel = (await listChannels(nodes.payer, nodes.lsp.pubkey)).find((c) => /READY/i.test(c.state.state_name));
    const outPoint = (channel as unknown as { channel_outpoint: string }).channel_outpoint;
    // Fiber prints an out point as the 32-byte hash followed by a 4-byte LE index.
    progress.fundingOutPoint = {
      txHash: outPoint.slice(0, 66) as Hex,
      index: Number(ccc.numLeFromBytes(ccc.bytesFrom("0x" + outPoint.slice(66)))),
    };
    for (const name of ["p1", "p2"] as const) {
      const receiverKey = ccc.hexFrom(randomBytes(32));
      const [entry] = createHashPool(1, "ckb_hash");
      const receiver = lsp.register({ lock: await lockOf(receiverKey), hashAlgorithm: "ckb_hash", hashes: [entry.hash] });
      const { invoice, paymentHash } = await lsp.requestInvoice({ receiverId: receiver.receiverId, amount: AMOUNT });
      progress[name] = { entry, receiverKey, receiverId: receiver.receiverId, paymentHash };
      await waitFor(
        "the payer's channel to be usable",
        () => nodes.payer.rpc.sendPayment({ invoice, tlcExpiryLimitMs: PAYER_EXPIRY_LIMIT }),
        120_000,
        3000,
      );
      progress.paidAtMs ??= Date.now();
      note(`payer paid ${name} (${paymentHash})`);
    }
    await waitFor(
      "both claim cells to be live",
      async () => {
        await lsp.tick();
        return [progress.p1!, progress.p2!].every((p) => lsp.getPayment(p.paymentHash)?.state === "CELL_LIVE");
      },
      600_000,
      3000,
    );
    for (const name of ["p1", "p2"] as const) {
      const record = lsp.getPayment(progress[name]!.paymentHash)!;
      progress[name]!.cellTx = record.cell!.txHash;
      progress.tlcExpiryMs ??= String(record.eInMs);
      check(
        `${name}: the LSP read the TLC's real expiry and its upstream peer from the node`,
        record.upstreamPeer === nodes.payer.pubkey && record.eInMs! - progress.paidAtMs! > Number(D_FINAL + 3n * HOUR),
        `expires ${Math.round((record.eInMs! - progress.paidAtMs!) / 60_000)} minutes after payment; came through ${record.upstreamPeer?.slice(0, 16)}…`,
      );
    }
    note(`claim cells live: ${EXPLORER}${progress.p1!.cellTx} and ${EXPLORER}${progress.p2!.cellTx}`);
  }
  const p1 = progress.p1!;
  const p2 = progress.p2!;
  const tlcExpiryMs = Number(progress.tlcExpiryMs);
  const minutesTo = (ms: number) => Math.round((ms - progress.paidAtMs!) / 60_000);
  log(`TLC expiry is ${minutesTo(tlcExpiryMs)} minutes after payment; the payer should force-close near minute ${minutesTo(tlcExpiryMs) - 160}`);

  // ------------------------------------------------------- the node goes down
  if (!progress.nodeStoppedAtMs) {
    await stopNode("lsp");
    progress.nodeStoppedAtMs = Date.now();
    note("LSP node killed; both payments are held and both claim cells are live");
  }

  // ------------------------------------- the receiver claims while it is down
  for (const [name, p] of [["p1", p1], ["p2", p2]] as const) {
    if (p.claimTx) {
      continue;
    }
    const receiverLock = await lockOf(p.receiverKey);
    const verified = await waitFor(
      `${name} claim cell to be claimable`,
      async () => {
        try {
          return await verifyClaimCell({
            client,
            deployment,
            outPoint: { txHash: p.cellTx!, index: 0 },
            entry: p.entry,
            hashAlgorithm: "ckb_hash",
            receiverLock,
            minReceiverCapacity: AMOUNT - 1n * CKB - AMOUNT / 1000n,
            minConfirmations: 2n,
            marginSeconds: 600n,
          });
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
    const claim = buildClaimForVerifiedCell({ deployment, cell: verified, preimage: p.entry.preimage, receiverLock, refundLock });
    p.claimTx = await client.sendTransaction(claim);
    save();
    await client.waitTransaction(p.claimTx, 1, 600_000, 3000);
    note(`receiver claimed ${name} on L1 while the LSP node was down: ${EXPLORER}${p.claimTx}`);
  }
  check("the LSP node was down when both claims confirmed", !(await lspNodeUp()) || !!progress.p2Settled, "node RPC not answering");

  // --------------------------------- the relay hands the preimages to the tower
  if (!progress.relayed) {
    const tip = (await client.getTipHeader()).number;
    const relayed = await relayClaims({
      client,
      deployment,
      refundLocks: [refundLock],
      fromBlock: tip - 2000n,
      sinks: { watchtower: toWatchtower(rpcUrl("watchtower")) },
    });
    const got = (p: PaymentProgress) => relayed.delivered.some((d) => d.claim.paymentHash === p.paymentHash && d.claim.preimage === p.entry.preimage);
    check(
      "a keyless relay read both preimages from L1 and stored them in the watchtower",
      got(p1) && got(p2) && relayed.failed.length === 0,
      `${relayed.delivered.length} delivered, ${relayed.failed.length} failed${relayed.failed[0] ? `: ${relayed.failed[0].error}` : ""}`,
    );
    progress.relayed = got(p1) && got(p2);
    save();
  }

  // -------------------------------------- P2: the node comes back and settles
  if (!progress.p2Settled) {
    nodes.lsp = await startNode("lsp");
    await connectPeers(nodes.lsp, nodes.payer);
    const downMinutes = Math.round((Date.now() - progress.nodeStoppedAtMs!) / 6000) / 10;
    note(`LSP node restarted after ${downMinutes} minutes down`);
    const lsp = await newLsp();
    // Only P2 is worked on. P1 is left alone on purpose: it is the payment
    // whose settlement must not depend on this node.
    const step = (lsp as unknown as { step(payment: unknown): Promise<void> }).step.bind(lsp);
    await waitFor(
      "P2 to settle over the channel",
      async () => {
        await step(lsp.getPayment(p2.paymentHash)).catch((err) => log(`lsp: step failed: ${(err as Error).message}`));
        return lsp.getPayment(p2.paymentHash)?.state === "SETTLED";
      },
      300_000,
      3000,
    );
    const paid = await waitFor(
      "the payer to see P2 succeed",
      async () => {
        const payment = await nodes.payer.rpc.getPayment(p2.paymentHash);
        return payment.status === "Success" ? payment : undefined;
      },
      120_000,
      3000,
    );
    check(
      "P2: a node that was down during the claim came back and collected over the channel",
      paid.payment_preimage === p2.entry.preimage,
      `node down ${downMinutes} minutes; payer status ${paid.status}; LSP ${lsp.getPayment(p2.paymentHash)?.state}`,
    );
    const p1Invoice = await nodes.lsp.rpc.invoiceStatus(p1.paymentHash);
    check("P1 was left unsettled on the node", p1Invoice === "Received", `LSP invoice for P1 is ${p1Invoice}`);
    progress.p2Settled = true;
    save();
    await sleep(5000);
    await stopNode("lsp");
    progress.nodeStoppedAgainAtMs = Date.now();
    note("LSP node killed again, for good; P1 is still held and already claimed on L1");
  }
  if (await lspNodeUp()) {
    await stopNode("lsp");
  }

  // ----------------------------------- P1: wait for the payer to force-close
  const spenderOf = async (outPoint: ccc.OutPointLike): Promise<Hex | undefined> => {
    if (await client.getCellLive(outPoint, false, false)) {
      return undefined;
    }
    const cell = await client.getCell(outPoint);
    if (!cell) {
      return undefined;
    }
    const target = ccc.OutPoint.from(outPoint);
    for await (const entry of client.findTransactions(
      { script: cell.cellOutput.lock, scriptType: "lock", scriptSearchMode: "exact" },
      "desc",
    )) {
      if (!("isInput" in entry) || !entry.isInput) {
        continue;
      }
      const tx = await client.getTransaction(entry.txHash);
      if (tx?.transaction.inputs.some((i) => i.previousOutput.eq(target))) {
        return entry.txHash;
      }
    }
    return undefined;
  };

  if (!progress.commitmentTx) {
    log("waiting for the payer's node to force-close the channel (hours)");
    progress.commitmentTx = await waitFor(
      "the funding cell to be spent",
      async () => {
        if (await lspNodeUp()) {
          throw new Error("the LSP node is up; it must stay down for this test");
        }
        return spenderOf(progress.fundingOutPoint!);
      },
      Number(8n * HOUR),
      30_000,
    );
    note(`channel force-closed on chain: ${EXPLORER}${progress.commitmentTx}`);
    const minute = minutesTo(Date.now());
    check(
      "the payer's node force-closed by itself as the TLC neared expiry",
      Math.abs(minute - (minutesTo(tlcExpiryMs) - 160)) <= 15,
      `at minute ${minute} after payment; the TLC expires at minute ${minutesTo(tlcExpiryMs)}; the LSP node was down and did nothing`,
    );
  }

  // -------------------------- P1: wait for the watchtower to take the TLC
  const commitment = (await client.getTransaction(progress.commitmentTx))!.transaction;
  const commitmentCodeHash = commitment.outputs[0].lock.codeHash;
  const preimageHex = p1.entry.preimage.slice(2);
  if (!progress.watchtowerClaimTx) {
    log("waiting for the watchtower to collect the TLC with the preimage (about a third of an epoch)");
    progress.settlementTxs ??= [];
    let frontier: ccc.OutPointLike[] = [{ txHash: progress.commitmentTx, index: 0 }];
    const found = await waitFor(
      "a settlement that reveals P1's preimage",
      async () => {
        const next: ccc.OutPointLike[] = [];
        for (const outPoint of frontier) {
          const spender = await spenderOf(outPoint);
          if (!spender) {
            next.push(outPoint);
            continue;
          }
          const tx = (await client.getTransaction(spender))!.transaction;
          if (!progress.settlementTxs!.includes(spender)) {
            progress.settlementTxs!.push(spender);
            note(`commitment cell spent: ${EXPLORER}${spender}`);
          }
          if (tx.witnesses.some((w) => w.includes(preimageHex))) {
            return spender;
          }
          tx.outputs.forEach((output, index) => {
            if (output.lock.codeHash === commitmentCodeHash) {
              next.push({ txHash: spender, index });
            }
          });
        }
        frontier = next;
        return frontier.length === 0 ? "none" : undefined;
      },
      Number(6n * HOUR),
      30_000,
    );
    if (found === "none") {
      check(
        "P1: the watchtower collected the TLC on chain with the preimage while the LSP node was down",
        false,
        "every commitment cell was spent and none revealed the preimage: the TLC went back to the payer",
      );
      process.exit(1);
    }
    progress.watchtowerClaimTx = found as Hex;
    save();
  }
  const claimTx = (await client.getTransaction(progress.watchtowerClaimTx))!;
  const toWatchtowerLock = claimTx.transaction.outputs
    .filter((o) => o.lock.eq(watchtowerLock))
    .reduce((sum, o) => sum + o.capacity, 0n);
  const minute = minutesTo(Date.now());
  check(
    "P1: the watchtower collected the TLC on chain with the preimage while the LSP node was down",
    toWatchtowerLock >= AMOUNT - 1n * CKB,
    `${EXPLORER}${progress.watchtowerClaimTx} — ${ccc.fixedPointToString(toWatchtowerLock)} CKB to the watchtower's own lock, seen at minute ${minute}`,
  );
  check(
    "it happened before the payer's timeout path opened",
    Date.now() < tlcExpiryMs,
    `seen at minute ${minute}; the TLC expires at minute ${minutesTo(tlcExpiryMs)}`,
  );
  check("the LSP node never came back", !(await lspNodeUp()), "node RPC not answering at the end of the run");
  const payerView = await nodes.payer.rpc.getPayment(p1.paymentHash).catch((err) => ({ status: `unknown (${(err as Error).message})`, payment_preimage: undefined }));
  note(`payer's view of P1 at the end: ${payerView.status}${payerView.payment_preimage ? `, preimage ${payerView.payment_preimage}` : ""}`);

  // ------------------------------------------------------------------ report
  const failed = progress.checks.filter((c) => !c.ok);
  const payerInfo = await nodes.payer.rpc.nodeInfo();
  const report = {
    network: "ckb-testnet",
    finishedAt: new Date().toISOString(),
    fiber: { version: payerInfo.version, commit: payerInfo.commit_hash },
    claimLock: deployment,
    timings: {
      finalExpiryDeltaMinutes: Number(D_FINAL / MINUTE),
      payerExpiryLimitMinutes: Number(PAYER_EXPIRY_LIMIT / MINUTE),
      tlcExpiryMinutesAfterPayment: minutesTo(tlcExpiryMs),
    },
    transactions: {
      funding: EXPLORER + progress.fundingOutPoint!.txHash,
      p1ClaimCell: EXPLORER + p1.cellTx,
      p1ReceiverClaim: EXPLORER + p1.claimTx,
      p2ClaimCell: EXPLORER + p2.cellTx,
      p2ReceiverClaim: EXPLORER + p2.claimTx,
      forceClose: EXPLORER + progress.commitmentTx,
      settlements: progress.settlementTxs!.map((t) => EXPLORER + t),
      watchtowerClaim: EXPLORER + progress.watchtowerClaimTx,
    },
    events: progress.events,
    passed: progress.checks.length - failed.length,
    failed: failed.length,
    checks: progress.checks,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`${report.passed}/${progress.checks.length} checks passed; report written to ${REPORT_PATH}`);
  if (process.env.KEEP_NODES !== "1") {
    env.stop();
    for (const name of ["payer", "watchtower"] as const) {
      await stopNode(name).catch(() => undefined);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
