/**
 * HTTP JSON-RPC front end for the LSP (RFC 0001, "LSP interface").
 *
 * Receiver methods take the receiver id as a parameter and the token issued at
 * registration as a bearer token. `lsp_async_get_info` and
 * `lsp_async_request_invoice` are public.
 *
 * The module bounds what one receiver can make it store. Limiting how often
 * one client may call is left to whatever the operator puts in front of it.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Hex } from "./fiber.js";
import { type AsyncReceiveLsp, LspError } from "./lsp.js";

type Params = Record<string, any>;

const MAX_BODY_BYTES = 64 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new LspError("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createLspServer(lsp: AsyncReceiveLsp): Server {
  const methods: Record<string, (params: Params, token: string) => unknown> = {
    lsp_async_get_info: () => lsp.getInfo(),
    lsp_async_register: (p) =>
      lsp.register({
        lock: p.lock,
        nodePubkey: p.node_pubkey,
        wakeEndpoint: p.wake_endpoint,
        hashAlgorithm: p.hash_algorithm,
        hashes: p.hashes,
        authHash: p.auth_hash,
      }),
    lsp_async_add_hashes: (p, token) => lsp.addHashes(p.receiver_id, token, p.hashes),
    lsp_async_request_invoice: (p) =>
      lsp.requestInvoice({
        receiverId: p.receiver_id,
        amount: BigInt(p.amount),
        description: p.description,
      }),
    lsp_async_list_pending: (p, token) => lsp.listPending(p.receiver_id, token),
    lsp_async_list_payments: (p, token) => lsp.listPayments(p.receiver_id, token),
    lsp_async_receive: (p, token) =>
      lsp.receive(p.receiver_id, token, p.payment_hash as Hex, p.invoice),
  };

  // The receive page is a web app on another origin, so browsers must be
  // allowed to call this API. Nothing here relies on cookies.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, OPTIONS",
  };

  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    let id: unknown = null;
    const reply = (body: object) => {
      response.writeHead(200, { "content-type": "application/json", ...cors });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    };
    try {
      const call = JSON.parse(await readBody(request)) as {
        id?: unknown;
        method: string;
        params?: Params;
      };
      id = call.id ?? null;
      const handler = methods[call.method];
      if (!handler) {
        return reply({ error: { code: -32601, message: `unknown method ${call.method}` } });
      }
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      reply({ result: await handler(call.params ?? {}, token) });
    } catch (err) {
      // Only the module's own errors are meant for callers; anything else may
      // carry details of the node behind it.
      if (err instanceof LspError) {
        reply({ error: { code: -32000, message: err.message } });
      } else {
        console.error(err);
        reply({ error: { code: -32603, message: "internal error" } });
      }
    }
  });
}

/** Client-side helper for the interface above. */
export async function callLsp<T>(
  url: string,
  method: string,
  params: Params,
  token?: string,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message}`);
  }
  return body.result as T;
}
