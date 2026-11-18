/**
 * Refund watcher. Refunding an expired claim cell needs no key: the lock only
 * lets the capacity go back to the refund lock named in the cell. So an LSP's
 * expired cells can be swept by any process that knows its refund lock — a
 * second machine of the LSP's, or anyone else — and the LSP does not have to
 * be up at the moment a cell expires.
 *
 * The same process can relay preimages. A claim puts the preimage on chain
 * for anyone to read. The relay reads it and hands it to the LSP's Fiber
 * watchtower, and to the LSP's node whenever that is reachable. With the
 * preimage in the watchtower, the incoming payment can still be collected on
 * chain after the upstream peer force-closes, even if the LSP's node stays
 * down. The relay holds no key either, and several can run at once.
 *
 * Standalone use (from lsp/):
 *   REFUND_LOCKS='[{"codeHash":"0x…","hashType":"type","args":"0x…"}]' \
 *   DEPLOYMENT=../e2e/deployment.testnet.json \
 *   WATCHTOWER_RPC_URL=http://127.0.0.1:8227 FIBER_RPC_URL=http://127.0.0.1:8227 \
 *   npm run watch
 * The two RPC URLs switch the relay on; without them only refunds are done.
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildRefundTx,
  type ClaimArgs,
  decodeClaimArgs,
  type Deployment,
  hashPreimage,
  lockHash20,
  spendOfClaimCell,
} from "./claim.js";
import { FiberRpc } from "./fiber.js";

export type ExpiredCell = { outPoint: ccc.OutPoint; capacity: bigint; args: ClaimArgs };
export type SweepResult = {
  /** Refund transactions accepted by the node on this pass. */
  refunded: { outPoint: ccc.OutPoint; txHash: ccc.Hex }[];
  /** Expired by the clock, but the chain's median time is not there yet. */
  immature: ccc.OutPoint[];
  failed: { outPoint: ccc.OutPoint; error: string }[];
};

/** Every live CKB claim cell that refunds to one of `refundLocks` and has expired. */
export async function findExpiredClaimCells(params: {
  client: ccc.Client;
  deployment: Deployment;
  refundLocks: ccc.ScriptLike[];
  nowSeconds?: bigint;
}): Promise<{ cell: ExpiredCell; refundLock: ccc.Script }[]> {
  const now = params.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const locks = new Map(params.refundLocks.map((l) => [lockHash20(l), ccc.Script.from(l)]));
  const found: { cell: ExpiredCell; refundLock: ccc.Script }[] = [];
  for await (const cell of params.client.findCells(
    {
      script: { codeHash: params.deployment.codeHash, hashType: "data2", args: "0x" },
      scriptType: "lock",
      scriptSearchMode: "prefix",
      withData: false,
    },
    "asc",
  )) {
    if (cell.cellOutput.type) {
      continue; // UDT claim cells need a different refund shape
    }
    let args: ClaimArgs;
    try {
      args = decodeClaimArgs(cell.cellOutput.lock.args);
    } catch {
      continue;
    }
    const refundLock = locks.get(args.refundLockHash);
    if (refundLock && args.expirySeconds <= now) {
      found.push({ cell: { outPoint: cell.outPoint, capacity: cell.cellOutput.capacity, args }, refundLock });
    }
  }
  return found;
}

/** One pass: refund everything that can be refunded now. */
export async function sweepExpiredClaimCells(params: {
  client: ccc.Client;
  deployment: Deployment;
  refundLocks: ccc.ScriptLike[];
  nowSeconds?: bigint;
}): Promise<SweepResult> {
  const result: SweepResult = { refunded: [], immature: [], failed: [] };
  for (const { cell, refundLock } of await findExpiredClaimCells(params)) {
    const tx = buildRefundTx({
      deployment: params.deployment,
      outPoint: cell.outPoint,
      expirySeconds: cell.args.expirySeconds,
      refundLock,
      capacity: cell.capacity,
    });
    try {
      result.refunded.push({ outPoint: cell.outPoint, txHash: await params.client.sendTransaction(tx) });
    } catch (err) {
      const error = String((err as Error).message);
      if (/Immature/i.test(error)) {
        result.immature.push(cell.outPoint);
      } else {
        result.failed.push({ outPoint: cell.outPoint, error });
      }
    }
  }
  return result;
}

export type RelayedClaim = {
  paymentHash: ccc.Hex;
  preimage: ccc.Hex;
  txHash: ccc.Hex;
  blockNumber: bigint;
};

/**
 * Reads claims from the chain, newest first, down to `fromBlock`. Each is a
 * spend of a claim cell that reveals a preimage matching the cell's hash.
 * With `refundLocks`, only cells that refund to one of them are reported.
 */
export async function findClaims(params: {
  client: ccc.Client;
  deployment: Deployment;
  refundLocks?: ccc.ScriptLike[];
  fromBlock?: bigint;
}): Promise<RelayedClaim[]> {
  const { client } = params;
  const mine = params.refundLocks && new Set(params.refundLocks.map((l) => lockHash20(l)));
  const claims: RelayedClaim[] = [];
  const seen = new Set<string>();
  for await (const entry of client.findTransactions(
    {
      script: { codeHash: params.deployment.codeHash, hashType: "data2", args: "0x" },
      scriptType: "lock",
      scriptSearchMode: "prefix",
    },
    "desc",
  )) {
    if (params.fromBlock !== undefined && entry.blockNumber < params.fromBlock) {
      break;
    }
    if (!("isInput" in entry) || !entry.isInput || seen.has(entry.txHash)) {
      continue;
    }
    seen.add(entry.txHash);
    const spending = await client.getTransaction(entry.txHash);
    if (!spending) {
      continue;
    }
    for (const input of spending.transaction.inputs) {
      const spent = await client.getCell(input.previousOutput);
      const lock = spent?.cellOutput.lock;
      if (!lock || lock.codeHash !== params.deployment.codeHash || lock.hashType !== "data2") {
        continue;
      }
      let args: ClaimArgs;
      try {
        args = decodeClaimArgs(lock.args);
      } catch {
        continue;
      }
      if (mine && !mine.has(args.refundLockHash)) {
        continue;
      }
      const preimage = spendOfClaimCell(spending.transaction, input.previousOutput)?.preimage;
      if (preimage && hashPreimage(args.hashAlgorithm, preimage) === args.paymentHash) {
        claims.push({ paymentHash: args.paymentHash, preimage, txHash: entry.txHash, blockNumber: entry.blockNumber });
      }
    }
  }
  return claims;
}

/** Stores a preimage in a Fiber watchtower. Storing it again is harmless. */
export function toWatchtower(url: string, token?: string) {
  return async (claim: RelayedClaim) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "create_preimage",
        params: [{ payment_hash: claim.paymentHash, preimage: claim.preimage }],
      }),
    });
    const body = (await response.json()) as { error?: { message: string } };
    if (body.error) {
      throw new Error(`create_preimage: ${body.error.message}`);
    }
  };
}

/** Settles the held invoice on the LSP's node, if the node is up and still holds it. */
export function toNode(url: string) {
  const fiber = new FiberRpc(url);
  return async (claim: RelayedClaim) => {
    await fiber.settleInvoice(claim.paymentHash, claim.preimage);
  };
}

/**
 * One relay pass: every claim found is offered to every sink. A sink that
 * fails is reported and tried again on the next pass; the others still run.
 */
export async function relayClaims(params: {
  client: ccc.Client;
  deployment: Deployment;
  refundLocks?: ccc.ScriptLike[];
  fromBlock?: bigint;
  sinks: Record<string, (claim: RelayedClaim) => Promise<void>>;
}) {
  const claims = await findClaims(params);
  const delivered: { claim: RelayedClaim; sink: string }[] = [];
  const failed: { claim: RelayedClaim; sink: string; error: string }[] = [];
  for (const claim of claims) {
    for (const [sink, deliver] of Object.entries(params.sinks)) {
      try {
        await deliver(claim);
        delivered.push({ claim, sink });
      } catch (err) {
        failed.push({ claim, sink, error: String((err as Error).message) });
      }
    }
  }
  return { claims, delivered, failed };
}

async function main() {
  const deployment = JSON.parse(readFileSync(process.env.DEPLOYMENT ?? "../e2e/deployment.testnet.json", "utf8")) as Deployment;
  const refundLocks = JSON.parse(process.env.REFUND_LOCKS ?? "[]") as ccc.ScriptLike[];
  if (refundLocks.length === 0) {
    throw new Error("REFUND_LOCKS must list at least one refund lock script");
  }
  const url = process.env.CKB_RPC_URL;
  const client =
    process.env.CKB_NETWORK === "mainnet"
      ? new ccc.ClientPublicMainnet(url ? { url } : undefined)
      : new ccc.ClientPublicTestnet({ url: url ?? "https://testnet.ckb.dev/" });
  const intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 60_000);
  const sinks: Record<string, (claim: RelayedClaim) => Promise<void>> = {};
  if (process.env.WATCHTOWER_RPC_URL) {
    sinks.watchtower = toWatchtower(process.env.WATCHTOWER_RPC_URL, process.env.WATCHTOWER_TOKEN);
  }
  if (process.env.FIBER_RPC_URL) {
    sinks.node = toNode(process.env.FIBER_RPC_URL);
  }
  // Claims older than this cannot matter any more: their incoming payments
  // have long expired. Each pass re-offers everything newer, which is cheap
  // and means a sink that was down misses nothing.
  const lookbackBlocks = BigInt(process.env.RELAY_LOOKBACK_BLOCKS ?? 15 * 24 * 450);
  for (;;) {
    if (Object.keys(sinks).length > 0) {
      try {
        const tip = (await client.getTipHeader()).number;
        const r = await relayClaims({ client, deployment, refundLocks, fromBlock: tip > lookbackBlocks ? tip - lookbackBlocks : 0n, sinks });
        for (const { claim, sink, error } of r.failed) {
          console.error(`relay of ${claim.paymentHash} to ${sink} failed: ${error}`);
        }
      } catch (err) {
        console.error(`relay failed: ${(err as Error).message}`);
      }
    }
    try {
      const r = await sweepExpiredClaimCells({ client, deployment, refundLocks });
      for (const { outPoint, txHash } of r.refunded) {
        console.log(`refunded ${outPoint.txHash}:${outPoint.index} in ${txHash}`);
      }
      for (const { outPoint, error } of r.failed) {
        console.error(`refund of ${outPoint.txHash}:${outPoint.index} failed: ${error}`);
      }
    } catch (err) {
      console.error(`sweep failed: ${(err as Error).message}`);
    }
    if (process.env.WATCH_ONCE === "1") {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
