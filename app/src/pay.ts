/**
 * The payer's page. It asks the LSP for an invoice for one receiver and shows
 * it. The payer then pays that invoice with any Fiber wallet or node; nothing
 * about this protocol is needed on the paying side.
 */
import { ccc } from "@ckb-ccc/connector";
import { copy, h, lsp } from "./api.js";

export function renderPay(root: HTMLElement, receiverId: string) {
  const amount = h("input", {
    id: "amount",
    type: "text",
    inputmode: "decimal",
    placeholder: "Amount in CKB",
    "aria-label": "Amount in CKB",
  });
  const button = h("button", { id: "get-invoice", type: "submit" }, "Get invoice");
  const error = h("p", { class: "error", id: "pay-error" });
  const result = h("div", { class: "card", id: "invoice-card", hidden: "" });
  const form = h("form", { class: "row" }, h("div", { class: "grow" }, amount), button);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    let shannons: bigint;
    try {
      shannons = ccc.fixedPointFrom(amount.value.trim());
      if (shannons <= 0n) {
        throw new Error();
      }
    } catch {
      error.textContent = "Enter an amount in CKB, for example 200.";
      return;
    }
    button.disabled = true;
    try {
      const { invoice } = await lsp<{ invoice: string }>("request_invoice", {
        receiver_id: receiverId,
        amount: shannons.toString(),
      });
      const copyButton = h("button", { class: "secondary", type: "button" }, "Copy invoice");
      copyButton.addEventListener("click", () => void copy(invoice, copyButton));
      result.replaceChildren(
        h("h2", {}, `Invoice for ${ccc.fixedPointToString(shannons)} CKB`),
        h("div", { class: "code", id: "invoice" }, invoice),
        h("div", { class: "row" }, copyButton),
        h(
          "p",
          { class: "muted" },
          "Pay it with any Fiber wallet or node. If the receiver is away, your payment shows as pending until they collect it, and comes back to you if they never do.",
        ),
      );
      result.hidden = false;
    } catch (err) {
      error.textContent = `Could not get an invoice: ${(err as Error).message}`;
    } finally {
      button.disabled = false;
    }
  });

  root.replaceChildren(
    h("h1", {}, "Pay over Fiber"),
    h(
      "p",
      { class: "muted" },
      "The receiver does not need to be online or to have a channel. They collect the payment on chain when they are back.",
    ),
    h("div", { class: "card" }, form, error),
    result,
  );
}
