/**
 * Minimal JSON-RPC client for a Fiber node (fnn).
 *
 * Fiber encodes every integer as a 0x-prefixed hex string and takes a single
 * params object, so the helpers here convert at the boundary and nothing else
 * in the code base has to care.
 */

export type Hex = `0x${string}`;

export type InvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";
export type PaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

export type HashAlgorithm = "ckb_hash" | "sha256";

export type Payment = {
  payment_hash: Hex;
  payment_preimage?: Hex | null;
  status: PaymentStatus;
  failed_error?: string | null;
  fee: Hex;
};

export type ChannelInfo = {
  channel_id: Hex;
  pubkey: string;
  pending_tlcs: { payment_hash: Hex; expiry: Hex; amount: Hex; status: unknown }[];
};

export class FiberRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

export const toHex = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}`;

export class FiberRpc {
  private id = 0;

  constructor(readonly url: string) {}

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.id,
        method,
        params: params === undefined ? [] : [params],
      }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error) {
      const data = body.error.data === undefined ? "" : ` ${JSON.stringify(body.error.data)}`;
      throw new FiberRpcError(method, body.error.code, body.error.message + data);
    }
    return body.result as T;
  }

  nodeInfo() {
    return this.call<{ pubkey: string; version: string; commit_hash: string; addresses: string[] }>(
      "node_info",
    );
  }

  /** Creates a hold invoice: the node knows the hash but not the preimage. */
  newHoldInvoice(params: {
    amount: bigint;
    paymentHash: Hex;
    hashAlgorithm: HashAlgorithm;
    currency: string;
    finalExpiryDeltaMs: bigint;
    expirySeconds: bigint;
    description?: string;
  }) {
    return this.call<{ invoice_address: string }>("new_invoice", {
      amount: toHex(params.amount),
      currency: params.currency,
      payment_hash: params.paymentHash,
      hash_algorithm: params.hashAlgorithm,
      final_expiry_delta: toHex(params.finalExpiryDeltaMs),
      expiry: toHex(params.expirySeconds),
      description: params.description,
      allow_mpp: false,
    });
  }

  /** Creates an ordinary invoice for a preimage the node already holds. */
  newInvoice(params: {
    amount: bigint;
    paymentPreimage: Hex;
    hashAlgorithm: HashAlgorithm;
    currency: string;
    finalExpiryDeltaMs?: bigint;
    expirySeconds?: bigint;
  }) {
    return this.call<{ invoice_address: string }>("new_invoice", {
      amount: toHex(params.amount),
      currency: params.currency,
      payment_preimage: params.paymentPreimage,
      hash_algorithm: params.hashAlgorithm,
      final_expiry_delta:
        params.finalExpiryDeltaMs === undefined ? undefined : toHex(params.finalExpiryDeltaMs),
      expiry: params.expirySeconds === undefined ? undefined : toHex(params.expirySeconds),
      allow_mpp: false,
    });
  }

  async invoiceStatus(paymentHash: Hex): Promise<InvoiceStatus> {
    const result = await this.call<{ status: InvoiceStatus }>("get_invoice", {
      payment_hash: paymentHash,
    });
    return result.status;
  }

  parseInvoice(invoice: string) {
    return this.call<{
      invoice: {
        amount?: Hex | null;
        data: { payment_hash: Hex; attrs: Record<string, unknown>[] };
      };
    }>("parse_invoice", { invoice });
  }

  settleInvoice(paymentHash: Hex, preimage: Hex) {
    return this.call<unknown>("settle_invoice", {
      payment_hash: paymentHash,
      payment_preimage: preimage,
    });
  }

  cancelInvoice(paymentHash: Hex) {
    return this.call<unknown>("cancel_invoice", { payment_hash: paymentHash });
  }

  sendPayment(params: { invoice: string; tlcExpiryLimitMs?: bigint; maxFeeAmount?: bigint }) {
    return this.call<Payment>("send_payment", {
      invoice: params.invoice,
      tlc_expiry_limit:
        params.tlcExpiryLimitMs === undefined ? undefined : toHex(params.tlcExpiryLimitMs),
      max_fee_amount: params.maxFeeAmount === undefined ? undefined : toHex(params.maxFeeAmount),
    });
  }

  /** Every channel with the TLCs currently pending in it. */
  async listChannels() {
    const result = await this.call<{ channels: ChannelInfo[] }>("list_channels", {});
    return result.channels;
  }

  /**
   * The TLC a held payment arrived in: which channel and peer it came through,
   * and when it really expires. Undefined if the node holds no such TLC.
   */
  async incomingTlc(paymentHash: Hex) {
    for (const channel of await this.listChannels()) {
      const tlc = channel.pending_tlcs.find(
        (t) => t.payment_hash === paymentHash && "Inbound" in (t.status as object),
      );
      if (tlc) {
        return { channelId: channel.channel_id, peer: channel.pubkey, expiryMs: BigInt(tlc.expiry) };
      }
    }
    return undefined;
  }

  getPayment(paymentHash: Hex) {
    return this.call<Payment>("get_payment", { payment_hash: paymentHash });
  }
}
