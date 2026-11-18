/**
 * The LSP side of RFC 0001: hash-pool registration, hold-invoice issuance, and
 * the per-payment state machine that drives a held payment down path A
 * (forward over a channel) or path B (claim cell on L1).
 *
 * This is a prototype. It handles CKB payments only and keeps its state in one
 * JSON file.
 *
 * Two rules keep the LSP from paying twice for one incoming payment:
 *   - a payment is only ever worked on by one caller at a time (`busy`), so
 *     path A and path B cannot both start for the same hash;
 *   - the signed claim-cell transaction is written to disk before it is
 *     broadcast, so after a crash the same transaction is sent again instead
 *     of a second one being built.
 */
import { ccc } from "@ckb-ccc/core";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  buildRefundTx,
  ckbClaimCellCapacity,
  claimLock,
  type ClaimArgs,
  type Deployment,
  encodeClaimArgs,
  hashPreimage,
  lockHash20,
  minimalCapacity,
  spendOfClaimCell,
} from "./claim.js";
import { type FiberRpc, type HashAlgorithm, type Hex } from "./fiber.js";

export type PaymentState =
  | "OPEN"
  | "HELD"
  | "FORWARDING"
  | "CELL_PENDING"
  | "CELL_LIVE"
  | "CLAIMED"
  | "REFUNDING"
  | "SETTLED"
  | "FAILED";

const FINAL_STATES: PaymentState[] = ["SETTLED", "FAILED"];
/** States in which the LSP's own CKB is committed to a claim cell. */
const EXPOSED_STATES: PaymentState[] = ["CELL_PENDING", "CELL_LIVE", "REFUNDING", "CLAIMED"];

export type Fee = { base: bigint; ppm: bigint };

export type LspConfig = {
  fiber: FiberRpc;
  client: ccc.Client;
  /** L1 signer that funds claim cells and receives refunds and change. */
  signer: ccc.Signer;
  deployment: Deployment;
  statePath: string;
  /** Fiber invoice currency: "Fibb" mainnet, "Fibt" testnet, "Fibd" devnet. */
  currency: string;
  feePathA: Fee;
  feePathB: Fee;
  /** final_expiry_delta of issued invoices (D_final). */
  dFinalMs: bigint;
  /** Fiber's minimum final expiry delta (D_min). */
  dMinMs: bigint;
  /** Random offset send_payment adds to an outgoing TLC, lower bound (D_rand). */
  dRandMs: bigint;
  /** Our forwarding expiry delta (D_fwd). */
  dFwdMs: bigint;
  /** Gap between claim-cell expiry and incoming TLC expiry (Δ_settle). */
  deltaSettleMs: bigint;
  /** How long to wait for the receiver before going on chain (T_wake). */
  tWakeMs: bigint;
  /** Shortest claim window worth opening (W_min). */
  wMinMs: bigint;
  /** How early before expiry the receiver must stop claiming (Δ_margin). */
  deltaMarginMs: bigint;
  /** Confirmations a receiver should wait for before claiming (N_conf). */
  minConfirmations?: number;
  /**
   * Most CKB the LSP will have out in claim cells at once, in shannons. While
   * a new cell would go over it, the payment waits; if room does not appear in
   * time, the payment is returned to the payer.
   */
  maxExposure?: bigint;
  /** The same limit for a single receiver. */
  maxExposurePerReceiver?: bigint;
  /**
   * The same limit for payments that came in through one peer. A receiver id
   * costs nothing to make, so the per-receiver limit does not stop one party
   * registering many. Every payment has to come in through one of the LSP's
   * own channels, though, and those cannot be multiplied at will.
   */
  maxExposurePerPeer?: bigint;
  /** Most claim cells alive at once, in total and for one receiver. */
  maxCells?: number;
  maxCellsPerReceiver?: number;
  /**
   * Smallest net amount worth a claim cell. Each cell ties up at least 130 CKB
   * of the LSP's and costs two transaction fees whether or not it is claimed.
   */
  minPathBAmount?: bigint;
  /**
   * Checks run before every new claim cell; each throws when what it watches
   * is not well. A claim cell is only safe to open while the things that
   * collect the incoming payment afterwards are up: the node, the watchtower,
   * the preimage relay. While any check fails no new cell is opened.
   */
  healthChecks?: (() => Promise<void>)[];
  /** Confirmations a refund needs before the incoming payment is released. Default 6. */
  refundConfirmations?: number;
  /** Unpaid invoices one receiver may have outstanding. Default 32. */
  maxOpenInvoicesPerReceiver?: number;
  /** Unused hashes one receiver may have registered. Default 256. */
  maxFreeHashesPerReceiver?: number;
  /** How long an unpaid invoice stays payable. */
  invoiceExpirySeconds: bigint;
  /** Delivers the wake-up push. Must not carry payment details. */
  wake: (endpoint: string) => Promise<void>;
  /**
   * TEST ONLY. Makes claim cells expire this many seconds after creation
   * instead of at E_in − Δ_settle, so the refund path can be exercised without
   * waiting hours. An earlier expiry is always safe for the LSP.
   */
  testClaimExpirySeconds?: bigint;
  log?: (message: string) => void;
};

type ReceiverRecord = {
  id: string;
  /** Random bearer token, for receivers registered without an auth hash. */
  token: string;
  /** sha256 of the receiver's own bearer token, when it supplied one. */
  authHash?: Hex;
  lock: { codeHash: Hex; hashType: string; args: Hex };
  nodePubkey?: string;
  wakeEndpoint?: string;
  hashAlgorithm: HashAlgorithm;
  hashes: Record<Hex, "free" | "used">;
};

type CellRecord = {
  txHash: Hex;
  index: number;
  args: Hex;
  capacity: string;
  receiverCapacity: string;
  change: string;
  expirySeconds: string;
  /** The signed creation transaction, kept so that it can be sent again. */
  signedTx?: Hex;
};

type PaymentRecord = {
  paymentHash: Hex;
  receiverId: string;
  amount: string;
  invoice: string;
  state: PaymentState;
  createdAtMs: number;
  /** The last time the invoice was seen still unpaid. The TLC arrived later. */
  lastUnpaidAtMs?: number;
  /** When the incoming TLC was first seen. */
  heldAtMs?: number;
  /** The peer the incoming TLC came through. */
  upstreamPeer?: string;
  /**
   * When the incoming TLC expires, read from the node. If the node did not
   * report it, a lower bound: (last seen unpaid) + D_final.
   */
  eInMs?: number;
  outgoingInvoice?: string;
  cell?: CellRecord;
  refundTxHash?: Hex;
  preimage?: Hex;
  settleCalled?: boolean;
  note?: string;
  history: { atMs: number; state: PaymentState; note?: string }[];
};

type State = {
  receivers: Record<string, ReceiverRecord>;
  payments: Record<Hex, PaymentRecord>;
};

export type PendingPayment = {
  paymentHash: Hex;
  amount: string;
  state: PaymentState;
  /** What path A would deliver. */
  netPathA: string;
  eInMs?: number;
  cell?: CellRecord;
};

export class LspError extends Error {}

const ID_HEX_LEN = 32;
const MAX_HASHES_PER_CALL = 64;

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const applyFee = (amount: bigint, fee: Fee) => amount - fee.base - (amount * fee.ppm) / 1_000_000n;

export class AsyncReceiveLsp {
  private state: State = { receivers: {}, payments: {} };
  private refundLock!: ccc.Script;
  private ticking = false;
  /** Payments some caller is working on right now. */
  private busy = new Set<Hex>();
  /** Every registered hash → its receiver, for the single-use check. */
  private hashOwner = new Map<string, string>();

  constructor(private readonly config: LspConfig) {
    if (existsSync(config.statePath)) {
      this.state = JSON.parse(readFileSync(config.statePath, "utf8")) as State;
    }
    for (const receiver of Object.values(this.state.receivers)) {
      for (const hash of Object.keys(receiver.hashes)) {
        this.hashOwner.set(hash, receiver.id);
      }
    }
  }

  async init() {
    this.refundLock = (await this.config.signer.getRecommendedAddressObj()).script;
  }

  private log(message: string) {
    this.config.log?.(message);
  }

  private persist() {
    const tmp = `${this.config.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.config.statePath);
  }

  private move(payment: PaymentRecord, state: PaymentState, note?: string) {
    payment.state = state;
    payment.note = note;
    payment.history.push({ atMs: Date.now(), state, note });
    this.persist();
    this.log(`${payment.paymentHash.slice(0, 10)}… → ${state}${note ? ` (${note})` : ""}`);
  }

  // ------------------------------------------------------------ public API

  async getInfo() {
    const c = this.config;
    return {
      claimLock: { ...c.deployment, hashType: "data2" },
      refundLock: {
        codeHash: this.refundLock.codeHash,
        hashType: this.refundLock.hashType,
        args: this.refundLock.args,
      },
      refundLockHash: lockHash20(this.refundLock),
      currency: c.currency,
      network: c.currency === "Fibb" ? "mainnet" : c.currency === "Fibt" ? "testnet" : "devnet",
      feePathA: { base: c.feePathA.base.toString(), ppm: c.feePathA.ppm.toString() },
      feePathB: { base: c.feePathB.base.toString(), ppm: c.feePathB.ppm.toString() },
      dFinalMs: c.dFinalMs.toString(),
      deltaSettleMs: c.deltaSettleMs.toString(),
      tWakeMs: c.tWakeMs.toString(),
      deltaMarginMs: c.deltaMarginMs.toString(),
      minConfirmations: c.minConfirmations ?? 24,
      nodePubkey: (await c.fiber.nodeInfo()).pubkey,
    };
  }

  register(params: {
    lock: ccc.ScriptLike;
    nodePubkey?: string;
    wakeEndpoint?: string;
    hashAlgorithm: HashAlgorithm;
    hashes: Hex[];
    /**
     * sha256 of a bearer token the receiver derives itself. With it the
     * receiver id is a function of (lock, authHash), so registering again from
     * another device lands on the same record instead of creating a new one.
     */
    authHash?: Hex;
  }) {
    const lock = ccc.Script.from(params.lock);
    if (params.hashAlgorithm !== "ckb_hash" && params.hashAlgorithm !== "sha256") {
      throw new LspError("hash_algorithm must be ckb_hash or sha256");
    }
    if (params.authHash !== undefined && !/^0x[0-9a-f]{64}$/.test(params.authHash)) {
      throw new LspError("auth_hash must be 32 bytes of lower-case hex");
    }
    if (params.nodePubkey !== undefined && !/^[0-9a-f]{66}$/.test(params.nodePubkey)) {
      throw new LspError("node_pubkey must be a 33-byte compressed public key in hex");
    }
    const id = params.authHash
      ? createHash("sha256").update(lock.hash()).update(params.authHash).digest("hex").slice(0, ID_HEX_LEN)
      : ccc.hexFrom(randomBytes(ID_HEX_LEN / 2)).slice(2);
    const existing = this.state.receivers[id];
    if (existing) {
      // Registering again only tells the caller where it stands. Adding
      // hashes to an existing record needs the token (add_hashes): otherwise
      // anyone who saw the first registration could fill the pool with hashes
      // the receiver cannot open.
      return { receiverId: id, token: "", registered: Object.keys(existing.hashes).length };
    }
    this.checkNewHashes(undefined, params.hashes);
    const receiver: ReceiverRecord = {
      id,
      token: params.authHash ? "" : ccc.hexFrom(randomBytes(24)).slice(2),
      authHash: params.authHash,
      lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args },
      nodePubkey: params.nodePubkey,
      wakeEndpoint: params.wakeEndpoint,
      hashAlgorithm: params.hashAlgorithm,
      hashes: {},
    };
    this.state.receivers[receiver.id] = receiver;
    this.addHashesTo(receiver, params.hashes);
    return {
      receiverId: receiver.id,
      token: receiver.token,
      registered: Object.keys(receiver.hashes).length,
    };
  }

  addHashes(receiverId: string, token: string, hashes: Hex[]) {
    const receiver = this.authenticate(receiverId, token);
    this.addHashesTo(receiver, hashes);
    return {
      free: this.freeHashes(receiverId),
      registered: Object.keys(receiver.hashes).length,
    };
  }

  /** Validates a batch of hashes in full before any of it is stored. */
  private checkNewHashes(receiver: ReceiverRecord | undefined, hashes: Hex[]) {
    if (!Array.isArray(hashes) || hashes.length > MAX_HASHES_PER_CALL) {
      throw new LspError(`at most ${MAX_HASHES_PER_CALL} hashes per call`);
    }
    const fresh = new Set<string>();
    for (const hash of hashes) {
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash)) {
        throw new LspError("payment hash must be 32 bytes of lower-case hex");
      }
      if (receiver?.hashes[hash] !== undefined) {
        continue; // registering the same hash again is a no-op
      }
      // A hash is single use across the whole LSP, not just per receiver.
      if (this.hashOwner.has(hash) || this.state.payments[hash]) {
        throw new LspError(`payment hash already registered: ${hash}`);
      }
      fresh.add(hash);
    }
    const free = receiver ? this.freeHashes(receiver.id) : 0;
    const limit = this.config.maxFreeHashesPerReceiver ?? 256;
    if (free + fresh.size > limit) {
      throw new LspError(`a receiver may hold at most ${limit} unused hashes`);
    }
  }

  private addHashesTo(receiver: ReceiverRecord, hashes: Hex[]) {
    this.checkNewHashes(receiver, hashes);
    for (const hash of hashes) {
      if (receiver.hashes[hash] === undefined) {
        receiver.hashes[hash] = "free";
        this.hashOwner.set(hash, receiver.id);
      }
    }
    this.persist();
  }

  private freeHashes(receiverId: string) {
    return Object.values(this.state.receivers[receiverId].hashes).filter((s) => s === "free")
      .length;
  }

  private authenticate(receiverId: string, token: string): ReceiverRecord {
    const receiver = this.state.receivers[receiverId];
    const ok =
      !!receiver &&
      token !== "" &&
      (receiver.authHash
        ? sameString(`0x${createHash("sha256").update(token).digest("hex")}`, receiver.authHash)
        : sameString(receiver.token, token));
    if (!ok) {
      throw new LspError("unknown receiver or bad token");
    }
    return receiver;
  }

  /** Public: anyone who wants to pay the receiver asks for an invoice. */
  async requestInvoice(params: { receiverId: string; amount: bigint; description?: string }) {
    const receiver = this.state.receivers[params.receiverId];
    if (!receiver) {
      throw new LspError("unknown receiver");
    }
    const paymentHash = (Object.keys(receiver.hashes) as Hex[]).find(
      (h) => receiver.hashes[h] === "free",
    );
    if (!paymentHash) {
      throw new LspError("receiver has no unused payment hashes");
    }
    if (applyFee(params.amount, this.config.feePathA) <= 0n) {
      throw new LspError("amount does not cover the fee");
    }
    const open = Object.values(this.state.payments).filter(
      (p) => p.receiverId === receiver.id && p.state === "OPEN",
    ).length;
    if (open >= (this.config.maxOpenInvoicesPerReceiver ?? 32)) {
      throw new LspError("this receiver has too many unpaid invoices; try again later");
    }
    // Burn the hash before talking to the node: a hash must never back two
    // invoices, even if the call below fails.
    receiver.hashes[paymentHash] = "used";
    this.persist();

    const { invoice_address } = await this.config.fiber.newHoldInvoice({
      amount: params.amount,
      paymentHash,
      hashAlgorithm: receiver.hashAlgorithm,
      currency: this.config.currency,
      finalExpiryDeltaMs: this.config.dFinalMs,
      expirySeconds: this.config.invoiceExpirySeconds,
      description: params.description,
    });
    const payment: PaymentRecord = {
      paymentHash,
      receiverId: receiver.id,
      amount: params.amount.toString(),
      invoice: invoice_address,
      state: "OPEN",
      createdAtMs: Date.now(),
      history: [{ atMs: Date.now(), state: "OPEN" }],
    };
    this.state.payments[paymentHash] = payment;
    this.persist();
    return { invoice: invoice_address, paymentHash };
  }

  listPending(receiverId: string, token: string): PendingPayment[] {
    this.authenticate(receiverId, token);
    return Object.values(this.state.payments)
      .filter(
        (p) =>
          p.receiverId === receiverId &&
          ["HELD", "FORWARDING", "CELL_PENDING", "CELL_LIVE"].includes(p.state),
      )
      .map((p) => ({
        paymentHash: p.paymentHash,
        amount: p.amount,
        state: p.state,
        netPathA: applyFee(BigInt(p.amount), this.config.feePathA).toString(),
        eInMs: p.eInMs,
        cell: p.cell,
      }));
  }

  /** Every payment of this receiver, finished ones included, newest first. */
  listPayments(receiverId: string, token: string) {
    const receiver = this.authenticate(receiverId, token);
    const payments = Object.values(this.state.payments)
      .filter((p) => p.receiverId === receiverId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((p) => ({
        paymentHash: p.paymentHash,
        amount: p.amount,
        state: p.state,
        createdAtMs: p.createdAtMs,
        note: p.note,
        cell: p.cell,
      }));
    return {
      payments,
      registered: Object.keys(receiver.hashes).length,
      free: this.freeHashes(receiverId),
    };
  }

  /** Path A: the receiver is online and hands over an invoice for the same hash. */
  async receive(receiverId: string, token: string, paymentHash: Hex, invoice: string) {
    const receiver = this.authenticate(receiverId, token);
    const payment = this.state.payments[paymentHash];
    if (!payment || payment.receiverId !== receiver.id) {
      throw new LspError("unknown payment");
    }
    if (payment.state !== "HELD") {
      throw new LspError(`payment is ${payment.state}, path A needs HELD`);
    }
    if (payment.cell) {
      throw new LspError("a claim cell exists for this payment");
    }
    if (this.busy.has(paymentHash)) {
      throw new LspError("payment is being processed, try again");
    }
    this.busy.add(paymentHash);
    try {
      return await this.forward(payment, invoice);
    } finally {
      this.busy.delete(paymentHash);
    }
  }

  private async forward(payment: PaymentRecord, invoice: string) {
    const paymentHash = payment.paymentHash;
    const c = this.config;
    const receiver = this.state.receivers[payment.receiverId];
    if (!receiver.nodePubkey) {
      throw new LspError("this receiver registered no Fiber node; it is paid on chain");
    }
    const parsed = await c.fiber.parseInvoice(invoice);
    if (parsed.invoice.data.payment_hash !== paymentHash) {
      throw new LspError("invoice payment hash differs from the held payment");
    }
    const attr = (name: string) =>
      parsed.invoice.data.attrs.find((a) => name in a)?.[name] as string | undefined;
    // Only the node named at registration is paid, whoever holds the token.
    if (attr("payee_public_key") !== receiver.nodePubkey) {
      throw new LspError("invoice is not issued by the receiver's registered node");
    }
    // Same hash under another algorithm is a different lock: the preimage
    // that opens it would not open the payment held here.
    if ((attr("hash_algorithm") ?? "ckb_hash") !== receiver.hashAlgorithm) {
      throw new LspError("invoice uses a different hash algorithm than the held payment");
    }
    if (attr("udt_script") !== undefined) {
      throw new LspError("invoice is denominated in a UDT");
    }
    const amount = BigInt(payment.amount);
    const net = applyFee(amount, c.feePathA);
    const asked = parsed.invoice.amount ? BigInt(parsed.invoice.amount) : 0n;
    if (asked <= 0n || asked > net) {
      throw new LspError(`invoice amount must be between 1 and the net amount ${net}`);
    }
    const remaining = BigInt(payment.eInMs!) - BigInt(Date.now());
    if (remaining < c.dMinMs + c.dRandMs + c.dFwdMs) {
      throw new LspError("too close to the incoming TLC expiry for path A");
    }
    if ((await c.fiber.invoiceStatus(paymentHash)) !== "Received") {
      throw new LspError("the incoming payment is no longer held");
    }
    // Re-checked after the awaits above; `busy` keeps the tick out meanwhile.
    if (payment.state !== "HELD" || payment.cell) {
      throw new LspError(`payment is ${payment.state}, path A needs HELD`);
    }

    payment.outgoingInvoice = invoice;
    this.move(payment, "FORWARDING");
    try {
      await c.fiber.sendPayment({
        invoice,
        // Keep the outgoing TLC expiring at least D_fwd before the incoming one.
        tlcExpiryLimitMs: remaining - c.dFwdMs,
        // Routing must be paid out of what the LSP keeps, never out of pocket.
        maxFeeAmount: amount - asked,
      });
    } catch (err) {
      // The node may have taken the payment even though the call failed. The
      // payment stays FORWARDING and the next tick asks the node what happened.
      throw new LspError(`forwarding failed: ${(err as Error).message}`);
    }
    return { state: payment.state };
  }

  getPayment(paymentHash: Hex) {
    return this.state.payments[paymentHash];
  }

  // ----------------------------------------------------------- state machine

  /** Advances every unfinished payment by one step. Call it periodically. */
  async tick() {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      for (const payment of Object.values(this.state.payments)) {
        if (FINAL_STATES.includes(payment.state) || this.busy.has(payment.paymentHash)) {
          continue;
        }
        this.busy.add(payment.paymentHash);
        try {
          await this.step(payment);
        } catch (err) {
          this.log(`${payment.paymentHash.slice(0, 10)}… step failed: ${(err as Error).message}`);
        } finally {
          this.busy.delete(payment.paymentHash);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async step(payment: PaymentRecord) {
    switch (payment.state) {
      case "OPEN":
        return this.stepOpen(payment);
      case "HELD":
        return this.stepHeld(payment);
      case "FORWARDING":
        return this.stepForwarding(payment);
      case "CELL_PENDING":
        return this.stepCellPending(payment);
      case "CELL_LIVE":
        return this.stepCellLive(payment);
      case "CLAIMED":
        return this.stepClaimed(payment);
      case "REFUNDING":
        return this.stepRefunding(payment);
    }
  }

  private async stepOpen(payment: PaymentRecord) {
    const status = await this.config.fiber.invoiceStatus(payment.paymentHash);
    if (status === "Open") {
      payment.lastUnpaidAtMs = Date.now(); // kept in memory; a restart falls back to an older, safer value
    } else if (status === "Received") {
      payment.heldAtMs = Date.now();
      // The node only accepts a final-hop TLC that still has the invoice's
      // final_expiry_delta left when it arrives, and it arrived after the last
      // time the invoice was seen unpaid. That makes this a lower bound on
      // E_in even if this process was slow or down when the TLC came in.
      const bound = (payment.lastUnpaidAtMs ?? payment.createdAtMs) + Number(this.config.dFinalMs);
      // Better: the TLC itself, which carries its real expiry and says which
      // peer it came through.
      const tlc = await this.config.fiber.incomingTlc(payment.paymentHash).catch(() => undefined);
      payment.upstreamPeer = tlc?.peer;
      payment.eInMs = tlc ? Number(tlc.expiryMs) : bound;
      this.move(payment, "HELD");
      const receiver = this.state.receivers[payment.receiverId];
      if (receiver.wakeEndpoint) {
        this.config
          .wake(receiver.wakeEndpoint)
          .catch((err) => this.log(`wake failed: ${(err as Error).message}`));
      }
    } else if (status === "Cancelled" || status === "Expired") {
      this.move(payment, "FAILED", `invoice ${status.toLowerCase()} before payment`);
    }
  }

  private async stepHeld(payment: PaymentRecord) {
    const c = this.config;
    const receiver = this.state.receivers[payment.receiverId];
    const now = BigInt(Date.now());
    const eIn = BigInt(payment.eInMs!);
    const pathAOpen = !!receiver.nodePubkey && now + c.dMinMs + c.dRandMs + c.dFwdMs <= eIn;

    // Give an online-capable receiver T_wake to show up before going on chain.
    if (receiver.nodePubkey && now - BigInt(payment.heldAtMs!) < c.tWakeMs) {
      return;
    }

    // Never pay out against a payment the node is no longer holding.
    const status = await c.fiber.invoiceStatus(payment.paymentHash);
    if (status !== "Received") {
      this.move(payment, "FAILED", `incoming payment is ${status.toLowerCase()}, no longer held`);
      return;
    }

    const amount = BigInt(payment.amount);
    const receiverLock = ccc.Script.from(receiver.lock);
    const receiverCapacity = applyFee(amount, c.feePathB);
    const tClaimMs = eIn - c.deltaSettleMs;
    const pathBOpen =
      receiverCapacity >= minimalCapacity(receiverLock) &&
      receiverCapacity >= (c.minPathBAmount ?? 0n) &&
      now + c.wMinMs + c.deltaMarginMs <= tClaimMs;

    if (pathBOpen) {
      const { capacity } = ckbClaimCellCapacity(receiverCapacity, this.refundLock);
      const over = this.overExposure(payment, capacity) ?? (await this.unhealthy());
      if (!over) {
        return this.createClaimCell(payment, receiver, receiverLock, receiverCapacity, tClaimMs);
      }
      // Room may appear as other cells are claimed or refunded; until the
      // claim window closes this payment simply waits.
      if (payment.note !== over) {
        this.move(payment, "HELD", over);
      }
      return;
    }
    if (!pathAOpen) {
      await c.fiber.cancelInvoice(payment.paymentHash);
      this.move(payment, "FAILED", "neither path is available; incoming TLC returned");
    }
  }

  private async createClaimCell(
    payment: PaymentRecord,
    receiver: ReceiverRecord,
    receiverLock: ccc.Script,
    receiverCapacity: bigint,
    tClaimMs: bigint,
  ) {
    const c = this.config;
    const expirySeconds =
      c.testClaimExpirySeconds !== undefined
        ? BigInt(Math.floor(Date.now() / 1000)) + c.testClaimExpirySeconds
        : tClaimMs / 1000n;
    const args: ClaimArgs = {
      hashAlgorithm: receiver.hashAlgorithm,
      paymentHash: payment.paymentHash,
      receiverLockHash: lockHash20(receiverLock),
      refundLockHash: lockHash20(this.refundLock),
      expirySeconds,
      receiverCapacity,
    };
    const { capacity, change } = ckbClaimCellCapacity(receiverCapacity, this.refundLock);
    const tx = ccc.Transaction.from({
      outputs: [{ lock: claimLock(c.deployment, args), capacity }],
      outputsData: ["0x"],
    });
    await tx.completeInputsByCapacity(c.signer);
    await tx.completeFeeBy(c.signer, 1000n);
    const signed = await c.signer.signTransaction(tx);
    const txHash = signed.hash();
    payment.cell = {
      txHash,
      index: 0,
      args: encodeClaimArgs(args),
      capacity: capacity.toString(),
      receiverCapacity: receiverCapacity.toString(),
      change: change.toString(),
      expirySeconds: expirySeconds.toString(),
      signedTx: ccc.hexFrom(signed.toBytes()),
    };
    // Written down before it is sent. From here on path A is closed for this
    // hash, and a restart sends this same transaction again rather than
    // building another one.
    this.move(payment, "CELL_PENDING", `claim cell ${txHash}`);
    await this.broadcastClaimCell(payment.cell);
  }

  private async broadcastClaimCell(cell: CellRecord) {
    try {
      await this.config.client.sendTransaction(ccc.Transaction.fromBytes(cell.signedTx!));
    } catch (err) {
      // Already in the pool or already on chain is what we want.
      if (!/Duplicated|already (exists|known)/i.test(String((err as Error).message))) {
        throw err;
      }
    }
  }

  private async stepCellPending(payment: PaymentRecord) {
    const c = this.config;
    const cell = payment.cell!;
    const tx = await c.client.getTransaction(cell.txHash);
    if (tx?.status === "committed") {
      this.move(payment, "CELL_LIVE");
      return;
    }
    if (tx && tx.status !== "rejected" && tx.status !== "unknown") {
      return; // in the pool
    }
    if (!cell.signedTx) {
      return;
    }
    // The node does not have the transaction. It can only be given up on once
    // it can never confirm, which is when one of its inputs has been spent by
    // something else; otherwise a second claim cell could end up next to it.
    const signed = ccc.Transaction.fromBytes(cell.signedTx);
    for (const input of signed.inputs) {
      if (!(await c.client.getCellLive(input.previousOutput, false, false))) {
        const again = await c.client.getTransaction(cell.txHash);
        if (again?.status === "committed") {
          this.move(payment, "CELL_LIVE");
          return;
        }
        payment.cell = undefined;
        this.move(payment, "HELD", "claim cell transaction can no longer confirm");
        return;
      }
    }
    await this.broadcastClaimCell(cell);
    this.log(`${payment.paymentHash.slice(0, 10)}… claim cell transaction sent again`);
  }

  private exposed(filter: (p: PaymentRecord) => boolean = () => true): PaymentRecord[] {
    return Object.values(this.state.payments).filter(
      (p) => p.cell && EXPOSED_STATES.includes(p.state) && filter(p),
    );
  }

  /** CKB currently committed to claim cells, in total or for one receiver. */
  exposure(receiverId?: string): bigint {
    return this.exposed((p) => receiverId === undefined || p.receiverId === receiverId).reduce(
      (sum, p) => sum + BigInt(p.cell!.capacity),
      0n,
    );
  }

  /** CKB committed to claim cells for payments that came in through one peer. */
  exposureThroughPeer(peer: string): bigint {
    return this.exposed((p) => p.upstreamPeer === peer).reduce(
      (sum, p) => sum + BigInt(p.cell!.capacity),
      0n,
    );
  }

  /** Why a new claim cell of `capacity` for `payment` must wait, if it must. */
  private overExposure(payment: PaymentRecord, capacity: bigint): string | undefined {
    const c = this.config;
    const receiverId = payment.receiverId;
    if (c.maxExposure !== undefined && this.exposure() + capacity > c.maxExposure) {
      return "waiting: claim cells are at the LSP's total limit";
    }
    if (
      c.maxExposurePerReceiver !== undefined &&
      this.exposure(receiverId) + capacity > c.maxExposurePerReceiver
    ) {
      return "waiting: claim cells are at this receiver's limit";
    }
    if (c.maxExposurePerPeer !== undefined) {
      // A payment whose peer is unknown counts against one shared allowance.
      const peer = payment.upstreamPeer ?? "";
      if (this.exposureThroughPeer(peer) + capacity > c.maxExposurePerPeer) {
        return "waiting: claim cells are at the limit for the peer this payment came through";
      }
    }
    if (c.maxCells !== undefined && this.exposed().length >= c.maxCells) {
      return "waiting: the LSP has as many claim cells open as it allows";
    }
    if (
      c.maxCellsPerReceiver !== undefined &&
      this.exposed((p) => p.receiverId === receiverId).length >= c.maxCellsPerReceiver
    ) {
      return "waiting: this receiver has as many claim cells open as allowed";
    }
    return undefined;
  }

  /** Why no claim cell may be opened right now, if something is not well. */
  private async unhealthy(): Promise<string | undefined> {
    for (const check of this.config.healthChecks ?? []) {
      try {
        await check();
      } catch (err) {
        return `waiting: not opening claim cells (${(err as Error).message})`;
      }
    }
    return undefined;
  }

  private async stepCellLive(payment: PaymentRecord) {
    const c = this.config;
    const cell = payment.cell!;
    const outPoint = { txHash: cell.txHash, index: cell.index };
    const live = await c.client.getCellLive(outPoint, false, false);
    if (!live) {
      return this.resolveSpentCell(payment);
    }
    if (BigInt(Math.floor(Date.now() / 1000)) < BigInt(cell.expirySeconds)) {
      return;
    }
    const refund = buildRefundTx({
      deployment: c.deployment,
      outPoint,
      expirySeconds: BigInt(cell.expirySeconds),
      refundLock: this.refundLock,
      capacity: BigInt(cell.capacity),
    });
    try {
      payment.refundTxHash = await c.client.sendTransaction(refund);
      this.move(payment, "REFUNDING", `refund ${payment.refundTxHash}`);
    } catch (err) {
      // "Immature" until the chain's median time passes the expiry: retry.
      if (!/Immature/i.test(String((err as Error).message))) {
        throw err;
      }
    }
  }

  /** The claim cell is gone: find out whether it was claimed or refunded. */
  private async resolveSpentCell(payment: PaymentRecord) {
    const c = this.config;
    const cell = payment.cell!;
    const outPoint = { txHash: cell.txHash, index: cell.index };
    const lock = ccc.Script.from({
      codeHash: c.deployment.codeHash,
      hashType: "data2",
      args: cell.args,
    });
    const receiver = this.state.receivers[payment.receiverId];
    for await (const entry of c.client.findTransactions(
      { script: lock, scriptType: "lock", scriptSearchMode: "exact" },
      "desc",
    )) {
      if (!("isInput" in entry) || !entry.isInput) {
        continue;
      }
      const spending = await c.client.getTransaction(entry.txHash);
      if (!spending || spending.status !== "committed") {
        continue;
      }
      const how = spendOfClaimCell(spending.transaction, outPoint);
      if (how === undefined) {
        continue; // spends some other cell with the same lock
      }
      if (how.preimage && hashPreimage(receiver.hashAlgorithm, how.preimage) === payment.paymentHash) {
        payment.preimage = how.preimage;
        this.move(payment, "CLAIMED", `claimed in ${entry.txHash}`);
      } else {
        await this.failAfterRefund(payment, entry.txHash, spending.blockNumber);
      }
      return;
    }
    // Spent but not indexed yet: look again on the next tick.
  }

  private async stepRefunding(payment: PaymentRecord) {
    const c = this.config;
    const cell = payment.cell!;
    // What happened to the cell is read from the chain, never inferred from
    // the refund we sent: the receiver's claim may have landed first.
    const live = await c.client.getCellLive({ txHash: cell.txHash, index: cell.index }, false, false);
    if (!live) {
      return this.resolveSpentCell(payment);
    }
    const tx = await c.client.getTransaction(payment.refundTxHash!);
    if (!tx || tx.status === "rejected" || tx.status === "unknown") {
      this.move(payment, "CELL_LIVE", "refund not in the pool, rechecking the cell");
    }
  }

  /**
   * The cell went back to the LSP. The incoming payment is released only once
   * that is buried deep enough that a reorg cannot swap it for a claim.
   */
  private async failAfterRefund(payment: PaymentRecord, txHash: Hex, blockNumber?: bigint) {
    const need = BigInt(this.config.refundConfirmations ?? 6);
    const tip = (await this.config.client.getTipHeader()).number;
    const have = blockNumber === undefined ? 0n : tip - blockNumber + 1n;
    if (have < need) {
      if (payment.state !== "REFUNDING") {
        payment.refundTxHash = txHash;
        this.move(payment, "REFUNDING", `refund ${txHash}`);
      }
      return;
    }
    await this.config.fiber.cancelInvoice(payment.paymentHash);
    this.move(payment, "FAILED", `refunded in ${txHash}; incoming TLC returned`);
  }

  private async stepForwarding(payment: PaymentRecord) {
    let outgoing;
    try {
      outgoing = await this.config.fiber.getPayment(payment.paymentHash);
    } catch (err) {
      // The node has no such payment: the send never started.
      if (/Payment session not found/i.test((err as Error).message)) {
        payment.outgoingInvoice = undefined;
        this.move(payment, "HELD", "path A send did not start");
        return;
      }
      throw err;
    }
    const receiver = this.state.receivers[payment.receiverId];
    if (outgoing.status === "Success" && outgoing.payment_preimage) {
      if (hashPreimage(receiver.hashAlgorithm, outgoing.payment_preimage) !== payment.paymentHash) {
        throw new Error("outgoing payment succeeded with a preimage that does not open the held payment");
      }
      payment.preimage = outgoing.payment_preimage;
      this.move(payment, "CLAIMED", "receiver settled over the channel");
    } else if (outgoing.status === "Failed") {
      payment.outgoingInvoice = undefined;
      this.move(payment, "HELD", `path A failed: ${outgoing.failed_error ?? "unknown"}`);
    }
  }

  private async stepClaimed(payment: PaymentRecord) {
    const fiber = this.config.fiber;
    if (!payment.settleCalled) {
      await fiber.settleInvoice(payment.paymentHash, payment.preimage!);
      payment.settleCalled = true;
      this.persist();
    }
    // settle_invoice succeeds even if the node already returned the TLC, so
    // only the invoice turning Paid counts as having been paid.
    const status = await fiber.invoiceStatus(payment.paymentHash);
    if (status === "Paid") {
      this.move(payment, "SETTLED");
    }
  }
}
