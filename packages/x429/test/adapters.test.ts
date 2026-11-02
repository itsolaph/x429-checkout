// The three adapters answer with the same status, headers and bytes, because the core builds every
// response and the adapters only carry it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { x429, type Lane } from "x429";
import { adapterApps, get, KEYS, pay, skipReason, startChain, unb64, type Apps, type Chain } from "./helpers.ts";

const PUBLIC = "https://api.test.example";
let chain: Chain;
let lane: Lane;
let apps: Apps;

before(async () => {
  if (skipReason) return;
  chain = await startChain();
  lane = await x429({
    contract: chain.contract,
    rpcUrl: chain.rpc,
    chainId: 31337,
    usdc: chain.usdc,
    publicUrl: PUBLIC,
    operatorKeyFile: chain.keyFile,
    queueId: chain.queueId,
    deployBlock: chain.deployBlock,
    // no admission round and no operator loop: the 429s are deterministic
    capacity: { perIntervalMs: 60_000, admissionRoundMs: 0 },
    autoStart: false,
  });
  apps = await adapterApps(lane);
  // two agents wait, posting 0.004 and 0.006 USDC
  for (const [i, price] of [[3, "4000"], [4, "6000"]] as const) {
    const r = await pay(apps.node, "/x429/join", { skipPrice: price }, privateKeyToAccount(KEYS[i]!), 31337);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

after(async () => {
  await apps?.close();
  lane?.stop();
  chain?.stop();
});

const each = () => [apps.node, apps.express, apps.hono] as const;

async function same(path: string, init: RequestInit = {}) {
  const out = [];
  for (const base of each()) {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!["date", "connection", "keep-alive", "content-length", "transfer-encoding"].includes(k)) headers[k] = v;
    });
    out.push({ status: res.status, headers: Object.fromEntries(Object.entries(headers).sort()), text });
  }
  assert.deepEqual(out[1], out[0], `express differs from node on ${init.method ?? "GET"} ${path}`);
  assert.deepEqual(out[2], out[0], `hono differs from node on ${init.method ?? "GET"} ${path}`);
  return { ...out[0]!, json: out[0]!.text ? JSON.parse(out[0]!.text) : undefined };
}

test("over capacity: the same 429 with the x429 offer from node, express and hono", { skip: skipReason }, async () => {
  const r = await same("/api/data?city=Lisbon");
  assert.equal(r.status, 429);
  const b = r.json;
  assert.equal(b.error, "too_many_requests");
  assert.equal(b.position, 3);
  assert.equal(b.queueLength, 2);
  assert.equal(b.etaSeconds, 120);
  // passing both: 0.004 + 0.006 plus the 3% fee
  assert.equal(b.skip.cost, "10300");
  assert.equal(b.skip.costUsd, "$0.0103");
  assert.equal(b.skip.maxAmount, "12360");
  assert.equal(b.skip.url, `${PUBLIC}/x429/skip`);
  assert.deepEqual(b.skip.body, { target: 1 });
  assert.equal(b.descriptor, `${PUBLIC}/x429`);
  assert.equal(b.wait.url, `${PUBLIC}/x429/join`);
  assert.match(b.message, /^Busy\. You are #3 in line; skipping to the front costs \$0\.0103 right now, paid to the 2 agents you pass\.$/);
  assert.equal(r.headers["retry-after"], "120");
  assert.equal(r.headers["x-429-position"], "3");
  assert.equal(r.headers["x-429-skip-cost"], "10300");
  assert.equal(r.headers["x-429-skip-url"], `${PUBLIC}/x429/skip`);
  assert.equal(r.headers["x-429-queue"], `${chain.contract}/${chain.queueId}`);
  assert.equal(r.headers.link, `<${PUBLIC}/x429/skip>; rel="payment"; title="x402 skip to #1"`);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["access-control-allow-origin"], "*");
});

test("the skip offer: the same 402 (v1 body, v2 PAYMENT-REQUIRED header) from every adapter", { skip: skipReason }, async () => {
  const r = await same("/x429/skip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: 1 }) });
  assert.equal(r.status, 402);
  assert.equal(r.json.x402Version, 1);
  const a = r.json.accepts[0];
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:31337");
  assert.equal(a.payTo, chain.contract);
  assert.equal(a.asset, chain.usdc);
  assert.equal(a.maxAmountRequired, "12360");
  assert.equal(a.resource, `${PUBLIC}/x429/skip`);
  assert.equal(a.extra.name, "USD Coin");
  assert.equal(a.extra.x429.kind, "skip");
  const v2 = unb64(r.headers["payment-required"]!);
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.accepts[0].amount, "12360");
  assert.equal(v2.resource.url, `${PUBLIC}/x429/skip`);
  assert.equal(v2.extensions, undefined, "no Bazaar declaration unless configured");
});

test("descriptor, quotes, queue, 404 and CORS preflight are the same everywhere", { skip: skipReason }, async () => {
  const d = await same("/x429");
  assert.equal(d.status, 200);
  assert.equal(d.json.version, "0.3");
  assert.equal(d.json.queueLength, 2);
  assert.equal(d.json.join.url, `${PUBLIC}/x429/join`);
  assert.equal(d.json.skip.quotes, `${PUBLIC}/x429/queue/${chain.queueId}`);
  assert.equal("mcp" in d.json, false, "server-only fields are not in the package descriptor");
  const q = await same("/x429/quote?target=2");
  assert.equal(q.status, 200);
  assert.equal(q.json.passes, 1);
  const queue = await same("/x429/queue");
  assert.equal(queue.json.queue.length, 2);
  assert.equal((await same("/x429/nope")).status, 404);
  const pre = await same("/x429/skip", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers["access-control-allow-headers"]!, /payment-signature/);
  const bad = await same("/x429/join", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_json");
  const token = await same("/api/data", { headers: { "x-429-token": "x429_not-a-real-token" } });
  assert.equal(token.status, 403);
  assert.equal(token.json.error, "invalid_token");
});

test("express: the lane reads a body that express.json() already parsed", { skip: skipReason }, async () => {
  const { default: express } = await import("express");
  const { x429Express } = await import("x429/express");
  const { listen } = await import("./helpers.ts");
  const { createServer } = await import("node:http");
  const app = express();
  app.use(express.json());
  app.use("/x429", x429Express(lane));
  const server = createServer(app);
  const base = await listen(server);
  try {
    const r = await get(`${base}/x429/quote`);
    assert.equal(r.status, 200);
    const posted = await fetch(`${base}/x429/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: 1 }) });
    const body = (await posted.json()) as { passes: number; targetPosition: number };
    assert.equal(posted.status, 200);
    assert.equal(body.targetPosition, 1);
    assert.equal(body.passes, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
