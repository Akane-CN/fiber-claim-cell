/**
 * Test environment: three Fiber nodes (payer, LSP, receiver) running locally
 * against the CKB public testnet, with channels payer → LSP and LSP → receiver.
 *
 * State lives in FIBER_E2E_DIR and is reused across runs, so the on-chain
 * funding and channel opening only happen once.
 */
import { ccc } from "@ckb-ccc/core";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { CKB } from "./claim.js";
import { FiberRpc, toHex } from "./fiber.js";

export const WORK_DIR = process.env.FIBER_E2E_DIR ?? "/home/user/.fiber-e2e";
const FNN_BIN = process.env.FNN_BIN ?? "/home/user/.fiber-target/release/fnn";
const FNN_CONFIG_TEMPLATE =
  process.env.FNN_CONFIG_TEMPLATE ??
  "/tmp/claude-0/-home-user-finance-ledger/6d967c7a-dc3c-51c8-b34f-abaa49cd3ebc/scratchpad/fiber-src/config/testnet/config.yml";
const CKB_RPC_UPSTREAM = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
const FORWARDER_PORT = 18114;

export type NodeName = "payer" | "lsp" | "receiver" | "watchtower";
const PORTS: Record<NodeName, { p2p: number; rpc: number }> = {
  payer: { p2p: 18228, rpc: 18227 },
  lsp: { p2p: 18238, rpc: 18237 },
  receiver: { p2p: 18248, rpc: 18247 },
  watchtower: { p2p: 18258, rpc: 18257 },
};
export const rpcUrl = (name: NodeName) => `http://127.0.0.1:${PORTS[name].rpc}`;
/** Testnet CKB each node's wallet should hold before channels are opened. */
const WALLET_TARGET: Record<NodeName, bigint> = {
  payer: 1300n * CKB,
  lsp: 900n * CKB,
  receiver: 300n * CKB,
  // The watchtower pays the fees of the transactions it sends.
  watchtower: 300n * CKB,
};
const CHANNEL_FUNDING = { payerToLsp: 1000n * CKB, lspToReceiver: 600n * CKB };

export type Channel = {
  channel_id: string;
  pubkey?: string;
  peer_id?: string;
  state: { state_name: string; state_flags?: unknown };
  local_balance: string;
  remote_balance: string;
  enabled?: boolean;
};

export type FiberNode = {
  name: NodeName;
  rpc: FiberRpc;
  pubkey: string;
  address: string;
  process?: ChildProcess;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  intervalMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ""}`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * fnn's HTTP client does not go through this sandbox's egress proxy, so the
 * nodes talk to a local plain-HTTP port that relays to the testnet RPC.
 */
export function startCkbRpcForwarder(): Promise<Server> {
  // A browser page on another origin may call this relay too.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const upstream = await fetch(CKB_RPC_UPSTREAM, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, { "content-type": "application/json", ...cors });
        response.end(body);
      } catch (err) {
        response.writeHead(502, cors);
        response.end(String(err));
      }
    });
  });
  return new Promise((resolve) => server.listen(FORWARDER_PORT, "127.0.0.1", () => resolve(server)));
}

type Keys = Record<NodeName, ccc.Hex>;

function loadKeys(): Keys {
  const path = join(WORK_DIR, "keys.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Keys;
  }
  const keys: Keys = {
    payer: ccc.hexFrom(randomBytes(32)),
    lsp: ccc.hexFrom(randomBytes(32)),
    receiver: ccc.hexFrom(randomBytes(32)),
    watchtower: ccc.hexFrom(randomBytes(32)),
  };
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function writeNodeConfig(name: NodeName, key: ccc.Hex, standaloneWatchtower = false) {
  const dir = join(WORK_DIR, name);
  mkdirSync(join(dir, "ckb"), { recursive: true });
  const keyPath = join(dir, "ckb", "key");
  if (!existsSync(keyPath)) {
    // fnn encrypts this file in place on first start.
    writeFileSync(keyPath, key.slice(2) + "\n", { mode: 0o600 });
  }
  const ports = PORTS[name];
  const config = readFileSync(FNN_CONFIG_TEMPLATE, "utf8")
    .replace('"/ip4/0.0.0.0/tcp/8228"', `"/ip4/127.0.0.1/tcp/${ports.p2p}"`)
    // No bootnodes: the three nodes only ever talk to each other.
    .replace(/bootnode_addrs:\n(\s+- "\/ip4[^\n]*\n)+/, "bootnode_addrs: []\n")
    .replace('"127.0.0.1:8227"', `"127.0.0.1:${ports.rpc}"`)
    .replace(/rpc_url: "[^"]*"/, `rpc_url: "http://127.0.0.1:${FORWARDER_PORT}/"`)
    // The LSP hands its channel data to a watchtower in another process and
    // runs none of its own, so that stopping the LSP stops nothing else.
    .replace(
      /^fiber:\n/m,
      standaloneWatchtower
        ? `fiber:\n  standalone_watchtower_rpc_url: "${rpcUrl("watchtower")}"\n  disable_built_in_watchtower: true\n`
        : "fiber:\n",
    );
  writeFileSync(join(dir, "config.yml"), config);
  return dir;
}

/** Kills a node's process, however it was started, and waits until it is gone. */
export async function stopNode(name: NodeName) {
  spawnSync("pkill", ["-f", `fnn -c ${join(WORK_DIR, name, "config.yml")}`]);
  const rpc = new FiberRpc(rpcUrl(name));
  await waitFor(`${name} to stop`, () => rpc.nodeInfo().then(() => false, () => true), 60_000, 500);
}

export async function startNode(name: NodeName, dir = join(WORK_DIR, name)): Promise<FiberNode> {
  const rpc = new FiberRpc(`http://127.0.0.1:${PORTS[name].rpc}`);
  let child: ChildProcess | undefined;
  const alreadyUp = await rpc.nodeInfo().then(
    () => true,
    () => false,
  );
  if (!alreadyUp) {
    const log = openSync(join(dir, "fnn.log"), "a");
    child = spawn(FNN_BIN, ["-c", join(dir, "config.yml"), "-d", dir], {
      env: {
        ...process.env,
        FIBER_SECRET_KEY_PASSWORD: "fiber-lsp-e2e",
        RUST_LOG: process.env.FNN_LOG ?? "info",
      },
      stdio: ["ignore", log, log],
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`fnn ${name} exited with code ${code}; see ${join(dir, "fnn.log")}`);
      }
    });
  }
  const info = await waitFor(`${name} RPC`, () => rpc.nodeInfo(), 120_000, 1000);
  const address =
    info.addresses.find((a) => a.includes("/p2p/")) ??
    `/ip4/127.0.0.1/tcp/${PORTS[name].p2p}`;
  return { name, rpc, pubkey: info.pubkey, address, process: child };
}

export async function listChannels(node: FiberNode, peerPubkey?: string): Promise<Channel[]> {
  const result = await node.rpc.call<{ channels: Channel[] }>(
    "list_channels",
    peerPubkey ? { pubkey: peerPubkey } : {},
  );
  return result.channels;
}

const isReady = (channel: Channel) => /READY/i.test(channel.state.state_name);

export async function connectPeers(from: FiberNode, to: FiberNode) {
  const connected = async () => {
    const peers = await from.rpc.call<{ peers: { pubkey: string }[] }>("list_peers");
    return peers.peers.some((p) => p.pubkey === to.pubkey);
  };
  if (!(await connected())) {
    await from.rpc.call("connect_peer", { address: to.address });
    await waitFor(`${from.name} connected to ${to.name}`, connected, 60_000, 1000);
  }
}

async function ensureChannel(
  from: FiberNode,
  to: FiberNode,
  fundingAmount: bigint,
  log: (message: string) => void,
) {
  // After a restart the nodes do not find each other again by themselves, and
  // a channel cannot carry a payment until its peer is connected.
  const connected = async () => {
    const peers = await from.rpc.call<{ peers: { pubkey: string }[] }>("list_peers");
    return peers.peers.some((p) => p.pubkey === to.pubkey);
  };
  if (!(await connected())) {
    await from.rpc.call("connect_peer", { address: to.address });
    await waitFor(`${from.name} connected to ${to.name}`, connected, 60_000, 1000);
  }
  const existing = (await listChannels(from, to.pubkey)).find(isReady);
  if (existing) {
    log(`channel ${from.name} → ${to.name} already open (${existing.channel_id.slice(0, 10)}…)`);
    return;
  }
  const pending = await listChannels(from, to.pubkey);
  if (pending.length === 0) {
    await from.rpc.call("open_channel", {
      pubkey: to.pubkey,
      funding_amount: toHex(fundingAmount),
      public: true,
    });
    log(`opening channel ${from.name} → ${to.name} with ${fundingAmount / CKB} CKB`);
  }
  await waitFor(
    `channel ${from.name} → ${to.name} ready`,
    async () => (await listChannels(from, to.pubkey)).some(isReady),
    15 * 60_000,
    5000,
  );
  log(`channel ${from.name} → ${to.name} ready`);
}

/**
 * Every run moves balance one way, from the payer towards the receiver. When
 * `to` has run low, `from` pays most of its side of their channel back.
 */
async function rebalance(from: FiberNode, to: FiberNode, floor: bigint, log: (message: string) => void) {
  const side = async () => {
    const channels = (await listChannels(to, from.pubkey)).filter(isReady);
    return {
      local: channels.reduce((sum, c) => sum + BigInt(c.local_balance), 0n),
      remote: channels.reduce((sum, c) => sum + BigInt(c.remote_balance), 0n),
    };
  };
  const { local, remote } = await side();
  const amount = remote - 100n * CKB;
  if (local >= floor || amount <= 0n) {
    return;
  }
  const preimage = ccc.hexFrom(randomBytes(32));
  const invoice = await to.rpc.newInvoice({ amount, paymentPreimage: preimage, hashAlgorithm: "ckb_hash", currency: "Fibt" });
  await waitFor(`${from.name} to be able to pay ${to.name}`, () => from.rpc.sendPayment({ invoice: invoice.invoice_address }), 120_000, 3000);
  await waitFor(`${to.name} to be topped up`, async () => (await side()).local >= floor, 120_000, 2000);
  log(`rebalanced: ${from.name} paid ${amount / CKB} CKB back to ${to.name}`);
}

export type TestEnv = {
  client: ccc.Client;
  /** The funded testnet key; also the LSP's L1 wallet for claim cells. */
  funder: ccc.SignerCkbPrivateKey;
  nodes: Record<NodeName, FiberNode>;
  stop: () => void;
};

export async function startTestEnv(
  log: (message: string) => void,
  /** With a watchtower: payer, LSP and a standalone watchtower for the LSP; no receiver node. */
  options: { watchtower?: boolean } = {},
): Promise<TestEnv> {
  const funderKey = process.env.TESTNET_PRIVATE_KEY;
  if (!funderKey) {
    throw new Error("TESTNET_PRIVATE_KEY is not set");
  }
  mkdirSync(WORK_DIR, { recursive: true });
  const forwarder = await startCkbRpcForwarder();
  const client = new ccc.ClientPublicTestnet({ url: CKB_RPC_UPSTREAM });
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  log(`funder balance: ${ccc.fixedPointToString(await funder.getBalance())} CKB`);

  // Top up each node's wallet in one transaction.
  const keys = loadKeys();
  const names: NodeName[] = options.watchtower
    ? ["watchtower", "payer", "lsp"]
    : ["payer", "lsp", "receiver"];
  const topUps: { lock: ccc.Script; capacity: bigint }[] = [];
  for (const name of names) {
    const wallet = new ccc.SignerCkbPrivateKey(client, keys[name]);
    const balance = await wallet.getBalance();
    const channelsDir = existsSync(join(WORK_DIR, name, "fiber"));
    if (!channelsDir && balance < WALLET_TARGET[name]) {
      topUps.push({
        lock: (await wallet.getRecommendedAddressObj()).script,
        capacity: WALLET_TARGET[name] - balance,
      });
    }
  }
  if (topUps.length > 0) {
    const tx = ccc.Transaction.from({ outputs: topUps });
    await tx.completeInputsByCapacity(funder);
    await tx.completeFeeBy(funder, 1000n);
    const txHash = await funder.sendTransaction(tx);
    log(`funding node wallets: ${txHash}`);
    await client.waitTransaction(txHash, 1, 600_000, 3000);
  }

  const nodes = {} as Record<NodeName, FiberNode>;
  for (const name of names) {
    nodes[name] = await startNode(
      name,
      writeNodeConfig(name, keys[name], !!options.watchtower && name === "lsp"),
    );
    log(`${name} node up: ${nodes[name].pubkey.slice(0, 16)}… at ${nodes[name].address}`);
  }

  await ensureChannel(nodes.payer, nodes.lsp, CHANNEL_FUNDING.payerToLsp, log);
  if (!options.watchtower) {
    await ensureChannel(nodes.lsp, nodes.receiver, CHANNEL_FUNDING.lspToReceiver, log);
    await rebalance(nodes.lsp, nodes.payer, 500n * CKB, log);
    await rebalance(nodes.receiver, nodes.lsp, 300n * CKB, log);
  }

  return {
    client,
    funder,
    nodes,
    stop: () => {
      for (const node of Object.values(nodes)) {
        node.process?.kill("SIGTERM");
      }
      forwarder.close();
    },
  };
}
