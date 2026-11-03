// The HTTP side with a real lane on a local anvil (MockUSDC, X429Checkout deployed by the package CLI,
// nothing on a public chain) and a stub renderer that sleeps: refusals before any capacity is used,
// x429's 429 + skip offer when both slots are busy, a paid skip that renders first while the agent it
// passed is paid on-chain, concurrency that never exceeds 2, the per-address bucket for free renders,
// and logs without query strings.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { x429, type Lane } from "x429";
import { balance, freePort, KEYS, pay, skipReason, startChain, type Chain } from "../../../packages/x429/test/helpers.ts";
import { Buckets } from "../src/bucket.ts";
import type { RenderRequest, RenderResult, Renderer } from "../src/renderer.ts";
import { createCore, createHandler, jsonLogger, Slots, type Core } from "../src/server.ts";
import { testGuard } from "./fixture.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000005000000032008060000000000000000", "hex");

/** Sleeps `?ms=` of the target URL, counts how many run at once, and answers like the real renderer. */
class StubRenderer implements Renderer {
  active = 0;
  peak = 0;
  calls: string[] = [];
  readonly ready = true;
  async render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.calls.push(req.url);
    const t0 = Date.now();
    try {
      const ms = Number(new URL(req.url).searchParams.get("ms") ?? 0);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
      const stats = { requests: 1, bytes: 100, blocked: 0, aborted: 0, budgetHit: false, documents: 1 };
      if (req.format === "png") return { format: "png", url: req.url, finalUrl: req.url, title: "Stub", status: 200, png: PNG, width: 1280, height: 800, renderedMs: Date.now() - t0, stats };
      const markdown = `# Stub\n\nrendered ${req.url}`;
      return { format: "markdown", url: req.url, finalUrl: req.url, title: "Stub", status: 200, markdown, bytes: Buffer.byteLength(markdown), truncated: false, renderedMs: Date.now() - t0, stats };
    } finally {
      this.active--;
    }
  }
  async close() {}
}

let chain: Chain;
let lane: Lane;
let core: Core;
let base = "";
let limited = "";
const stub = new StubRenderer();
const lines: string[] = [];
const servers: Server[] = [];
const served: bigint[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const port = await freePort();
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  if (skipReason) return;
  // join fee 0: waiting in line is free (the payer signs 1 unit, refunded in the same transaction)
  chain = await startChain({ joinFee: "0" });
  const log = jsonLogger((l) => lines.push(l));
  core = createCore({
    renderer: stub,
    guard: testGuard(),
    robots: { allowed: async (u) => !String(u).includes("/disallowed") },
    slots: new Slots(2),
    log,
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  lane = await x429({
    contract: chain.contract,
    rpcUrl: chain.rpc,
    chainId: 31337,
    usdc: chain.usdc,
    publicUrl: base,
    operatorKeyFile: chain.keyFile,
    queueId: chain.queueId,
    deployBlock: chain.deployBlock,
    pollMs: 100,
    payoutIntervalMs: 200,
    suggestedSkipPrice: "0.01",
    capacity: { concurrency: 2, estimateMs: 1000, admissionRoundMs: 0 },
    descriptorExtras: { service: "render.x429.lol", api: `${base}/v1/render` },
    serve: core.serve,
    validate: core.validate,
    logger: log,
  });
  lane.on("served", (e) => served.push(BigInt(e.ticketId as string | bigint)));
  const deps = { core, lane, renderer: stub, log, landing: "<!doctype html><title>x429 render</title>", trustProxy: true, publicUrl: base, descriptorPath: "/x429" };
  const s = createServer(createHandler({ ...deps, buckets: new Buckets(1000), freePerHour: 1000 }));
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  limited = await listen(createHandler({ ...deps, buckets: new Buckets(3), freePerHour: 3 }));
});

after(async () => {
  lane?.stop();
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  chain?.stop();
});

const render = async (url: string, opts: { base?: string; ip?: string; token?: string; extra?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.ip) headers["x-forwarded-for"] = `198.51.100.1, ${opts.ip}`;
  if (opts.token) headers["x-429-token"] = opts.token;
  const r = await fetch(`${opts.base ?? base}/v1/render?url=${encodeURIComponent(url)}${opts.extra ?? ""}`, { headers });
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, body: (type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer())) as any };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

test("pages: the landing page, /healthz, /robots.txt, the x429 descriptor; unknown paths are 404", { skip: skipReason }, async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type")!, /text\/html/);
  const h = (await (await fetch(`${base}/healthz`)).json()) as any;
  assert.equal(h.ok, true);
  assert.deepEqual(h.slots, { total: 2, busy: 0, waiting: 0 });
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/v1\//);
  const d = (await (await fetch(`${base}/x429`)).json()) as any;
  assert.equal(d.concurrency, 2);
  assert.equal(d.contract, chain.contract);
  assert.equal(d.api, `${base}/v1/render`);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/render`, { method: "POST" })).status, 405);
});

test("refused before any capacity is used: bad params 400, private targets 403, robots 403", { skip: skipReason }, async () => {
  const calls = stub.calls.length;
  const cases: [string, string, number, string][] = [
    ["", "", 400, "invalid_request"],
    ["http://site.test/", "&format=pdf", 400, "invalid_request"],
    ["http://site.test/", "&wait=9000", 400, "invalid_request"],
    ["http://site.test/", "&full=yes", 400, "invalid_request"],
    ["http://127.0.0.1/", "", 403, "blocked_target"],
    ["http://rebind.test/", "", 403, "blocked_target"],
    ["http://169.254.169.254/latest/meta-data/", "", 403, "blocked_target"],
    ["http://[::1]/", "", 403, "blocked_target"],
    ["http://site.test:8080/", "", 403, "blocked_target"],
    ["file:///etc/passwd", "", 403, "blocked_target"],
    ["http://site.test/disallowed", "", 403, "robots_disallowed"],
  ];
  for (const [url, extra, status, code] of cases) {
    const r = await render(url, { extra, base: limited, ip: "192.0.2.50" });
    assert.equal(r.status, status, `${url}${extra}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code);
  }
  assert.equal(stub.calls.length, calls, "nothing was rendered");
  // none of those took from the address's 3 free renders
  for (let i = 0; i < 3; i++) assert.equal((await render("http://site.test/ok", { base: limited, ip: "192.0.2.50" })).status, 200);
  // a skip offer for a private URL is refused before the 402: nobody can pay for it
  const skip = await post("/x429/skip", { target: 1, url: "http://10.0.0.1/admin" });
  assert.equal(skip.status, 403);
  assert.equal(skip.body.error, "blocked_target");
});

test("both slots busy: x429's 429; a paid skip jumps the line, renders first, and the passed waiter is paid on-chain", { skip: skipReason }, async () => {
  await until(() => stub.active === 0);
  const slowA = render("http://site.test/a?ms=1500");
  const slowB = render("http://site.test/b?ms=5000");
  await until(() => stub.active === 2);

  const third = await render("http://site.test/third");
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "too_many_requests");
  assert.equal(third.body.skip, null, "nobody waits yet: nothing to skip");
  assert.equal(third.headers.get("x-429-position"), "1");
  assert.ok(Number(third.headers.get("retry-after")) >= 1);

  // a waiter takes a ticket for free (join fee 0) and waits
  const waiter = privateKeyToAccount(KEYS[3]!);
  const waiterBefore = await balance(chain, waiter.address);
  const j = await pay(base, "/x429/join", { skipPrice: "10000" }, waiter, 31337);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.position, 1);
  assert.equal(await balance(chain, waiter.address), waiterBefore, "joining was free");
  const waiting = await post("/x429/use", { token: j.body.token, url: "http://site.test/waiter" });
  assert.equal(waiting.status, 429);
  assert.equal(waiting.body.position, 1);

  // now the 429 prices a skip past the waiter: 0.01 to them + the 3% fee
  const offer = await render("http://site.test/fourth");
  assert.equal(offer.status, 429);
  assert.equal(offer.body.position, 2);
  assert.equal(offer.body.skip.cost, "10300");
  assert.equal(offer.headers.get("x-429-skip-cost"), "10300");

  // the skipper pays; both slots are still busy, so it is queued at #1
  const skipper = privateKeyToAccount(KEYS[4]!);
  const s = await pay(base, "/x429/skip", { target: 1, url: "http://site.test/paid" }, skipper, 31337);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "queued");
  assert.equal(s.body.position, 1);
  assert.equal(s.body.receipt.charged, "10300");
  assert.equal(s.body.receipt.passed[0].owner, waiter.address);

  // slot A frees first: the operator serves the head, which is the skipper, not the waiter
  await slowA;
  await until(() => served.length > 0);
  assert.equal(served[0], BigInt(s.body.ticketId), "the skipper is served first");
  const u = await post("/x429/use", { token: s.body.token, url: "http://site.test/paid" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.result.format, "markdown");
  assert.equal(u.body.result.url, "http://site.test/paid");
  assert.match(u.body.result.markdown, /rendered http:\/\/site\.test\/paid/);
  assert.equal((await post("/x429/use", { token: j.body.token, url: "http://site.test/waiter" })).status, 429, "the waiter is still waiting");

  // the waiter is paid its posted price, pushed by the operator
  await until(async () => (await balance(chain, waiter.address)) === waiterBefore + 10000n);

  // slot B frees: the waiter is served and renders
  await slowB;
  await until(() => served.includes(BigInt(j.body.ticketId)));
  const w = await post("/x429/use", { token: j.body.token, url: "http://site.test/waiter" });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const order = stub.calls.filter((c) => c.endsWith("/paid") || c.endsWith("/waiter"));
  assert.deepEqual(order, ["http://site.test/paid", "http://site.test/waiter"]);
  assert.ok(stub.peak <= 2 && core.slots.peak <= 2, `peak ${stub.peak}/${core.slots.peak}`);
});

test("concurrency never exceeds 2: a burst of 12 requests gets 2 renders and ten 429s", { skip: skipReason }, async () => {
  await until(() => stub.active === 0);
  stub.peak = 0;
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => render(`http://site.test/burst${i}?ms=800`)));
  const statuses = burst.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, ...Array(10).fill(429)]);
  assert.equal(stub.peak, 2);
  assert.ok(core.slots.peak <= 2);
});

test("free renders: a bucket per address; a busy 429 gives the render back; ticket renders are exempt", { skip: skipReason }, async () => {
  await until(() => stub.active === 0);
  const ip = "203.0.113.77";
  for (let i = 0; i < 3; i++) assert.equal((await render(`http://site.test/free${i}`, { base: limited, ip })).status, 200);
  const over = await render("http://site.test/free3", { base: limited, ip });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "rate_limited");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal((await render("http://site.test/other", { base: limited, ip: "203.0.113.78" })).status, 200, "another address has its own bucket");

  // while both slots are busy, a free caller's 429 does not cost it a render
  const ip2 = "203.0.113.79";
  const hold = [render("http://site.test/h1?ms=1200"), render("http://site.test/h2?ms=1200")];
  await until(() => stub.active === 2);
  for (let i = 0; i < 3; i++) assert.equal((await render("http://site.test/busy", { base: limited, ip: ip2 })).body.error, "too_many_requests");
  await Promise.all(hold);
  await until(() => stub.active === 0);
  for (let i = 0; i < 3; i++) assert.equal((await render(`http://site.test/after${i}`, { base: limited, ip: ip2 })).status, 200);

  // the exhausted address renders with a ticket: join (free), get served, use the token on the API
  const agent = privateKeyToAccount(KEYS[5]!);
  const j = await pay(base, "/x429/join", {}, agent, 31337);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  await until(() => served.includes(BigInt(j.body.ticketId)));
  const png = await render("http://site.test/ticket", { base: limited, ip, token: j.body.token, extra: "&format=png" });
  assert.equal(png.status, 200, String(png.body));
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual(png.body.subarray(0, 8), PNG.subarray(0, 8));
});

test("logs carry host and path only: no query string of a target or of a request", { skip: skipReason }, async () => {
  await until(() => stub.active === 0);
  await render("http://site.test/q?api_key=SECRET-123&x=1", { ip: "192.0.2.99" });
  await fetch(`${base}/x429/skip?target=1&url=${encodeURIComponent("http://site.test/p?token=SECRET-456")}`, { method: "POST" });
  await fetch(`${base}/x429/quote?owner=nope-SECRET-789`);
  const all = lines.join("\n");
  assert.ok(lines.length > 20);
  for (const secret of ["SECRET-123", "SECRET-456", "SECRET-789"]) assert.ok(!all.includes(secret), `${secret} leaked into the logs`);
  assert.ok(lines.some((l) => l.includes('"target":"site.test/q"')), "the target is logged by host and path");
  for (const l of lines) JSON.parse(l);
});
