/**
 * Unit tests for the pure parts of the protocol code: args encoding, cell
 * sizing, transaction builders and secret derivation. They need no network.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ccc } from "../src/ccc.js";
import {
  buildClaimTx,
  buildRefundTx,
  CKB,
  ckbClaimCellCapacity,
  CLAIM_CELL_OCCUPIED,
  decodeClaimArgs,
  encodeClaimArgs,
  FEE_CAP,
  FEE_RESERVE,
  hashPreimage,
  KNOWN_DEPLOYMENTS,
  lockHash20,
  minimalCapacity,
  preimageFromSpendingTx,
  SINCE_ABSOLUTE_TIMESTAMP,
  spendOfClaimCell,
} from "../src/claim.js";
import { deriveAuth, derivePool, receiveSeedMessage, seedFromSignature } from "../src/receiver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const secp = (args: string) =>
  ccc.Script.from({
    codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
    hashType: "type",
    args,
  });
const receiver = secp("0x" + "11".repeat(20));
const refund = secp("0x" + "22".repeat(20));
const deployment = { txHash: ("0x" + "ab".repeat(32)) as ccc.Hex, index: 0, codeHash: ("0x" + "cd".repeat(32)) as ccc.Hex };
const preimage = ("0x" + "07".repeat(32)) as ccc.Hex;

test("the built binary is the deployed binary", { skip: !existsSync(resolve(HERE, "../../build/release/async-claim-lock")) }, () => {
  const binary = readFileSync(resolve(HERE, "../../build/release/async-claim-lock"));
  const deployed = JSON.parse(readFileSync(resolve(HERE, "../../e2e/deployment.testnet.json"), "utf8"));
  assert.equal(ccc.hashCkb(binary), deployed.codeHash);
  assert.deepEqual(KNOWN_DEPLOYMENTS.testnet, { txHash: deployed.txHash, index: deployed.index, codeHash: deployed.codeHash });
});

test("a spend is read the way the lock script reads it", () => {
  const outPoint = { txHash: "0x" + "ee".repeat(32), index: 0 };
  const claim = buildClaimTx({ deployment, outPoint, preimage, receiverLock: receiver, refundLock: refund, receiverCapacity: 200n * CKB, change: 0n });
  const canonical = ccc.bytesFrom(claim.witnesses[0]);
  // Each of these is accepted by the script, which reads only the first 52
  // bytes, and rejected by a strict molecule parser.
  const trailing = Uint8Array.from([...canonical, 1, 2, 3]);
  const wrongTotal = Uint8Array.from(canonical);
  wrongTotal[0] ^= 0xff;
  const wrongLastOffset = Uint8Array.from(canonical);
  wrongLastOffset[12] ^= 0xff;
  for (const witness of [canonical, trailing, wrongTotal, wrongLastOffset]) {
    claim.witnesses[0] = ccc.hexFrom(witness);
    assert.deepEqual(spendOfClaimCell(claim, outPoint), { preimage });
  }
  const refundTx = buildRefundTx({ deployment, outPoint, expirySeconds: 1_800_000_000n, refundLock: refund, capacity: 200n * CKB });
  assert.deepEqual(spendOfClaimCell(refundTx, outPoint), {});
  refundTx.witnesses[0] = ccc.hexFrom(ccc.WitnessArgs.from({ inputType: "0x1234" }).toBytes());
  assert.deepEqual(spendOfClaimCell(refundTx, outPoint), {});
  assert.equal(spendOfClaimCell(claim, { txHash: "0x" + "00".repeat(32), index: 0 }), undefined);
});

test("claim args round-trip and are 89 bytes", () => {
  for (const hashAlgorithm of ["ckb_hash", "sha256"] as const) {
    const args = {
      hashAlgorithm,
      paymentHash: hashPreimage(hashAlgorithm, preimage),
      receiverLockHash: lockHash20(receiver),
      refundLockHash: lockHash20(refund),
      expirySeconds: 1_800_000_000n,
      receiverCapacity: 100n * CKB,
    };
    const encoded = encodeClaimArgs(args);
    assert.equal(ccc.bytesFrom(encoded).length, 89);
    assert.deepEqual(decodeClaimArgs(encoded), args);
  }
});

test("the two hash algorithms differ and match known vectors", () => {
  // sha256 of 32 zero bytes
  assert.equal(
    hashPreimage("sha256", "0x" + "00".repeat(32)),
    "0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
  );
  assert.notEqual(hashPreimage("ckb_hash", preimage), hashPreimage("sha256", preimage));
});

test("decoding rejects malformed args", () => {
  const good = ccc.bytesFrom(
    encodeClaimArgs({
      hashAlgorithm: "ckb_hash",
      paymentHash: hashPreimage("ckb_hash", preimage),
      receiverLockHash: lockHash20(receiver),
      refundLockHash: lockHash20(refund),
      expirySeconds: 1_800_000_000n,
      receiverCapacity: 100n * CKB,
    }),
  );
  assert.throws(() => decodeClaimArgs(good.slice(0, 88)), /89 bytes/);
  const reserved = Uint8Array.from(good);
  reserved[0] = 2;
  assert.throws(() => decodeClaimArgs(reserved), /reserved/);
  const noFlag = Uint8Array.from(good);
  noFlag[80] = 0; // clear the absolute-timestamp marker in the top byte of expiry
  assert.throws(() => decodeClaimArgs(noFlag), /absolute timestamp/);
});

test("a claim cell is sized so that every output it must produce can exist", () => {
  assert.equal(CLAIM_CELL_OCCUPIED, 130n * CKB);
  assert.equal(minimalCapacity(refund), 61n * CKB);
  const cases: [bigint, bigint][] = [
    [61n, 69n], // shortfall 69 > 61
    [100n, 61n], // shortfall 30, raised to the refund cell's minimum
    [129n, 61n],
    [130n, 0n],
    [500n, 0n],
  ];
  for (const [receiverCkb, changeCkb] of cases) {
    const { capacity, change } = ckbClaimCellCapacity(receiverCkb * CKB, refund);
    assert.equal(change, changeCkb * CKB, `change for ${receiverCkb} CKB`);
    assert.equal(capacity, receiverCkb * CKB + change + FEE_RESERVE);
    assert.ok(capacity >= CLAIM_CELL_OCCUPIED, "the claim cell itself must be able to exist");
    assert.ok(change === 0n || change >= minimalCapacity(refund), "change must be able to form a cell");
  }
  assert.ok(FEE_RESERVE <= FEE_CAP, "the reserve must fit under the script's fee cap");
});

test("the claim transaction pays the receiver, returns change, and carries the preimage", () => {
  const outPoint = { txHash: "0x" + "ee".repeat(32), index: 3 };
  const tx = buildClaimTx({
    deployment,
    outPoint,
    preimage,
    receiverLock: receiver,
    refundLock: refund,
    receiverCapacity: 100n * CKB,
    change: 61n * CKB,
  });
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.inputs[0].since, 0n);
  assert.equal(tx.outputs.length, 2);
  assert.ok(tx.outputs[0].lock.eq(receiver));
  assert.equal(tx.outputs[0].capacity, 100n * CKB);
  assert.ok(tx.outputs[1].lock.eq(refund));
  assert.equal(tx.outputs[1].capacity, 61n * CKB);
  assert.equal(preimageFromSpendingTx(tx, outPoint), preimage);

  const noChange = buildClaimTx({ deployment, outPoint, preimage, receiverLock: receiver, refundLock: refund, receiverCapacity: 200n * CKB, change: 0n });
  assert.equal(noChange.outputs.length, 1);
});

test("the refund transaction is time-locked and reveals no preimage", () => {
  const outPoint = { txHash: "0x" + "ee".repeat(32), index: 0 };
  const tx = buildRefundTx({ deployment, outPoint, expirySeconds: 1_800_000_000n, refundLock: refund, capacity: 161n * CKB + FEE_RESERVE });
  assert.equal(tx.inputs[0].since, SINCE_ABSOLUTE_TIMESTAMP | 1_800_000_000n);
  assert.ok(tx.outputs[0].lock.eq(refund));
  assert.ok(tx.outputs[0].capacity >= 161n * CKB + FEE_RESERVE - FEE_CAP, "must satisfy the script's refund minimum");
  assert.equal(preimageFromSpendingTx(tx, outPoint), undefined);
  assert.throws(() => preimageFromSpendingTx(tx, { txHash: "0x" + "00".repeat(32), index: 0 }), /does not spend/);
});

test("secrets derived from a signature are stable, distinct, and bound to the address", () => {
  const seed = seedFromSignature("0xsignature-a");
  assert.equal(seed, seedFromSignature("0xsignature-a"));
  assert.notEqual(seed, seedFromSignature("0xsignature-b"));

  const first = derivePool(seed, "lsp-a", 0, 8, "ckb_hash");
  assert.deepEqual(derivePool(seed, "lsp-a", 0, 8, "ckb_hash"), first);
  assert.deepEqual(derivePool(seed, "lsp-a", 4, 4, "ckb_hash"), first.slice(4), "an index always yields the same entry");
  const elsewhere = derivePool(seed, "lsp-b", 0, 8, "ckb_hash");
  assert.ok(!elsewhere.some((e) => first.some((f) => f.hash === e.hash)), "no hash is shared between two LSPs");
  assert.equal(new Set(first.map((e) => e.preimage)).size, 8);
  for (const entry of first) {
    assert.equal(hashPreimage("ckb_hash", entry.preimage), entry.hash);
  }
  assert.notDeepEqual(derivePool(seedFromSignature("0xsignature-b"), "lsp-a", 0, 1, "ckb_hash"), first.slice(0, 1));

  const auth = deriveAuth(seed, "lsp-a");
  assert.deepEqual(deriveAuth(seed, "lsp-a"), auth);
  assert.notEqual(deriveAuth(seed, "lsp-b").token, auth.token, "a token is only good at one LSP");
  assert.ok(!first.some((e) => e.preimage.slice(2) === auth.token), "the token must not be a preimage");

  assert.notEqual(receiveSeedMessage(receiver), receiveSeedMessage(refund));
  assert.ok(receiveSeedMessage(receiver).includes(receiver.hash()));
});
