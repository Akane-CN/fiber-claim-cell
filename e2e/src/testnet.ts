/**
 * On-chain verification of async-claim-lock on the CKB public testnet.
 *
 * Deploys the lock binary, creates real claim cells, and then exercises both
 * unlock paths against a live node: transactions that must be rejected are
 * submitted and their rejection reason recorded; transactions that must pass
 * are submitted, awaited until committed, and their outputs read back.
 *
 * Usage (from e2e/):
 *   TESTNET_PRIVATE_KEY=0x... NODE_USE_ENV_PROXY=1 npm run testnet
 *
 * The key only needs testnet CKB (about 18,500 for the first run, which
 * deploys the binary; under 1,000 afterwards).
 */
import { ccc } from "@ckb-ccc/core";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY_PATH = resolve(HERE, "../../build/release/async-claim-lock");
const DEPLOYMENT_PATH = resolve(HERE, "../deployment.testnet.json");
const REPORT_PATH = resolve(HERE, "../testnet-report.json");
const RPC_URL = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
const EXPLORER = "https://testnet.explorer.nervos.org/transaction/";

const CKB = 100_000_000n;
/** Left in every claim cell so a claim needs no input other than the cell. */
const FEE_RESERVE = 100_000n;
const SINCE_ABSOLUTE_TIMESTAMP = 0x4000_0000_0000_0000n;
const FEE_RATE = 1000n;

type Deployment = { txHash: ccc.Hex; index: number; codeHash: ccc.Hex; size: number };
type Check = {
  scenario: string;
  name: string;
  expect: "accepted" | "rejected";
  outcome: "accepted" | "rejected";
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function sha256(data: ccc.BytesLike): ccc.Hex {
  return ccc.hexFrom(createHash("sha256").update(ccc.bytesFrom(data)).digest());
}

function hash20(script: ccc.Script): Uint8Array {
  return ccc.bytesFrom(script.hash()).slice(0, 20);
}

function claimArgs(params: {
  sha256: boolean;
  paymentHash: ccc.Hex;
  receiver: ccc.Script;
  refund: ccc.Script;
  expirySeconds: bigint;
  receiverCapacity: bigint;
}): ccc.Hex {
  return ccc.hexFrom(
    ccc.bytesConcat(
      [params.sha256 ? 1 : 0],
      params.paymentHash,
      hash20(params.receiver),
      hash20(params.refund),
      ccc.numLeToBytes(SINCE_ABSOLUTE_TIMESTAMP | params.expirySeconds, 8),
      ccc.numLeToBytes(params.receiverCapacity, 8),
    ),
  );
}

function udtData(amount: bigint): ccc.Hex {
  return ccc.hexFrom(ccc.numLeToBytes(amount, 16));
}

async function main() {
  const privateKey = process.env.TESTNET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("TESTNET_PRIVATE_KEY is not set");
  }
  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
  const lsp = new ccc.SignerCkbPrivateKey(client, privateKey);
  const lspLock = (await lsp.getRecommendedAddressObj()).script;

  // The receiver and the stranger are fresh keys that never hold any CKB.
  const freshLock = async () =>
    (
      await new ccc.SignerCkbPrivateKey(
        client,
        ccc.hexFrom(randomBytes(32)),
      ).getRecommendedAddressObj()
    ).script;
  const receiverLock = await freshLock();
  const strangerLock = await freshLock();

  log(`LSP address: ${await lsp.getRecommendedAddress()}`);
  log(`LSP balance: ${ccc.fixedPointToString(await lsp.getBalance())} CKB`);

  const send = async (tx: ccc.Transaction, label: string): Promise<ccc.Hex> => {
    const txHash = await client.sendTransaction(tx);
    log(`${label}: sent ${txHash}`);
    await client.waitTransaction(txHash, 0, 600_000, 3000);
    log(`${label}: committed`);
    return txHash;
  };
  const signAndSend = async (tx: ccc.Transaction, label: string) => {
    await tx.completeInputsByCapacity(lsp);
    await tx.completeFeeBy(lsp, FEE_RATE);
    return send(await lsp.signTransaction(tx), label);
  };

  // ---------------------------------------------------------------- deploy
  const binary = readFileSync(BINARY_PATH);
  const codeHash = ccc.hashCkb(binary);
  let deployment: Deployment | undefined;
  if (existsSync(DEPLOYMENT_PATH)) {
    const saved = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
    const live = await client.getCellLive({ txHash: saved.txHash, index: saved.index }, false);
    if (live && saved.codeHash === codeHash) {
      deployment = saved;
      log(`Reusing deployment ${saved.txHash}#${saved.index}`);
    }
  }
  if (!deployment) {
    const tx = ccc.Transaction.from({ outputs: [{ lock: lspLock }], outputsData: [binary] });
    const txHash = await signAndSend(tx, "deploy");
    deployment = { txHash, index: 0, codeHash, size: binary.length };
    writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2) + "\n");
  }
  const lockDep = ccc.CellDep.from({
    outPoint: { txHash: deployment.txHash, index: deployment.index },
    depType: "code",
  });
  const claimLock = (args: ccc.Hex) =>
    ccc.Script.from({ codeHash, hashType: "data2", args });

  // xUDT in owner mode: the LSP may mint because its lock is among the inputs.
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  const udtType = ccc.Script.from({
    codeHash: xudt.codeHash,
    hashType: xudt.hashType,
    args: lspLock.hash(),
  });
  const UDT_AMOUNT = 25_000_000n;

  // ------------------------------------------------- create the claim cells
  const tipSeconds = (await client.getTipHeader()).timestamp / 1000n;
  const farExpiry = tipSeconds + 86_400n;
  // Already in the past by wall clock; the refund becomes valid once the
  // chain's median time catches up.
  const nearExpiry = tipSeconds + 30n;

  const preimages = {
    ckb: ccc.hexFrom(randomBytes(32)),
    sha: ccc.hexFrom(randomBytes(32)),
    refund: ccc.hexFrom(randomBytes(32)),
    udt: ccc.hexFrom(randomBytes(32)),
  };
  const cells = {
    // A: CKB payment, ckb_hash, 100 CKB to the receiver, 61 CKB change.
    ckb: {
      args: claimArgs({
        sha256: false,
        paymentHash: ccc.hashCkb(preimages.ckb),
        receiver: receiverLock,
        refund: lspLock,
        expirySeconds: farExpiry,
        receiverCapacity: 100n * CKB,
      }),
      capacity: 161n * CKB + FEE_RESERVE,
    },
    // B: CKB payment, sha256, no change output.
    sha: {
      args: claimArgs({
        sha256: true,
        paymentHash: sha256(preimages.sha),
        receiver: receiverLock,
        refund: lspLock,
        expirySeconds: farExpiry,
        receiverCapacity: 130n * CKB,
      }),
      capacity: 130n * CKB + FEE_RESERVE,
    },
    // C: never claimed; refunded after expiry.
    refund: {
      args: claimArgs({
        sha256: false,
        paymentHash: ccc.hashCkb(preimages.refund),
        receiver: receiverLock,
        refund: lspLock,
        expirySeconds: nearExpiry,
        receiverCapacity: 100n * CKB,
      }),
      capacity: 161n * CKB + FEE_RESERVE,
    },
    // D: xUDT payment; the LSP fronts the receiver's 142 CKB of capacity.
    udt: {
      args: claimArgs({
        sha256: false,
        paymentHash: ccc.hashCkb(preimages.udt),
        receiver: receiverLock,
        refund: lspLock,
        expirySeconds: farExpiry,
        receiverCapacity: 142n * CKB,
      }),
      capacity: 211n * CKB + FEE_RESERVE,
    },
  };

  const createTx = ccc.Transaction.from({
    outputs: [
      { lock: claimLock(cells.ckb.args), capacity: cells.ckb.capacity },
      { lock: claimLock(cells.sha.args), capacity: cells.sha.capacity },
      { lock: claimLock(cells.refund.args), capacity: cells.refund.capacity },
      { lock: claimLock(cells.udt.args), type: udtType, capacity: cells.udt.capacity },
    ],
    outputsData: ["0x", "0x", "0x", udtData(UDT_AMOUNT)],
  });
  await createTx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
  const createHashHex = await signAndSend(createTx, "create claim cells");
  const outPoint = (index: number) => ({ txHash: createHashHex, index });

  // ------------------------------------------------------------ tx builders
  const spend = (params: {
    index: number;
    since?: bigint;
    preimage?: ccc.Hex;
    outputs: { lock: ccc.Script; capacity: bigint; type?: ccc.Script; data?: ccc.Hex }[];
    udt?: boolean;
  }) => {
    const tx = ccc.Transaction.from({
      cellDeps: [lockDep],
      inputs: [{ previousOutput: outPoint(params.index), since: params.since ?? 0n }],
      outputs: params.outputs.map((o) => ({ lock: o.lock, type: o.type, capacity: o.capacity })),
      outputsData: params.outputs.map((o) => o.data ?? "0x"),
      witnesses: [
        params.preimage
          ? ccc.hexFrom(ccc.WitnessArgs.from({ lock: params.preimage }).toBytes())
          : "0x",
      ],
    });
    return tx;
  };
  const withUdtDeps = async (tx: ccc.Transaction) => {
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
    return tx;
  };

  // Transactions that are meant to be rejected go straight to the node. CCC's
  // client-side fee-rate guard is switched off for them, so that the verdict
  // recorded is the chain's and not the client library's.
  const submitRaw = (tx: ccc.Transaction) =>
    client.sendTransaction(tx, undefined, { maxFeeRate: 0 });

  const expectRejected = async (
    scenario: string,
    name: string,
    tx: ccc.Transaction,
    pattern: RegExp,
  ) => {
    try {
      const txHash = await submitRaw(tx);
      checks.push({
        scenario,
        name,
        expect: "rejected",
        outcome: "accepted",
        ok: false,
        detail: `unexpectedly accepted: ${txHash}`,
      });
      log(`FAIL ${scenario} / ${name}: accepted ${txHash}`);
    } catch (err) {
      const message = String((err as Error).message ?? err).replace(/\s+/g, " ");
      const ok = pattern.test(message);
      checks.push({
        scenario,
        name,
        expect: "rejected",
        outcome: "rejected",
        ok,
        detail: message.slice(0, 400),
      });
      log(`${ok ? "ok  " : "FAIL"} ${scenario} / ${name}: rejected (${message.slice(0, 160)})`);
    }
  };
  const expectAccepted = async (scenario: string, name: string, tx: ccc.Transaction) => {
    try {
      const txHash = await send(tx, `${scenario} / ${name}`);
      checks.push({
        scenario,
        name,
        expect: "accepted",
        outcome: "accepted",
        ok: true,
        detail: EXPLORER + txHash,
      });
      return txHash;
    } catch (err) {
      const message = String((err as Error).message ?? err).replace(/\s+/g, " ");
      checks.push({
        scenario,
        name,
        expect: "accepted",
        outcome: "rejected",
        ok: false,
        detail: message.slice(0, 400),
      });
      log(`FAIL ${scenario} / ${name}: ${message.slice(0, 200)}`);
      return undefined;
    }
  };
  const expectCell = async (
    scenario: string,
    name: string,
    txHash: ccc.Hex | undefined,
    index: number,
    lock: ccc.Script,
    capacity: bigint,
    data: ccc.Hex = "0x",
  ) => {
    if (!txHash) {
      return;
    }
    const cell = await client.getCell({ txHash, index });
    const ok =
      !!cell &&
      cell.cellOutput.lock.eq(lock) &&
      cell.cellOutput.capacity === capacity &&
      cell.outputData === data;
    checks.push({
      scenario,
      name,
      expect: "accepted",
      outcome: ok ? "accepted" : "rejected",
      ok,
      detail: cell
        ? `${ccc.fixedPointToString(cell.cellOutput.capacity)} CKB, data ${cell.outputData}`
        : "cell not found",
    });
    log(`${ok ? "ok  " : "FAIL"} ${scenario} / ${name}`);
  };

  // ----------------------------------------------------- A: CKB, ckb_hash
  {
    const s = "A: CKB claim (ckb_hash, change to LSP)";
    const good = [
      { lock: receiverLock, capacity: 100n * CKB },
      { lock: lspLock, capacity: 61n * CKB },
    ];
    await expectRejected(
      s,
      "wrong preimage",
      spend({ index: 0, preimage: ccc.hexFrom(randomBytes(32)), outputs: good }),
      /error code 20\b/,
    );
    await expectRejected(
      s,
      "payout to a stranger",
      spend({
        index: 0,
        preimage: preimages.ckb,
        outputs: [{ lock: strangerLock, capacity: 100n * CKB }, good[1]],
      }),
      /error code 22\b/,
    );
    await expectRejected(
      s,
      "receiver underpaid by 1 shannon",
      spend({
        index: 0,
        preimage: preimages.ckb,
        outputs: [{ lock: receiverLock, capacity: 100n * CKB - 1n }, good[1]],
      }),
      /error code 23\b/,
    );
    await expectRejected(
      s,
      "claimer keeps the LSP's change",
      spend({
        index: 0,
        preimage: preimages.ckb,
        outputs: [{ lock: receiverLock, capacity: 161n * CKB }],
      }),
      /error code 25\b/,
    );
    await expectRejected(
      s,
      "refund before expiry (since = expiry, not yet mature)",
      spend({
        index: 0,
        since: SINCE_ABSOLUTE_TIMESTAMP | farExpiry,
        outputs: [{ lock: lspLock, capacity: 161n * CKB }],
      }),
      /Immature/i,
    );
    await expectRejected(
      s,
      "refund with a mature since earlier than expiry",
      spend({
        index: 0,
        since: SINCE_ABSOLUTE_TIMESTAMP | (tipSeconds - 3600n),
        outputs: [{ lock: lspLock, capacity: 161n * CKB }],
      }),
      /error code 32\b/,
    );
    {
      // Two claim cells for the same receiver in one transaction: without
      // the only-input rule, output 0 would count as the payout of both.
      const merged = spend({
        index: 0,
        preimage: preimages.ckb,
        outputs: [...good, { lock: strangerLock, capacity: 130n * CKB }],
      });
      merged.inputs.push(ccc.CellInput.from({ previousOutput: outPoint(1), since: 0n }));
      merged.witnesses.push(ccc.hexFrom(ccc.WitnessArgs.from({ lock: preimages.sha }).toBytes()));
      await expectRejected(s, "a second input sharing the payout output", merged, /error code 12\b/);
    }
    // The claim itself: one input, no signature, no CKB from the receiver.
    const txHash = await expectAccepted(
      s,
      "claim with the preimage, no signature, no extra input",
      spend({ index: 0, preimage: preimages.ckb, outputs: good }),
    );
    await expectCell(s, "receiver holds 100 CKB", txHash, 0, receiverLock, 100n * CKB);
    await expectCell(s, "LSP got 61 CKB change", txHash, 1, lspLock, 61n * CKB);
  }

  // -------------------------------------------------------- B: CKB, sha256
  {
    const s = "B: CKB claim (sha256, no change output)";
    await expectRejected(
      s,
      "preimage checked with the wrong algorithm's hash",
      spend({
        index: 1,
        preimage: preimages.ckb,
        outputs: [{ lock: receiverLock, capacity: 130n * CKB }],
      }),
      /error code 20\b/,
    );
    const txHash = await expectAccepted(
      s,
      "claim with the preimage",
      spend({
        index: 1,
        preimage: preimages.sha,
        outputs: [{ lock: receiverLock, capacity: 130n * CKB }],
      }),
    );
    await expectCell(s, "receiver holds 130 CKB", txHash, 0, receiverLock, 130n * CKB);
  }

  // --------------------------------------------------------------- D: xUDT
  {
    const s = "D: xUDT claim (LSP fronts capacity)";
    const good = [
      { lock: receiverLock, capacity: 142n * CKB, type: udtType, data: udtData(UDT_AMOUNT) },
      { lock: lspLock, capacity: 69n * CKB },
    ];
    await expectRejected(
      s,
      "tokens paid to a stranger",
      await withUdtDeps(
        spend({
          index: 3,
          preimage: preimages.udt,
          outputs: [{ ...good[0], lock: strangerLock }, good[1]],
        }),
      ),
      /error code 22\b/,
    );
    await expectRejected(
      s,
      "tokens dropped from the payout",
      await withUdtDeps(
        spend({
          index: 3,
          preimage: preimages.udt,
          outputs: [{ lock: receiverLock, capacity: 142n * CKB }, good[1]],
        }),
      ),
      /error code 40\b/,
    );
    const txHash = await expectAccepted(
      s,
      "claim with the preimage",
      await withUdtDeps(spend({ index: 3, preimage: preimages.udt, outputs: good })),
    );
    await expectCell(
      s,
      "receiver holds the tokens on 142 CKB",
      txHash,
      0,
      receiverLock,
      142n * CKB,
      udtData(UDT_AMOUNT),
    );
    await expectCell(s, "LSP got 69 CKB change", txHash, 1, lspLock, 69n * CKB);
  }

  // ------------------------------------------------------------- C: refund
  {
    const s = "C: refund after expiry";
    const since = SINCE_ABSOLUTE_TIMESTAMP | nearExpiry;
    const refundOutputs = [{ lock: lspLock, capacity: 161n * CKB }];
    const refund = () => spend({ index: 2, since, outputs: refundOutputs });

    // Wait until the chain's median time passes the expiry. Until then the
    // node itself refuses the transaction as immature.
    let immatureSeen = false;
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      try {
        // A refund to a stranger is never valid, so it probes maturity
        // without spending the cell: "Immature" means keep waiting, a script
        // error means the since rule is now satisfied.
        await submitRaw(
          spend({ index: 2, since, outputs: [{ lock: strangerLock, capacity: 161n * CKB }] }),
        );
        throw new Error("refund to a stranger was accepted");
      } catch (err) {
        const message = String((err as Error).message ?? err);
        if (/Immature/i.test(message)) {
          if (!immatureSeen) {
            immatureSeen = true;
            log(`${s}: node reports the refund as immature, waiting for median time`);
          }
          if (Date.now() > deadline) {
            throw new Error("refund did not mature within 20 minutes");
          }
          await new Promise((r) => setTimeout(r, 15_000));
          continue;
        }
        if (/error code 34\b/.test(message)) {
          break;
        }
        throw err;
      }
    }
    checks.push({
      scenario: s,
      name: "refund before the chain's median time reaches expiry",
      expect: "rejected",
      outcome: immatureSeen ? "rejected" : "accepted",
      ok: immatureSeen,
      detail: immatureSeen ? "node rejected as Immature until median time passed expiry" : "never observed as immature",
    });
    await expectRejected(
      s,
      "matured refund paid to a stranger",
      spend({ index: 2, since, outputs: [{ lock: strangerLock, capacity: 161n * CKB }] }),
      /error code 34\b/,
    );
    await expectRejected(
      s,
      "matured refund paid to the receiver",
      spend({ index: 2, since, outputs: [{ lock: receiverLock, capacity: 161n * CKB }] }),
      /error code 34\b/,
    );
    await expectRejected(
      s,
      "matured refund skimming more than FEE_CAP",
      spend({ index: 2, since, outputs: [{ lock: lspLock, capacity: 160n * CKB }] }),
      /error code 35\b/,
    );
    const txHash = await expectAccepted(s, "refund to the LSP, no signature", refund());
    await expectCell(s, "LSP holds 161 CKB again", txHash, 0, lspLock, 161n * CKB);
    await expectRejected(
      s,
      "claim after the cell was refunded",
      spend({
        index: 2,
        preimage: preimages.refund,
        outputs: [
          { lock: receiverLock, capacity: 100n * CKB },
          { lock: lspLock, capacity: 61n * CKB },
        ],
      }),
      /Unknown|Dead|Resolve/i,
    );
  }

  // ---------------------------------------------------------------- report
  const failed = checks.filter((c) => !c.ok);
  const report = {
    network: "ckb-testnet",
    rpc: RPC_URL,
    finishedAt: new Date().toISOString(),
    deployment: {
      ...deployment,
      hashType: "data2",
      explorer: EXPLORER + deployment.txHash,
    },
    createClaimCellsTx: EXPLORER + createHashHex,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`${report.passed}/${checks.length} checks passed; report written to ${REPORT_PATH}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
