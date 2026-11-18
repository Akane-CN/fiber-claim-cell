/**
 * The receiver side of RFC 0001: generating the hash pool, and — for path B —
 * verifying a claim cell against the chain before revealing the preimage.
 *
 * Nothing here trusts what the LSP says about a claim cell. Every value used
 * to decide whether to claim is read back from the chain.
 */
import { ccc } from "@ckb-ccc/core";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildClaimTx,
  CKB,
  type ClaimArgs,
  decodeClaimArgs,
  type Deployment,
  FEE_CAP,
  FEE_RESERVE,
  hashPreimage,
  lockHash20,
  minimalCapacity,
} from "./claim.js";
import type { HashAlgorithm } from "./fiber.js";

/** The smallest cell any standard lock can hold; a lower bound on the LSP's change. */
const MIN_CHANGE = 61n * CKB;
/** Enough for a claim transaction at the network's minimum fee rate. */
const MIN_FEE = 1000n;

export type PoolEntry = { preimage: ccc.Hex; hash: ccc.Hex };

/** Fresh random preimages; they never leave the receiver. */
export function createHashPool(size: number, algorithm: HashAlgorithm): PoolEntry[] {
  return Array.from({ length: size }, () => {
    const preimage = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)));
    return { preimage, hash: hashPreimage(algorithm, preimage) };
  });
}

const text = (s: string) => new TextEncoder().encode(s);

/**
 * The message a wallet signs to derive the receive seed. It names the purpose
 * and the receiving lock, so a signature made for anything else, or for another
 * address, never yields this seed.
 */
export function receiveSeedMessage(receiverLock: ccc.ScriptLike): string {
  return [
    "Fiber Claim Cell: receive key v1",
    "Signing this lets this page claim payments sent to you.",
    "Only sign it on a page you trust: whoever holds this signature can",
    "release your pending payments, though only ever to your own address",
    "or the Fiber node you registered.",
    `Lock: ${ccc.Script.from(receiverLock).hash()}`,
  ].join("\n");
}

/** Turns the wallet's signature over receiveSeedMessage into the 32-byte seed. */
export function seedFromSignature(signature: string): ccc.Hex {
  return ccc.hexFrom(sha256(text(`fiber-claim-cell/seed/v1:${signature}`)));
}

/**
 * Derives pool entries from the seed instead of drawing them at random, so the
 * same wallet reproduces them on another device with nothing to back up. The
 * LSP sees only the hashes and cannot run this without the seed.
 *
 * `scope` names the LSP (its node public key). Every LSP gets its own hashes:
 * a preimage revealed by a claim at one LSP must not open a payment that is
 * waiting at another.
 */
export function derivePool(
  seed: ccc.HexLike,
  scope: string,
  start: number,
  count: number,
  algorithm: HashAlgorithm,
): PoolEntry[] {
  const key = ccc.bytesFrom(seed);
  return Array.from({ length: count }, (_, i) => {
    const preimage = ccc.hexFrom(hmac(sha256, key, text(`preimage/${scope}/${start + i}`)));
    return { preimage, hash: hashPreimage(algorithm, preimage) };
  });
}

/**
 * The bearer token the receiver presents to the LSP, and the hash of it that
 * the LSP stores at registration. Derived from the seed, so it too survives a
 * change of device, and per LSP (`scope`), so a token shown to one LSP is of
 * no use at another.
 */
export function deriveAuth(seed: ccc.HexLike, scope: string): { token: string; authHash: ccc.Hex } {
  const token = ccc.hexFrom(hmac(sha256, ccc.bytesFrom(seed), text(`auth/${scope}`))).slice(2);
  return { token, authHash: ccc.hexFrom(sha256(text(token))) };
}

export class ClaimCellRejected extends Error {}

export type VerifiedClaimCell = {
  outPoint: ccc.OutPointLike;
  args: ClaimArgs;
  capacity: bigint;
  confirmations: bigint;
};

/**
 * Applies the receiver's client rules to a claim cell. Throws
 * ClaimCellRejected unless it is safe to broadcast a claim for it now.
 */
export async function verifyClaimCell(params: {
  client: ccc.Client;
  /** The lock deployment the receiver recorded at registration. */
  deployment: Deployment;
  outPoint: ccc.OutPointLike;
  entry: PoolEntry;
  hashAlgorithm: HashAlgorithm;
  receiverLock: ccc.ScriptLike;
  /** The least the receiver agreed to be paid on chain. */
  minReceiverCapacity: bigint;
  /** N_conf. */
  minConfirmations: bigint;
  /** Δ_margin, in seconds. */
  marginSeconds: bigint;
}): Promise<VerifiedClaimCell> {
  const { client } = params;
  const outPoint = ccc.OutPoint.from(params.outPoint);
  // Confirmed cells only: a cell that is merely in the pool can still vanish.
  const cell = await client.getCellLive(outPoint, false, false);
  if (!cell) {
    throw new ClaimCellRejected("claim cell is not live on chain");
  }
  const lock = cell.cellOutput.lock;
  if (lock.codeHash !== params.deployment.codeHash || lock.hashType !== "data2") {
    throw new ClaimCellRejected("cell is not guarded by the expected claim lock");
  }
  if (cell.cellOutput.type) {
    throw new ClaimCellRejected("unexpected type script on a CKB claim cell");
  }
  let args: ClaimArgs;
  try {
    args = decodeClaimArgs(lock.args);
  } catch (err) {
    throw new ClaimCellRejected(`malformed claim args: ${(err as Error).message}`);
  }
  if (args.hashAlgorithm !== params.hashAlgorithm || args.paymentHash !== params.entry.hash) {
    throw new ClaimCellRejected("claim cell is for a different payment hash");
  }
  if (hashPreimage(args.hashAlgorithm, params.entry.preimage) !== args.paymentHash) {
    throw new ClaimCellRejected("own preimage does not match the payment hash");
  }
  if (args.receiverLockHash !== lockHash20(params.receiverLock)) {
    throw new ClaimCellRejected("claim cell pays a different lock");
  }
  if (args.receiverCapacity < params.minReceiverCapacity) {
    throw new ClaimCellRejected(
      `claim cell pays ${args.receiverCapacity}, expected at least ${params.minReceiverCapacity}`,
    );
  }
  const capacity = cell.cellOutput.capacity;
  if (capacity < args.receiverCapacity) {
    throw new ClaimCellRejected("claim cell holds less than it promises");
  }
  // The claim must create a cell of exactly this capacity under the
  // receiver's lock. If that is less than such a cell needs to exist, no claim
  // can ever be valid, and revealing the preimage would give it away.
  if (args.receiverCapacity < minimalCapacity(params.receiverLock)) {
    throw new ClaimCellRejected("claim cell pays too little to form a cell under the receiver's lock");
  }
  // Likewise the LSP's change, when there is any, must be able to form a cell.
  const surplus = capacity - args.receiverCapacity;
  if (surplus > FEE_CAP && surplus - FEE_RESERVE < MIN_CHANGE) {
    throw new ClaimCellRejected("claim cell leaves change too small to form a cell");
  }
  // The claim's fee can only come out of the cell.
  if (surplus < MIN_FEE) {
    throw new ClaimCellRejected("claim cell leaves nothing to pay the claim's fee with");
  }

  const creation = await client.getTransaction(outPoint.txHash);
  const tip = await client.getTipHeader();
  if (!creation || creation.blockNumber === undefined || creation.blockNumber === null) {
    throw new ClaimCellRejected("claim cell transaction is not in a block");
  }
  const confirmations = tip.number - creation.blockNumber + 1n;
  if (confirmations < params.minConfirmations) {
    throw new ClaimCellRejected(
      `claim cell has ${confirmations} confirmations, need ${params.minConfirmations}`,
    );
  }
  // The later of the wall clock and the newest block: the chain's median time
  // runs behind and so may this device's clock, and behind is the unsafe
  // direction here.
  const wallSeconds = BigInt(Math.floor(Date.now() / 1000));
  const tipSeconds = tip.timestamp / 1000n;
  const nowSeconds = wallSeconds > tipSeconds ? wallSeconds : tipSeconds;
  if (nowSeconds + params.marginSeconds > args.expirySeconds) {
    throw new ClaimCellRejected("too close to the claim cell's expiry to claim safely");
  }
  return { outPoint, args, capacity, confirmations };
}

/**
 * Builds the claim for a verified cell. The change and fee are derived from
 * the cell as it is on chain, not from anything the LSP reported.
 */
export function buildClaimForVerifiedCell(params: {
  deployment: Deployment;
  cell: VerifiedClaimCell;
  preimage: ccc.Hex;
  receiverLock: ccc.ScriptLike;
  /** The LSP's refund lock, needed in full to build the change output. */
  refundLock: ccc.ScriptLike;
}): ccc.Transaction {
  const { cell } = params;
  if (lockHash20(params.refundLock) !== cell.args.refundLockHash) {
    throw new ClaimCellRejected("refund lock does not match the claim cell");
  }
  const surplus = cell.capacity - cell.args.receiverCapacity;
  return buildClaimTx({
    deployment: params.deployment,
    outPoint: cell.outPoint,
    preimage: params.preimage,
    receiverLock: params.receiverLock,
    refundLock: params.refundLock,
    receiverCapacity: cell.args.receiverCapacity,
    change: surplus > FEE_CAP ? surplus - FEE_RESERVE : 0n,
  });
}
