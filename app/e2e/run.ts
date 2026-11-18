/**
 * End-to-end test of the receive page against real Fiber nodes and the CKB
 * public testnet.
 *
 * A headless browser opens the receive page as a wallet that has never held
 * any CKB and has no Fiber node. An ordinary Fiber node pays the invoice from
 * the pay page. The test passes when the page claims the payment by itself
 * and the money is in the wallet's address on L1.
 *
 * Usage (from app/, after `VITE_DEV_SIGNER=1 npx vite build --outDir dist-e2e`):
 *   TESTNET_PRIVATE_KEY=0x... NODE_USE_ENV_PROXY=1 npm run e2e
 */
import { ccc } from "../../lsp/src/ccc.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CKB, type Deployment, hashPreimage } from "../../lsp/src/claim.js";
import type { Hex } from "../../lsp/src/fiber.js";
import { AsyncReceiveLsp } from "../../lsp/src/lsp.js";
import { createLspServer } from "../../lsp/src/server.js";
import { startTestEnv, waitFor, WORK_DIR } from "../../lsp/src/testnet-env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "../dist-e2e");
const DEPLOYMENT_PATH = resolve(HERE, "../../e2e/deployment.testnet.json");
const REPORT_PATH = resolve(HERE, "../e2e-report.json");
const SCREENSHOT_PATH = resolve(HERE, "../../docs/receive-page.png");
const EXPLORER = "https://testnet.explorer.nervos.org/transaction/";
const LSP_PORT = 18300;
const APP_PORT = 18400;
const CKB_RPC = "http://127.0.0.1:18114/";
const HOUR = 3_600_000n;
const MINUTE = 60_000n;

// Playwright is installed globally in the test environment.
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("build the test bundle first: VITE_DEV_SIGNER=1 npx vite build --outDir dist-e2e");
  }
  const env = await startTestEnv(log);
  const { client, funder, nodes } = env;
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;

  const statePath = join(WORK_DIR, "lsp-state-webapp.json");
  rmSync(statePath, { force: true });
  const lsp = new AsyncReceiveLsp({
    fiber: nodes.lsp.rpc,
    client,
    signer: funder,
    deployment,
    statePath,
    currency: "Fibt",
    feePathA: { base: 0n, ppm: 1000n },
    feePathB: { base: 1n * CKB, ppm: 1000n },
    dFinalMs: 72n * HOUR,
    dMinMs: 160n * MINUTE,
    dRandMs: 4n * HOUR,
    dFwdMs: 4n * HOUR,
    deltaSettleMs: 24n * HOUR,
    tWakeMs: 20_000n,
    wMinMs: 6n * HOUR,
    deltaMarginMs: 1n * HOUR,
    minConfirmations: 4,
    invoiceExpirySeconds: 3600n,
    wake: async () => {},
    log: (message) => log(`lsp: ${message}`),
  });
  await lsp.init();
  const lspServer = createLspServer(lsp);
  await new Promise<void>((r) => lspServer.listen(LSP_PORT, "127.0.0.1", r));
  const ticker = setInterval(() => void lsp.tick(), 3000);

  const appServer = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const file = join(DIST, path === "/" ? "index.html" : path);
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));

  // The receiver: a brand-new key. No CKB, no channel, no Fiber node.
  const receiverKey = ccc.hexFrom(randomBytes(32));
  const receiverLock = (await new ccc.SignerCkbPrivateKey(client, receiverKey).getRecommendedAddressObj()).script;
  const balanceOf = async () => {
    let total = 0n;
    for await (const cell of client.findCellsByLock(receiverLock, null, true)) {
      total += cell.cellOutput.capacity;
    }
    return total;
  };
  check("receiver starts with nothing", (await balanceOf()) === 0n, "0 CKB on L1, no Fiber node");

  const browser = await chromium.launch();
  const receiveUrl =
    `http://127.0.0.1:${APP_PORT}/?lsp=${encodeURIComponent(`http://127.0.0.1:${LSP_PORT}`)}` +
    `&rpc=${encodeURIComponent(CKB_RPC)}&devkey=${receiverKey}`;
  const context = await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto(receiveUrl);
  await page.waitForSelector("#pay-link", { timeout: 60_000 });
  const link = (await page.textContent("#pay-link"))!.trim();
  check("receive page set itself up from one signature", /[?&]to=[0-9a-f]{32}/.test(link), link);

  // The payer opens the pay link, asks for an invoice, and pays it from an
  // ordinary Fiber node.
  const amount = 250n * CKB;
  const payPage = await context.newPage();
  await payPage.goto(link);
  await payPage.fill("#amount", "250");
  await payPage.click("#get-invoice");
  await payPage.waitForSelector("#invoice", { timeout: 30_000 });
  const invoice = (await payPage.textContent("#invoice"))!.trim();
  check("pay page produced a Fiber invoice", invoice.startsWith("fibt"), `${invoice.slice(0, 28)}…`);
  await payPage.close();

  // Right after a restart the channel may need a moment before it can route.
  const sent = await waitFor(
    "the payer's channel to be usable",
    () => nodes.payer.rpc.sendPayment({ invoice }),
    90_000,
    3000,
  );
  const paymentHash = sent.payment_hash as Hex;
  log(`payer sent ${paymentHash}`);

  // Watch what the receiver sees until the page has collected the money.
  const seen: string[] = [];
  const row = page.locator(`.pay[data-hash="${paymentHash}"]`);
  await waitFor(
    "the receive page to show the payment as received",
    async () => {
      const status = (await row.count()) ? await row.getAttribute("data-status") : null;
      if (status && seen.at(-1) !== status) {
        seen.push(status);
        log(`receive page: ${status}`);
      }
      return status === "Received";
    },
    15 * 60_000,
    2000,
  );
  check("page went from arrival to received by itself", seen.includes("Claimed") && seen.at(-1) === "Received", seen.join(" → "));

  const expected = amount - 1n * CKB - amount / 1000n;
  const balance = await waitFor("receiver balance on L1", async () => ((await balanceOf()) > 0n ? await balanceOf() : undefined), 120_000);
  check("money is in the receiver's own address on L1", balance === expected, `${ccc.fixedPointToString(balance)} CKB`);
  const record = lsp.getPayment(paymentHash)!;
  const claimNote = record.history.find((entry) => entry.state === "CLAIMED")?.note ?? "";
  const claimTx = claimNote.match(/0x[0-9a-f]{64}/)?.[0];
  check("claim is a public L1 transaction", !!claimTx, claimTx ? EXPLORER + claimTx : "not found");

  const paid = await waitFor(
    "payer payment to finish",
    async () => {
      const p = await nodes.payer.rpc.getPayment(paymentHash);
      return p.status === "Success" || p.status === "Failed" ? p : undefined;
    },
    180_000,
  );
  check("payer's payment succeeded", paid.status === "Success", `status ${paid.status}`);
  check(
    "payer holds the preimage for this payment",
    !!paid.payment_preimage && hashPreimage("ckb_hash", paid.payment_preimage) === paymentHash,
    `preimage ${paid.payment_preimage}`,
  );

  await page.waitForTimeout(1500);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  // A second device: fresh browser storage, same wallet. The page must land on
  // the same pay link and show the same history, with nothing restored by hand.
  const second = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const page2 = await second.newPage();
  await page2.goto(receiveUrl);
  await page2.waitForSelector("#pay-link", { timeout: 60_000 });
  const link2 = (await page2.textContent("#pay-link"))!.trim();
  check("a second device recovers the same pay link", link2 === link, link2);
  await page2.waitForSelector(`.pay[data-hash="${paymentHash}"][data-status="Received"]`, { timeout: 60_000 });
  check("a second device shows the received payment", true, "history restored from the wallet alone");
  check("no script errors on the page", pageErrors.length === 0, pageErrors.join("; ") || "none");

  clearInterval(ticker);
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        network: "ckb-testnet",
        finishedAt: new Date().toISOString(),
        claimLock: deployment,
        claimTransaction: claimTx ? EXPLORER + claimTx : undefined,
        whatTheReceiverSaw: seen,
        passed: checks.length - failed.length,
        failed: failed.length,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  log(`${checks.length - failed.length}/${checks.length} checks passed; report written to ${REPORT_PATH}`);
  await browser.close();
  lspServer.close();
  appServer.close();
  env.stop();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
