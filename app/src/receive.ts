/**
 * The receiver's page. The wallet is used for two things only: its address,
 * and one signed message from which the receive seed is derived. Everything
 * else — the payment preimages, checking a claim cell against the chain, and
 * the claim transaction, which needs no signature — happens in this page.
 */
import { ccc } from "@ckb-ccc/connector";
import {
  buildClaimForVerifiedCell,
  ClaimCellRejected,
  deriveAuth,
  derivePool,
  receiveSeedMessage,
  seedFromSignature,
  verifyClaimCell,
} from "../../lsp/src/receiver.js";
import { type Deployment, KNOWN_DEPLOYMENTS } from "../../lsp/src/claim.js";
import { copy, DEV_KEY, h, lsp, type LspInfo, payLink, type PaymentInfo } from "./api.js";

const BATCH = 16;
const POLL_MS = 4000;

/**
 * What the page insists on whatever the LSP says. The LSP may ask for more
 * caution than this, never less: both numbers exist to protect the receiver
 * from a claim that reveals the preimage and then loses the cell.
 */
const FLOORS = {
  mainnet: { confirmations: 24n, marginSeconds: 3600n },
  other: { confirmations: 4n, marginSeconds: 60n },
};
const atLeast = (a: bigint, b: bigint) => (a > b ? a : b);

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) {
      localStorage.setItem(key, value);
    }
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

export function renderReceive(root: HTMLElement, client: ccc.Client, info: LspInfo) {
  const status = h("p", { class: "muted", id: "status" });
  const connect = h("button", { id: "connect", type: "button" }, "Connect wallet");
  const body = h("div", { id: "receive-body" });
  root.replaceChildren(
    h("h1", {}, "Receive over Fiber"),
    h(
      "p",
      { class: "muted" },
      "Get paid over Fiber without a channel and without being online. Payments wait for you on chain, and nobody else can take them.",
    ),
    h("div", { class: "card", id: "connect-card" }, h("div", { class: "row" }, connect), status),
    body,
  );

  // The lock script this page will reveal a preimage to. On a public network
  // it is the one compiled into the page, not one the LSP names.
  const known = info.network === "devnet" ? undefined : KNOWN_DEPLOYMENTS[info.network];
  if (known && known.codeHash !== info.claimLock.codeHash) {
    status.className = "error";
    status.textContent = "This LSP uses a claim script this page does not recognise, so it cannot be used here.";
    connect.disabled = true;
    return;
  }
  const deployment: Deployment = known ?? info.claimLock;
  const floor = info.network === "mainnet" ? FLOORS.mainnet : FLOORS.other;
  const minConfirmations = atLeast(BigInt(info.minConfirmations), floor.confirmations);
  const marginSeconds = atLeast(BigInt(info.deltaMarginMs) / 1000n, floor.marginSeconds);

  let started = false;
  const begin = (signer: ccc.Signer) => {
    if (started) {
      return;
    }
    started = true;
    connect.disabled = true;
    start(signer).catch((err) => {
      started = false;
      connect.disabled = false;
      status.className = "error";
      status.textContent = `Could not start: ${(err as Error).message}`;
    });
  };

  if (DEV_KEY) {
    begin(new ccc.SignerCkbPrivateKey(client, DEV_KEY));
  } else {
    const connector = document.createElement("ccc-connector") as ccc.WebComponentConnector;
    connector.name = "Fiber Claim Cell";
    connector.style.display = "none";
    connector.setClient(client);
    connector.addEventListener("close", () => (connector.style.display = "none"));
    connector.addEventListener("willUpdate", () => {
      const signer = connector.signer?.signer;
      if (signer) {
        connector.style.display = "none";
        begin(signer);
      }
    });
    document.body.append(connector);
    connect.addEventListener("click", () => (connector.style.display = "block"));
  }

  async function start(signer: ccc.Signer) {
    status.className = "muted";
    status.textContent = "Reading your address…";
    await signer.connect();
    const address = await signer.getRecommendedAddressObj();
    const lock = address.script;

    // One signature, once per browser. The seed stays in this browser; with a
    // wallet whose signatures are deterministic, signing again elsewhere
    // reproduces it, so there is nothing to back up.
    const seedKey = `fcc.seed.${lock.hash()}`;
    let seed = store(seedKey) as ccc.Hex | null;
    if (!seed) {
      status.textContent = "Sign the message in your wallet to set up receiving…";
      const signed = await signer.signMessage(receiveSeedMessage(lock));
      seed = seedFromSignature(signed.signature);
      store(seedKey, seed);
    }
    // Hashes and token are derived per LSP, so nothing shown to this LSP is of
    // use at another one the same wallet receives through.
    const scope = info.nodePubkey;
    const auth = deriveAuth(seed, scope);
    const preimages = new Map<string, ccc.Hex>();
    const growPool = (upTo: number) => {
      for (const entry of derivePool(seed, scope, preimages.size, Math.max(0, upTo - preimages.size), "ckb_hash")) {
        preimages.set(entry.hash, entry.preimage);
      }
    };
    growPool(BATCH);

    status.textContent = "Registering with the LSP…";
    const registration = await lsp<{ receiverId: string; registered: number }>("register", {
      lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args },
      hash_algorithm: "ckb_hash",
      hashes: [...preimages.keys()],
      auth_hash: auth.authHash,
    });
    const receiverId = registration.receiverId;
    growPool(registration.registered);
    // A claim transaction that was sent, kept so that it can be sent again.
    const claimTxKey = (hash: string) => `fcc.claimtx.${receiverId}.${hash}`;

    const link = payLink(receiverId);
    const copyButton = h("button", { class: "secondary", type: "button" }, "Copy link");
    copyButton.addEventListener("click", () => void copy(link, copyButton));
    const list = h("div", { id: "payments" });
    const empty = h("p", { class: "muted" }, "No payments yet. Share the link above to get paid.");
    status.textContent = "";
    document.getElementById("connect-card")!.hidden = true;
    body.replaceChildren(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Your address"),
        h("div", { class: "code", id: "address" }, address.toString()),
        h("h2", {}, "Your pay link"),
        h("div", { class: "code", id: "pay-link" }, link),
        h("div", { class: "row" }, copyButton),
        h("p", { class: "muted" }, "Anyone with this link can get a Fiber invoice that pays you."),
      ),
      h("div", { class: "card" }, h("h2", {}, "Payments"), empty, list),
    );

    const claimsKey = `fcc.claims.${receiverId}`;
    const claims: Record<string, string> = JSON.parse(store(claimsKey) ?? "{}");
    const claiming = new Set<string>();
    const explorer =
      info.network === "mainnet"
        ? "https://explorer.nervos.org/transaction/"
        : "https://testnet.explorer.nervos.org/transaction/";
    const netOf = (amount: bigint) =>
      amount - BigInt(info.feePathB.base) - (amount * BigInt(info.feePathB.ppm)) / 1_000_000n;

    /** Decides what to show for one payment, claiming it when that is safe. */
    async function describe(payment: PaymentInfo): Promise<{ tag: string; cls: string; text: string; link?: string }> {
      const claimed = claims[payment.paymentHash];
      switch (payment.state) {
        case "SETTLED":
          return { tag: "Received", cls: "ok", text: "In your wallet.", link: claimed };
        case "FAILED":
          return { tag: "Returned", cls: "bad", text: "Not collected in time. The payer got it back." };
        case "HELD":
        case "FORWARDING":
          return { tag: "Arrived", cls: "warn", text: "The LSP is preparing it for you." };
        case "CELL_PENDING":
          return { tag: "Arrived", cls: "warn", text: "Waiting for the chain to confirm it." };
      }
      if (claimed) {
        // The preimage is public from the moment the claim is sent, so the
        // claim must not be allowed to quietly drop out of the pool.
        const sent = await client.getTransaction(claimed).catch(() => undefined);
        const saved = store(claimTxKey(payment.paymentHash));
        if ((!sent || sent.status === "unknown" || sent.status === "rejected") && saved) {
          await client.sendTransaction(ccc.Transaction.fromBytes(saved)).catch(() => undefined);
          return { tag: "Claimed", cls: "warn", text: "Sending the claim again.", link: claimed };
        }
        return { tag: "Claimed", cls: "ok", text: "Collected. Finishing up.", link: claimed };
      }
      if (!payment.cell) {
        return { tag: payment.state, cls: "warn", text: payment.note ?? "" };
      }
      const preimage = preimages.get(payment.paymentHash);
      if (!preimage) {
        return { tag: "Unknown", cls: "bad", text: "This payment was not set up from this wallet." };
      }
      try {
        // Nothing the LSP reported is trusted here: the cell is read from the
        // chain and checked before the preimage leaves this page.
        const cell = await verifyClaimCell({
          client,
          deployment,
          outPoint: { txHash: payment.cell.txHash, index: payment.cell.index },
          entry: { preimage, hash: payment.paymentHash },
          hashAlgorithm: "ckb_hash",
          receiverLock: lock,
          minReceiverCapacity: netOf(BigInt(payment.amount)),
          minConfirmations,
          marginSeconds,
        });
        if (!claiming.has(payment.paymentHash)) {
          claiming.add(payment.paymentHash);
          const tx = buildClaimForVerifiedCell({
            deployment,
            cell,
            preimage,
            receiverLock: lock,
            refundLock: info.refundLock as ccc.ScriptLike,
          });
          store(claimTxKey(payment.paymentHash), ccc.hexFrom(tx.toBytes()));
          const txHash = await client.sendTransaction(tx);
          claims[payment.paymentHash] = txHash;
          store(claimsKey, JSON.stringify(claims));
          return { tag: "Claimed", cls: "ok", text: "Collected. Finishing up.", link: txHash };
        }
        return { tag: "Claiming", cls: "warn", text: "Sending the claim." };
      } catch (err) {
        claiming.delete(payment.paymentHash);
        const message = (err as Error).message;
        if (err instanceof ClaimCellRejected && /confirmations/.test(message)) {
          return { tag: "Confirming", cls: "warn", text: `Waiting for confirmations (${message.replace(/^claim cell has /, "")}).` };
        }
        if (err instanceof ClaimCellRejected && /expiry/.test(message)) {
          return { tag: "Too late", cls: "bad", text: "Too close to its deadline to collect safely. It goes back to the payer." };
        }
        return { tag: "Not claimed", cls: "bad", text: message };
      }
    }

    async function poll() {
      try {
        const result = await lsp<{ payments: PaymentInfo[]; registered: number; free: number }>(
          "list_payments",
          { receiver_id: receiverId },
          auth.token,
        );
        growPool(result.registered);
        if (result.free < 4) {
          const next = derivePool(seed!, scope, result.registered, BATCH, "ckb_hash");
          await lsp("add_hashes", { receiver_id: receiverId, hashes: next.map((e) => e.hash) }, auth.token);
          growPool(result.registered + BATCH);
        }
        const visible = result.payments.filter((p) => p.state !== "OPEN");
        empty.hidden = visible.length > 0;
        const rows: HTMLElement[] = [];
        for (const payment of visible) {
          const view = await describe(payment);
          const what = h("span", { class: "what" }, view.text);
          if (view.link) {
            what.append(" ", h("a", { href: explorer + view.link, target: "_blank", rel: "noreferrer" }, "View"));
          }
          rows.push(
            h(
              "div",
              { class: "pay", "data-hash": payment.paymentHash, "data-status": view.tag },
              h("span", { class: "amt" }, `${ccc.fixedPointToString(netOf(BigInt(payment.amount)))} CKB`),
              h("span", { class: `tag ${view.cls}` }, view.tag),
              what,
            ),
          );
        }
        list.replaceChildren(...rows);
      } catch (err) {
        status.className = "error";
        status.textContent = `Could not reach the LSP: ${(err as Error).message}`;
      }
      setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
  }
}
