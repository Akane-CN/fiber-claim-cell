/** Page configuration and the JSON-RPC client for the LSP's claim module. */
import type { Deployment } from "../../lsp/src/claim.js";

const params = new URLSearchParams(location.search);

/**
 * Test builds (the dev server, or VITE_DEV_SIGNER=1) may be pointed at any LSP
 * and node from the URL. A production build never reads them from the URL: a
 * link must not be able to turn the operator's page towards someone else's
 * server while it holds the visitor's receive key.
 */
const TEST_BUILD = import.meta.env.DEV || import.meta.env.VITE_DEV_SIGNER === "1";
const override = (name: string) => (TEST_BUILD ? params.get(name) : null);

/** The LSP this page talks to. An operator bakes its own in at build time. */
export const LSP_URL = override("lsp") ?? import.meta.env.VITE_LSP_URL ?? "";
/** Optional CKB RPC, for devnets and operators with their own node. */
export const CKB_RPC_URL = override("rpc") ?? import.meta.env.VITE_CKB_RPC_URL ?? "";
/** Present on a pay link: the receiver the payer wants to pay. */
export const PAY_TO = params.get("to");
/**
 * A raw private key in the URL, for automated tests only. It is honoured only
 * in a build made with VITE_DEV_SIGNER=1 and never in a normal build.
 */
export const DEV_KEY = import.meta.env.VITE_DEV_SIGNER === "1" ? params.get("devkey") : null;

export type ScriptJson = { codeHash: string; hashType: string; args: string };

export type LspInfo = {
  claimLock: Deployment & { hashType: string };
  nodePubkey: string;
  refundLock: ScriptJson;
  network: "mainnet" | "testnet" | "devnet";
  feePathB: { base: string; ppm: string };
  deltaMarginMs: string;
  minConfirmations: number;
};

export type CellInfo = {
  txHash: `0x${string}`;
  index: number;
  capacity: string;
  receiverCapacity: string;
  expirySeconds: string;
};

export type PaymentInfo = {
  paymentHash: `0x${string}`;
  amount: string;
  state: string;
  createdAtMs: number;
  note?: string;
  cell?: CellInfo;
};

export async function lsp<T>(
  method: string,
  callParams: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const response = await fetch(LSP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `lsp_async_${method}`, params: callParams }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(body.error.message);
  }
  return body.result as T;
}

/** Link for a payer: this same page, pointed at one receiver. */
export function payLink(receiverId: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  for (const name of ["lsp", "rpc"]) {
    const value = override(name);
    if (value) {
      url.searchParams.set(name, value);
    }
  }
  url.searchParams.set("to", receiverId);
  return url.toString();
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

export async function copy(text: string, button: HTMLButtonElement) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select and copy it";
  }
  setTimeout(() => (button.textContent = label), 1500);
}
