// Options are validated with errors that name the option; the operator key never shows up in an
// error, a log entry, the config or an inspected Lane.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { x429, OptionsError, type X429Options } from "x429";
import { resolveOptions } from "../dist/config.js";
import { resolveBazaar } from "../dist/bazaar.js";
import { KEYS, adapterApps, pay, skipReason, startChain, type Chain } from "./helpers.ts";

const base: X429Options = {
  contract: "0x1B70dcDC800a0B18c7a3100a9833FA4e923044C1",
  rpcUrl: "http://127.0.0.1:8545",
  publicUrl: "https://api.example.com",
  capacity: { perIntervalMs: 15_000 },
};
const SECRET = KEYS[1]!;

function rejects(o: unknown, re: RegExp) {
  assert.throws(() => resolveOptions(o as X429Options), (err: Error) => {
    assert.ok(err instanceof OptionsError, `OptionsError, got ${err?.constructor?.name}`);
    assert.match(err.message, re);
    assert.ok(!err.message.includes(SECRET.slice(2)), "the key is never echoed");
    return true;
  });
}

test("defaults: prefix /x429, Base, queue 1, interval model, key kept out of the config", () => {
  const { cfg, operatorKey } = resolveOptions({ ...base, operatorKey: SECRET });
  assert.equal(cfg.prefix, "/x429");
  assert.equal(cfg.routeBase, "https://api.example.com/x429");
  assert.equal(cfg.descriptorUrl, "https://api.example.com/x429");
  assert.equal(cfg.chainId, 8453);
  assert.equal(cfg.usdc, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(cfg.queueId, 1);
  assert.deepEqual(cfg.capacity, { model: "interval", perIntervalMs: 15_000 });
  assert.equal(cfg.minQueueMs, 15_000);
  assert.equal(cfg.suggestedSkipPrice, 5_000n);
  assert.equal(cfg.maxSkipPrice, 100_000n);
  assert.equal(operatorKey, SECRET);
  assert.ok(!JSON.stringify(cfg, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Set ? [...v] : v)).includes(SECRET.slice(2)));
  const root = resolveOptions({ ...base, prefix: "" }).cfg;
  assert.equal(root.routeBase, "https://api.example.com");
  assert.equal(root.descriptorUrl, "https://api.example.com/x429", "at the root the descriptor stays at /x429");
  const c = resolveOptions({ ...base, capacity: { concurrency: 4 } }).cfg;
  assert.deepEqual(c.capacity, { model: "concurrency", concurrency: 4, estimateMs: 1_000 });
  assert.equal(c.serviceIntervalMs, 250);
});

test("bad options fail with the option's name", () => {
  rejects({ ...base, contract: "0x123" }, /contract must be an 0x address/);
  rejects({ ...base, contract: undefined }, /contract must be an 0x address/);
  rejects({ ...base, rpcUrl: "ws://x" }, /rpcUrl must be an http\(s\) URL/);
  rejects({ ...base, publicUrl: "https://api.example.com/v1" }, /publicUrl must be an origin without a path/);
  rejects({ ...base, capcity: {} }, /unknown option "capcity"/);
  rejects({ ...base, capacity: undefined }, /capacity must be/);
  rejects({ ...base, capacity: {} }, /exactly one of perIntervalMs or concurrency/);
  rejects({ ...base, capacity: { perIntervalMs: 1000, concurrency: 2 } }, /exactly one of perIntervalMs or concurrency/);
  rejects({ ...base, capacity: { concurrency: 0 } }, /capacity\.concurrency must be an integer from 1/);
  rejects({ ...base, capacity: { perIntervalMs: 10, estimateMs: 5 } }, /estimateMs only applies/);
  rejects({ ...base, capacity: { perIntervalMs: 10, burst: 5 } }, /capacity\.burst is not an option/);
  rejects({ ...base, prefix: "x429" }, /prefix must be/);
  rejects({ ...base, prefix: "/x429/" }, /prefix must be/);
  rejects({ ...base, queueId: 0 }, /queueId must be an integer from 1/);
  rejects({ ...base, slippageBps: -1 }, /slippageBps/);
  rejects({ ...base, suggestedSkipPrice: "1", maxSkipPrice: "0.5" }, /suggestedSkipPrice must not be above maxSkipPrice/);
  rejects({ ...base, maxSkipPrice: "abc" }, /maxSkipPrice must be a USDC amount/);
  rejects({ ...base, demoAgents: ["nope"] }, /demoAgents\[0\] must be an 0x address/);
  rejects({ ...base, serve: "yes" }, /serve must be a function/);
  rejects({ ...base, validate: {} }, /validate must be a function/);
  rejects({ ...base, autoPayout: "1" }, /autoPayout must be true or false/);
  rejects({ ...base, logsRpcUrls: ["ftp://x"] }, /logsRpcUrls\[0\]/);
});

test("key errors never echo the key", () => {
  rejects({ ...base, operatorKey: `${SECRET}00` }, /the operator key must be 32 bytes of hex/);
  rejects({ ...base, operatorKey: SECRET.slice(0, 40) }, /32 bytes of hex/);
  rejects({ ...base, operatorKey: SECRET, operatorKeyFile: "/tmp/k" }, /not both/);
  rejects({ ...base, operatorKeyFile: "/nonexistent/x429.key" }, /cannot read operatorKeyFile \(ENOENT\)/);
});

test("bazaar options are checked", () => {
  assert.equal(resolveBazaar(undefined), undefined);
  const b = resolveBazaar({ facilitatorUrl: "https://facilitator.example/", serviceName: "Forecasts", tags: ["weather"] });
  assert.equal(b?.facilitatorUrl, "https://facilitator.example");
  assert.equal(b?.timeoutMs, 5_000);
  assert.throws(() => resolveBazaar({ facilitatorUrl: "nope" }), /facilitatorUrl/);
  assert.throws(() => resolveBazaar({ facilitatorUrl: "https://f.example", tags: ["a", "b", "c", "d", "e", "f"] }), /tags/);
  assert.throws(() => resolveBazaar({ facilitatorUrl: "https://f.example", serviceName: "x".repeat(33) }), /serviceName/);
  assert.throws(() => resolveBazaar({ facilitatorUrl: "https://f.example", iconUrl: "/icon.png" }), /iconUrl/);
  assert.throws(() => resolveBazaar({ facilitatorUrl: "https://f.example", extra: 1 }), /extra is not an option/);
});

let chain: Chain;
before(async () => {
  if (!skipReason) chain = await startChain();
});
after(() => chain?.stop());

const onChain = () => ({ ...base, contract: chain.contract, rpcUrl: chain.rpc, chainId: 31337, usdc: chain.usdc, queueId: chain.queueId, autoStart: false });

test("x429() refuses a wrong chain, an unknown queue, a foreign key and an unreachable RPC", { skip: skipReason }, async () => {
  await assert.rejects(x429({ ...onChain(), chainId: 8453 }), /rpcUrl is chain 31337, expected chainId 8453/);
  await assert.rejects(x429({ ...onChain(), contract: chain.usdc }), /cannot read queue/);
  await assert.rejects(x429({ ...onChain(), operatorKey: SECRET }), (err: Error) => {
    assert.match(err.message, new RegExp(`belongs to ${privateKeyToAccount(SECRET).address}, but the operator of`));
    assert.ok(!err.message.includes(SECRET.slice(2)));
    return true;
  });
  await assert.rejects(x429({ ...onChain(), rpcUrl: "http://127.0.0.1:9/secret-path-key" }), (err: Error) => {
    assert.match(err.message, /cannot reach rpcUrl 127\.0\.0\.1:9/);
    assert.ok(!err.message.includes("secret-path-key"), "only the host of an RPC URL is shown");
    return true;
  });
});

test("log entries show an RPC URL by its host only (its path may hold an API key)", { skip: skipReason }, async () => {
  const entries: Record<string, unknown>[] = [];
  const keyed = `${chain.rpc}/v2/secret-api-key`;
  // anvil answers on any path, so the keyed URL works as the feed RPC
  const lane = await x429({ ...onChain(), logsRpcUrls: [keyed], logger: (e) => entries.push(e) });
  try {
    lane.routes.failure(new Error(`HTTP request failed.\n\nURL: ${keyed}\nRequest body: {}`), "/x429/feed");
  } finally {
    lane.stop();
  }
  const line = entries.find((e) => e.evt === "error");
  assert.ok(line, "the failure was logged");
  assert.ok(!JSON.stringify(entries).includes("secret-api-key"));
  assert.match(String(line.error), /URL: 127\.0\.0\.1:\d+/);
});

test("the operator key appears in no log entry, event and no inspected Lane", { skip: skipReason }, async () => {
  const entries: unknown[] = [];
  const lane = await x429({ ...onChain(), operatorKeyFile: chain.keyFile, logger: (e) => entries.push(e), capacity: { perIntervalMs: 50 }, autoStart: true, pollMs: 100 });
  const events: unknown[] = [];
  lane.on("log", (e) => events.push(e));
  const apps = await adapterApps(lane);
  try {
    await fetch(`${apps.node}/api/data`);
    await fetch(`${apps.node}/api/data`);
    const j = await pay(apps.node, "/x429/join", {}, privateKeyToAccount(KEYS[3]!), 31337);
    assert.equal(j.status, 200);
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    await apps.close();
    lane.stop();
  }
  const key = chain.operatorKey.slice(2).toLowerCase();
  const dump = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)).toLowerCase();
  assert.ok(entries.length > 3, "the lane logged");
  assert.ok(events.length > 0, "and emitted log events");
  assert.ok(!dump(entries).includes(key));
  assert.ok(!dump(events).includes(key));
  assert.ok(!inspect(lane, { depth: 10 }).toLowerCase().includes(key), "not reachable by inspecting the lane");
});
