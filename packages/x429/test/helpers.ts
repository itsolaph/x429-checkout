// Test helpers: a plain local anvil (no fork, no network), MockUSDC (EIP-3009) from the repo's forge
// build, X429Checkout deployed through the package's own CLI, x402 payments signed like a wallet, and
// one HTTP server per adapter. Nothing here touches a public chain.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { main } from "../dist/cli.js";
import type { Lane } from "x429";
import { x429Node } from "x429/node";
import { x429Express } from "x429/express";
import { x429Hono } from "x429/hono";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "../../..");
const MOCK_ARTIFACT = join(REPO, "contracts/out/MockUSDC.sol/MockUSDC.json");

/** anvil's well-known test keys (public, local only). */
export const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
];

export const anvilAvailable = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(MOCK_ARTIFACT);
export const skipReason = anvilAvailable ? undefined : "needs anvil on PATH and the forge build (forge build --root contracts)";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

export type Chain = {
  rpc: string;
  proc: ChildProcess;
  client: PublicClient;
  usdc: Address;
  contract: Address;
  queueId: number;
  deployBlock: bigint;
  operatorKey: Hex;
  keyFile: string;
  dir: string;
  stop(): void;
};

const mockAbi = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);

export async function cli(args: string[], env: Record<string, string | undefined> = {}, cwd = process.cwd()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Starts anvil, deploys MockUSDC and (through the CLI) X429Checkout + queue 1, funds payers 3..7. */
export async function startChain(opts: { feeBps?: number; joinFee?: string; chainId?: number; deploy?: boolean } = {}): Promise<Chain> {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const proc = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", String(opts.chainId ?? 31337)], { stdio: "ignore" });
  const client = createPublicClient({ chain: { ...foundry, id: opts.chainId ?? 31337 }, transport: http(rpc), pollingInterval: 100 }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "x429-pkg-"));
  const keyFile = join(dir, "operator.key");
  writeFileSync(keyFile, `${KEYS[0]}\n`, { mode: 0o600 });
  const deployer = createWalletClient({ account: privateKeyToAccount(KEYS[0]!), chain: { ...foundry, id: opts.chainId ?? 31337 }, transport: http(rpc) });
  const artifact = JSON.parse(readFileSync(MOCK_ARTIFACT, "utf8"));
  const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex, args: [] });
  const usdc = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
  for (const k of KEYS.slice(3)) {
    const h = await deployer.writeContract({ address: usdc, abi: mockAbi, functionName: "mint", args: [privateKeyToAccount(k).address, 5_000_000n] });
    await client.waitForTransactionReceipt({ hash: h });
  }
  const chain: Chain = { rpc, proc, client, usdc, contract: "0x" as Address, queueId: 0, deployBlock: 0n, operatorKey: KEYS[0]!, keyFile, dir, stop: () => proc.kill() };
  if (opts.deploy === false) return chain;
  const d = await cli(["deploy", "--rpc", rpc, "--key-file", keyFile, "--usdc", usdc]);
  if (d.code !== 0) throw new Error(`deploy failed: ${d.err}`);
  chain.contract = d.out.match(/X429_CONTRACT=(0x[0-9a-fA-F]{40})/)![1] as Address;
  chain.deployBlock = BigInt(d.out.match(/X429_DEPLOY_BLOCK=(\d+)/)![1]!);
  const q = await cli(["queue", "create", "--rpc", rpc, "--key-file", keyFile, "--contract", chain.contract, "--fee-bps", String(opts.feeBps ?? 300), "--join-fee", opts.joinFee ?? "0.001", "--meta", '{"name":"test api"}']);
  if (q.code !== 0) throw new Error(`queue create failed: ${q.err}`);
  chain.queueId = Number(q.out.match(/X429_QUEUE_ID=(\d+)/)![1]);
  return chain;
}

export async function balance(chain: Chain, who: Address): Promise<bigint> {
  return chain.client.readContract({ address: chain.usdc, abi: mockAbi, functionName: "balanceOf", args: [who] });
}

const transferWithAuthorization = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const unb64 = (v: string | null) => (v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null);

/** Signs an EIP-3009 authorization for `value` to `to`, as a wallet does for x402 `exact`. */
export async function sign(account: PrivateKeyAccount, chainId: number, usdc: Address, to: Address, value: bigint) {
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
  const authorization = { from: account.address, to, value, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce };
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId, verifyingContract: usdc },
    types: transferWithAuthorization,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  return {
    signature,
    authorization: { ...authorization, value: value.toString(), validAfter: "0", validBefore: authorization.validBefore.toString() },
  };
}

/** The x402 round trip: 402 → sign the asked amount → the paid request. */
export async function pay(base: string, path: string, body: unknown, account: PrivateKeyAccount, chainId: number, version: 1 | 2 = 1) {
  const url = `${base}${path}`;
  const init = { method: "POST", headers: { "content-type": "application/json" } as Record<string, string>, body: JSON.stringify(body) };
  const first = await fetch(url, init);
  const offer = (await first.json()) as { accepts: { maxAmountRequired: string; asset: Address; payTo: Address; network: string }[] };
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${JSON.stringify(offer)}`);
  const v2 = unb64(first.headers.get("payment-required"));
  const req = offer.accepts[0]!;
  const payload = await sign(account, chainId, req.asset, req.payTo, BigInt(req.maxAmountRequired));
  const header: Record<string, string> =
    version === 1
      ? { "x-payment": b64({ x402Version: 1, scheme: "exact", network: req.network, payload }) }
      : { "payment-signature": b64({ x402Version: 2, resource: v2.resource, accepted: v2.accepts[0], payload }) };
  const send = () => fetch(url, { ...init, headers: { ...init.headers, ...header } });
  const t0 = Date.now();
  const res = await send();
  const text = await res.text();
  /** Sends the very same paid request again (same payment). */
  const retry = async () => {
    const r = await send();
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  return { status: res.status, body: JSON.parse(text) as any, text, headers: res.headers, ms: Date.now() - t0, offer, v2, retry };
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

export type Apps = { node: string; express: string; hono: string; close(): Promise<void> };

/**
 * One protected endpoint (`/api/data`) and the lane routes, served by each adapter. The handler
 * answers `{ ok, via, ticketId }` and, with `?hold=<ms>`, waits that long first (concurrency tests).
 */
export async function adapterApps(lane: Lane): Promise<Apps> {
  const answer = (via: string, ticketId?: bigint) => JSON.stringify({ ok: true, via, ticketId: ticketId?.toString() ?? null });
  const hold = (url: string) => Number(new URL(url, "http://x").searchParams.get("hold") ?? 0);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const nodeServer = createServer(
    x429Node(lane, async (req, res, d) => {
      await wait(hold(req.url ?? "/"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer(d.via, d.admission?.ticketId));
    }, { protect: (req) => (req.url ?? "").startsWith("/api/") }),
  );

  const { default: express } = await import("express");
  const ex = express();
  ex.disable("x-powered-by");
  const mw = x429Express(lane);
  if (lane.cfg.prefix) ex.use(lane.cfg.prefix, mw);
  // after the lane routes, so invalid JSON sent to them gets the lane's own 400
  ex.use(express.json());
  ex.get("/api/data", mw, async (req, res) => {
    await wait(hold(req.originalUrl));
    const d = (req as unknown as { x429: { via: string; admission?: { ticketId: bigint } } }).x429;
    res.type("application/json").send(answer(d.via, d.admission?.ticketId));
  });
  const expressServer = createServer(ex);

  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const app = new Hono<{ Variables: { x429: { via: string; admission?: { ticketId: bigint } } } }>();
  const hmw = x429Hono(lane) as never;
  if (lane.cfg.prefix) app.use(`${lane.cfg.prefix}/*`, hmw); // also matches the bare prefix (the descriptor)
  app.use("/api/*", hmw);
  app.get("/api/data", async (c) => {
    await wait(hold(c.req.url));
    const d = c.get("x429");
    return c.body(answer(d.via, d.admission?.ticketId), 200, { "content-type": "application/json" });
  });
  const honoPort = await freePort();
  const honoServer = serve({ fetch: app.fetch, port: honoPort, hostname: "127.0.0.1" }) as unknown as Server;

  const [node, expressUrl] = [await listen(nodeServer), await listen(expressServer)];
  return {
    node,
    express: expressUrl,
    hono: `http://127.0.0.1:${honoPort}`,
    close: async () => {
      for (const s of [nodeServer, expressServer, honoServer]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(() => r(undefined)));
      }
    },
  };
}

/** Response headers without the ones the transport or the framework adds on its own. */
export function laneHeaders(h: globalThis.Headers): Record<string, string> {
  const skip = new Set(["date", "connection", "keep-alive", "content-length", "transfer-encoding"]);
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!skip.has(k)) out[k] = v;
  });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, headers: laneHeaders(res.headers), text, json: text ? JSON.parse(text) : undefined };
}

/** A fresh queue on the chain's contract (an empty line per test). */
export async function newQueue(chain: Chain, feeBps = 300): Promise<number> {
  const q = await cli(["queue", "create", "--rpc", chain.rpc, "--key-file", chain.keyFile, "--contract", chain.contract, "--fee-bps", String(feeBps), "--join-fee", "0.001"]);
  if (q.code !== 0) throw new Error(q.err);
  return Number(q.out.match(/X429_QUEUE_ID=(\d+)/)![1]);
}
