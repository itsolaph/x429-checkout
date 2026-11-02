// Smoke test of the examples on a local anvil fork of Base (real USDC code, nothing sent to Base):
// deploy with the package CLI, start each example, push it past capacity and check the 429, the x429
// descriptor and the 402 skip offer. Fork source: E2E_RPC_URL, else the first public Base RPC that
// answers; the test is skipped (with the reason) when none does or anvil is missing.
//
//   npm run build:x429 && node --test examples/smoke.test.ts
//   SMOKE_NODE=<node binary> runs the examples and the CLI on that Node (e.g. 20)
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { freePort, KEYS, pay, unb64 } from "../packages/x429/test/helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages/x429/bin/x429.js");
/** The Node binary that runs the examples and the CLI (e.g. a Node 20 build to check the engines range). */
const NODE = process.env.SMOKE_NODE || process.execPath;
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FORK_BLOCK = process.env.E2E_FORK_BLOCK ?? "52621900";

async function forkSource(): Promise<string | undefined> {
  const candidates = process.env.E2E_RPC_URL ? [process.env.E2E_RPC_URL] : ["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(8_000) });
      if (((await res.json()) as { result?: string }).result === "0x2105") return url;
    } catch {
      // next
    }
  }
  return undefined;
}

let skip: string | undefined;
let anvil: ChildProcess | undefined;
let rpc = "";
let client: PublicClient;
let keyFile = "";
let contract: Address;
let deployBlock = "0";
const procs: ChildProcess[] = [];

const rpcCall = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });

function x429(args: string[]) {
  const r = spawnSync(NODE, [BIN, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`x429 ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

before(async () => {
  if (spawnSync("anvil", ["--version"], { stdio: "ignore" }).status !== 0) return void (skip = "anvil not on PATH");
  const source = await forkSource();
  if (!source) return void (skip = "no Base RPC answered (set E2E_RPC_URL)");
  const port = await freePort();
  rpc = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--fork-url", source, "--fork-block-number", FORK_BLOCK, "--port", String(port), "--silent"], { stdio: "ignore" });
  const chain = { ...base, rpcUrls: { default: { http: [rpc] } } };
  client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  for (let i = 0; i < 240; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // fork clock to now (x402 authorization windows are wall clock); well-known test accounts get no code
  await rpcCall("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
  await rpcCall("evm_mine", []);
  const operator = privateKeyToAccount(KEYS[0]!);
  for (const k of [KEYS[0]!, KEYS[3]!, KEYS[4]!]) await rpcCall("anvil_setCode", [privateKeyToAccount(k).address, "0x"]);
  await rpcCall("anvil_setBalance", [operator.address, "0x56BC75E2D63100000"]);

  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "x429-smoke-"));
  keyFile = join(dir, "operator.key");
  writeFileSync(keyFile, `${KEYS[0]}\n`, { mode: 0o600 });
  // chain id 8453: the CLI wants --yes even on a fork
  const d = x429(["deploy", "--rpc", rpc, "--key-file", keyFile, "--yes"]);
  contract = d.match(/X429_CONTRACT=(0x[0-9a-fA-F]{40})/)![1] as Address;
  deployBlock = d.match(/X429_DEPLOY_BLOCK=(\d+)/)![1]!;

  // forked USDC for two payers, minted through a minter set by USDC's real masterMinter
  const usdcAbi = parseAbi(["function masterMinter() view returns (address)", "function configureMinter(address,uint256)", "function mint(address,uint256)"]);
  const master = await client.readContract({ address: USDC, abi: usdcAbi, functionName: "masterMinter" });
  await rpcCall("anvil_impersonateAccount", [master]);
  await rpcCall("anvil_setBalance", [master, "0xDE0B6B3A7640000"]);
  const asMaster = createWalletClient({ account: master, chain, transport: http(rpc) });
  await client.waitForTransactionReceipt({ hash: await asMaster.writeContract({ address: USDC, abi: usdcAbi, functionName: "configureMinter", args: [operator.address, 10_000_000n] }) });
  await rpcCall("anvil_stopImpersonatingAccount", [master]);
  const asOperator = createWalletClient({ account: operator, chain, transport: http(rpc) });
  for (const k of [KEYS[3]!, KEYS[4]!]) {
    await client.waitForTransactionReceipt({ hash: await asOperator.writeContract({ address: USDC, abi: usdcAbi, functionName: "mint", args: [privateKeyToAccount(k).address, 1_000_000n] }) });
  }
});

after(() => {
  for (const p of procs) p.kill();
  anvil?.kill();
});

async function start(example: string, queueId: number): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const p = spawn(NODE, [join(ROOT, "examples", example, "server.mjs")], {
    cwd: join(ROOT, "examples", example),
    env: { ...process.env, PORT: String(port), X429_RPC_URL: rpc, X429_CONTRACT: contract, X429_QUEUE_ID: String(queueId), X429_OPERATOR_KEY_FILE: keyFile, X429_DEPLOY_BLOCK: deployBlock, X429_PER_INTERVAL_MS: "30000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(p);
  let log = "";
  p.stdout!.on("data", (c) => (log += c));
  p.stderr!.on("data", (c) => (log += c));
  for (let i = 0; i < 120 && !log.includes('"evt":"listening"'); i++) {
    if (p.exitCode !== null) throw new Error(`${example} exited: ${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(log.includes('"evt":"listening"'), `${example} did not start: ${log}`);
  return url;
}

for (const example of ["express-basic", "hono-basic"]) {
  test(`${example}: past capacity it answers 429 with the x429 offer, the descriptor and the 402 skip offer`, { skip: skip ?? false, timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const queueId = Number(x429(["queue", "create", "--rpc", rpc, "--key-file", keyFile, "--contract", contract, "--fee-bps", "300", "--join-fee", "0.001", "--meta", `{"name":"${example}"}`, "--yes"]).match(/X429_QUEUE_ID=(\d+)/)![1]);
    const url = await start(example, queueId);

    const idle = await fetch(`${url}/forecast?city=Paris`);
    assert.equal(idle.status, 200, "an idle API answers directly");
    assert.equal(((await idle.json()) as { via: string }).via, "direct");

    const busy = await fetch(`${url}/forecast?city=Paris`);
    assert.equal(busy.status, 429, "the next request in the same interval is over capacity");
    const empty = (await busy.json()) as { error: string; descriptor: string; skip: unknown };
    assert.equal(empty.error, "too_many_requests");
    assert.equal(empty.descriptor, `${url}/x429`);
    assert.equal(empty.skip, null, "nobody waits yet, so there is nothing to skip");

    // someone joins the line (a paid x402 join), so the 429 can price a skip
    const payer = privateKeyToAccount((example === "express-basic" ? KEYS[3] : KEYS[4]) as Hex);
    const joined = await pay(url, "/x429/join", { skipPrice: "5000" }, payer, 8453);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.position, 1);

    const offer = await fetch(`${url}/forecast?city=Paris`);
    assert.equal(offer.status, 429);
    const b = (await offer.json()) as any;
    assert.equal(b.position, 2);
    assert.equal(b.queueLength, 1);
    assert.equal(b.skip.targetPosition, 1);
    assert.equal(b.skip.cost, "5150", "0.005 to the agent waiting plus the 3% fee");
    assert.equal(b.skip.url, `${url}/x429/skip`);
    assert.equal(b.skip.method, "POST");
    assert.equal(offer.headers.get("x-429-skip-cost"), "5150");
    assert.equal(offer.headers.get("x-429-position"), "2");
    assert.ok(Number(offer.headers.get("retry-after")) >= 1);

    const d = (await (await fetch(`${url}/x429`)).json()) as any;
    assert.equal(d.version, "0.3");
    assert.equal(d.network, "eip155:8453");
    assert.equal(d.contract, contract);
    assert.equal(d.queueId, queueId);
    assert.equal(d.asset, USDC);
    assert.equal(d.skip.toFront.cost, "5150");

    const pr = await fetch(`${url}/x429/skip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: 1 }) });
    assert.equal(pr.status, 402);
    const v1 = (await pr.json()) as any;
    assert.equal(v1.x402Version, 1);
    assert.equal(v1.accepts[0].scheme, "exact");
    assert.equal(v1.accepts[0].network, "base");
    assert.equal(v1.accepts[0].asset, USDC);
    assert.equal(v1.accepts[0].payTo, contract);
    assert.equal(v1.accepts[0].maxAmountRequired, "6180", "the cost plus the 20% ceiling, the rest refunded");
    const v2 = unb64(pr.headers.get("payment-required"));
    assert.equal(v2.accepts[0].network, "eip155:8453");
    assert.equal(v2.accepts[0].amount, "6180");
  });
}
