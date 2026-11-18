/**
 * Claim cells: encoding of the async-claim-lock args and construction of the
 * three transactions that touch a claim cell (create, claim, refund).
 *
 * Mirrors contracts/async-claim-lock; see rfcs/0001-async-receive.md.
 */
import { ccc } from "@ckb-ccc/core";
import { sha256 } from "@noble/hashes/sha2.js";
import type { HashAlgorithm } from "./fiber.js";

export const CKB = 100_000_000n;
/** Most a claim or refund may take from the cell as fee (script constant). */
export const FEE_CAP = 1_000_000n;
/** What the LSP leaves in the cell so a claim needs no other input. */
export const FEE_RESERVE = 100_000n;
export const SINCE_ABSOLUTE_TIMESTAMP = 0x4000_0000_0000_0000n;
const ARGS_LEN = 89;

export type Deployment = { txHash: ccc.Hex; index: number; codeHash: ccc.Hex };

/**
 * Where the lock script lives on each public network. A receiver uses these
 * rather than whatever an LSP names: a look-alike script could hand the cell
 * to someone else once the preimage is public.
 */
export const KNOWN_DEPLOYMENTS: { mainnet?: Deployment; testnet?: Deployment } = {
  testnet: {
    txHash: "0xb367c3c1a9b840df3c4ea5838ec2190a1a6a16f61da9961912c38d5dd520e186",
    index: 0,
    codeHash: "0x8db24f4dc53d59e572397ee60c9fb1783f7a15cb22908b85ce329edca71de623",
  },
};

export type ClaimArgs = {
  hashAlgorithm: HashAlgorithm;
  paymentHash: ccc.Hex;
  /** First 20 bytes of the receiver lock script hash. */
  receiverLockHash: ccc.Hex;
  /** First 20 bytes of the LSP refund lock script hash. */
  refundLockHash: ccc.Hex;
  /** Refund becomes valid at this UNIX time, in seconds. */
  expirySeconds: bigint;
  receiverCapacity: bigint;
};

export function hashPreimage(algorithm: HashAlgorithm, preimage: ccc.BytesLike): ccc.Hex {
  return algorithm === "sha256"
    ? ccc.hexFrom(sha256(ccc.bytesFrom(preimage)))
    : ccc.hashCkb(preimage);
}

export function lockHash20(script: ccc.ScriptLike): ccc.Hex {
  return ccc.hexFrom(ccc.bytesFrom(ccc.Script.from(script).hash()).slice(0, 20));
}

export function encodeClaimArgs(args: ClaimArgs): ccc.Hex {
  return ccc.hexFrom(
    ccc.bytesConcat(
      [args.hashAlgorithm === "sha256" ? 1 : 0],
      args.paymentHash,
      args.receiverLockHash,
      args.refundLockHash,
      ccc.numLeToBytes(SINCE_ABSOLUTE_TIMESTAMP | args.expirySeconds, 8),
      ccc.numLeToBytes(args.receiverCapacity, 8),
    ),
  );
}

export function decodeClaimArgs(hex: ccc.HexLike): ClaimArgs {
  const raw = ccc.bytesFrom(hex);
  if (raw.length !== ARGS_LEN) {
    throw new Error(`claim args must be ${ARGS_LEN} bytes, got ${raw.length}`);
  }
  if ((raw[0] & 0xfe) !== 0) {
    throw new Error("claim args: reserved flag bits set");
  }
  const expiry = ccc.numLeFromBytes(raw.slice(73, 81));
  if ((expiry & 0xff00_0000_0000_0000n) !== SINCE_ABSOLUTE_TIMESTAMP) {
    throw new Error("claim args: expiry is not an absolute timestamp");
  }
  return {
    hashAlgorithm: raw[0] === 1 ? "sha256" : "ckb_hash",
    paymentHash: ccc.hexFrom(raw.slice(1, 33)),
    receiverLockHash: ccc.hexFrom(raw.slice(33, 53)),
    refundLockHash: ccc.hexFrom(raw.slice(53, 73)),
    expirySeconds: expiry & 0x00ff_ffff_ffff_ffffn,
    receiverCapacity: ccc.numLeFromBytes(raw.slice(81, 89)),
  };
}

export function claimLock(deployment: Deployment, args: ClaimArgs): ccc.Script {
  return ccc.Script.from({
    codeHash: deployment.codeHash,
    hashType: "data2",
    args: encodeClaimArgs(args),
  });
}

export function lockDep(deployment: Deployment): ccc.CellDep {
  return ccc.CellDep.from({
    outPoint: { txHash: deployment.txHash, index: deployment.index },
    depType: "code",
  });
}

/** Smallest capacity a cell with this lock and no type script or data can have. */
export function minimalCapacity(lock: ccc.ScriptLike): bigint {
  const script = ccc.Script.from(lock);
  return BigInt(8 + 32 + 1 + ccc.bytesFrom(script.args).length) * CKB;
}

/** Occupied capacity of a claim cell that carries plain CKB: 130 CKB. */
export const CLAIM_CELL_OCCUPIED = BigInt(8 + 32 + 1 + ARGS_LEN) * CKB;

/**
 * Sizes a CKB claim cell. The receiver gets `receiverCapacity`; whatever the
 * cell needs beyond that to exist is the LSP's change, which must itself be
 * large enough to form a cell under `refundLock`.
 */
export function ckbClaimCellCapacity(receiverCapacity: bigint, refundLock: ccc.ScriptLike) {
  const shortfall =
    receiverCapacity >= CLAIM_CELL_OCCUPIED ? 0n : CLAIM_CELL_OCCUPIED - receiverCapacity;
  const refundMinimum = minimalCapacity(refundLock);
  const change = shortfall === 0n ? 0n : shortfall > refundMinimum ? shortfall : refundMinimum;
  return { capacity: receiverCapacity + change + FEE_RESERVE, change };
}

/**
 * The claim transaction: one input, no signature. Output 0 pays the receiver,
 * output 1 returns the LSP's change; the fee comes out of the cell itself.
 */
export function buildClaimTx(params: {
  deployment: Deployment;
  outPoint: ccc.OutPointLike;
  preimage: ccc.Hex;
  receiverLock: ccc.ScriptLike;
  refundLock: ccc.ScriptLike;
  receiverCapacity: bigint;
  change: bigint;
}): ccc.Transaction {
  const outputs = [{ lock: params.receiverLock, capacity: params.receiverCapacity }];
  if (params.change > 0n) {
    outputs.push({ lock: params.refundLock, capacity: params.change });
  }
  return ccc.Transaction.from({
    cellDeps: [lockDep(params.deployment)],
    inputs: [{ previousOutput: params.outPoint, since: 0n }],
    outputs,
    outputsData: outputs.map(() => "0x"),
    witnesses: [ccc.hexFrom(ccc.WitnessArgs.from({ lock: params.preimage }).toBytes())],
  });
}

/** The refund transaction: one input, no signature, valid from `expirySeconds`. */
export function buildRefundTx(params: {
  deployment: Deployment;
  outPoint: ccc.OutPointLike;
  expirySeconds: bigint;
  refundLock: ccc.ScriptLike;
  capacity: bigint;
}): ccc.Transaction {
  return ccc.Transaction.from({
    cellDeps: [lockDep(params.deployment)],
    inputs: [
      {
        previousOutput: params.outPoint,
        since: SINCE_ABSOLUTE_TIMESTAMP | params.expirySeconds,
      },
    ],
    outputs: [{ lock: params.refundLock, capacity: params.capacity - FEE_RESERVE }],
    outputsData: ["0x"],
    witnesses: ["0x"],
  });
}

/**
 * How a transaction spent a claim cell: `undefined` if it does not spend that
 * cell at all, otherwise the preimage it revealed, or no preimage for a refund.
 *
 * The witness is read byte for byte the way the lock script reads it, not
 * with a strict molecule parser. The script looks only at the first 52 bytes,
 * so a claim may carry a witness a strict parser rejects; if this function
 * disagreed with the script, such a claim would pay the receiver without the
 * LSP ever seeing the preimage.
 */
export function spendOfClaimCell(
  tx: ccc.Transaction,
  outPoint: ccc.OutPointLike,
): { preimage?: ccc.Hex } | undefined {
  const target = ccc.OutPoint.from(outPoint);
  const index = tx.inputs.findIndex((input) => input.previousOutput.eq(target));
  if (index < 0) {
    return undefined;
  }
  const witness = ccc.bytesFrom(tx.witnesses[index] ?? "0x");
  const u32 = (offset: number) =>
    witness[offset] | (witness[offset + 1] << 8) | (witness[offset + 2] << 16) | (witness[offset + 3] << 24);
  // WitnessArgs header (16 bytes), then the lock field: length 32, 32 bytes.
  if (witness.length >= 52 && u32(4) === 16 && u32(8) - 16 === 36 && u32(16) === 32) {
    return { preimage: ccc.hexFrom(witness.slice(20, 52)) };
  }
  return {};
}

/** The preimage a spend of the claim cell revealed; undefined for a refund. */
export function preimageFromSpendingTx(
  tx: ccc.Transaction,
  outPoint: ccc.OutPointLike,
): ccc.Hex | undefined {
  const how = spendOfClaimCell(tx, outPoint);
  if (how === undefined) {
    throw new Error("transaction does not spend the claim cell");
  }
  return how.preimage;
}
