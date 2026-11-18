import { ccc } from "@ckb-ccc/connector";
import { CKB_RPC_URL, h, lsp, LSP_URL, type LspInfo, PAY_TO } from "./api.js";
import { renderPay } from "./pay.js";
import { renderReceive } from "./receive.js";

const root = document.getElementById("app")!;

async function main() {
  if (!LSP_URL) {
    root.replaceChildren(
      h("h1", {}, "Fiber Claim Cell"),
      h("p", { class: "error" }, "No LSP is configured. Build this page with VITE_LSP_URL set to the LSP's address."),
    );
    return;
  }
  let info: LspInfo;
  try {
    info = await lsp<LspInfo>("get_info");
  } catch (err) {
    root.replaceChildren(
      h("h1", {}, "Fiber Claim Cell"),
      h("p", { class: "error" }, `Could not reach the LSP at ${LSP_URL}: ${(err as Error).message}`),
    );
    return;
  }
  if (PAY_TO) {
    renderPay(root, PAY_TO);
    return;
  }
  const options = CKB_RPC_URL ? { url: CKB_RPC_URL } : undefined;
  const client =
    info.network === "mainnet" ? new ccc.ClientPublicMainnet(options) : new ccc.ClientPublicTestnet(options);
  renderReceive(root, client, info);
}

void main();
