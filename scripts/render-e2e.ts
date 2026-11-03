// The render.x429.lol scenario, driven by scripts/render-e2e.sh against a server on an anvil fork of Base.
// Every payment is an x402 `exact` EIP-3009 authorization signed like a wallet, for forked USDC.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { pay } from "../packages/x429/test/helpers.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (run scripts/render-e2e.sh)`);
  return v;
};
const API = env("RENDER_API");
const TARGET = env("RENDER_TARGET");
const USDC = env("RENDER_USDC") as Address;
const keys = JSON.parse(readFileSync(env("RENDER_KEYS"), "utf8")) as { waiter: Hex; skipper: Hex };
const waiter = privateKeyToAccount(keys.waiter);
const skipper = privateKeyToAccount(keys.skipper);
const client = createPublicClient({ chain: { ...base, rpcUrls: { default: { http: [env("RENDER_RPC")] } } }, transport: http(env("RENDER_RPC")) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const usdcOf = (a: Address) => client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });

let steps = 0;
const t0 = Date.now();
const step = (msg: string) => {
  steps++;
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, f: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const getJson = async (path: string) => {
  const r = await fetch(`${API}${path}`);
  return { status: r.status, headers: r.headers, body: (await r.json()) as any };
};
const postJson = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const renderUrl = (q: string) => `/v1/render?url=${encodeURIComponent(TARGET)}${q}`;

// sample the slots all along: they must never show more than 2 busy
let peakBusy = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const h = (await (await fetch(`${API}/healthz`)).json()) as { slots: { busy: number } };
      peakBusy = Math.max(peakBusy, h.slots.busy);
    } catch {
      // the next sample
    }
    await sleep(100);
  }
})();

console.log(`render.x429.lol e2e: ${API}, target ${TARGET}`);
const home = await fetch(`${API}/`);
assert.equal(home.status, 200);
assert.match(await home.text(), /Any page, after its JavaScript\./);
const d = (await getJson("/x429")).body;
assert.equal(d.concurrency, 2);
assert.equal(d.network, "eip155:8453");
step(`landing page and descriptor: contract ${d.contract}, queue ${d.queueId}, concurrency ${d.concurrency}`);

// refused before anything: a private target, also as a skip offer (nobody can pay for it)
const meta = await getJson(`/v1/render?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`);
assert.equal(meta.status, 403);
assert.equal(meta.body.error, "blocked_target");
const metaSkip = await postJson("/x429/skip", { target: 1, url: "http://10.0.0.1/" });
assert.equal(metaSkip.status, 403);
step("a private target is refused (403 blocked_target), also before a skip offer");

// 1. saturate both slots with slow renders (wait=5000), the second a little later so slot A frees first
const slowA = getJson(renderUrl("&wait=5000&api_key=SECRET-E2E"));
await sleep(1500);
const slowB = getJson(renderUrl("&wait=5000"));
await until("both slots busy", async () => ((await getJson("/healthz")).body.slots.busy === 2 ? true : undefined));
step("two slow renders hold both slots");

// 2. a third caller gets x429's 429; nobody waits yet, so there is no skip offer
const third = await getJson(renderUrl(""));
assert.equal(third.status, 429, JSON.stringify(third.body));
assert.equal(third.body.error, "too_many_requests");
assert.equal(third.body.skip, null);
step(`third caller: 429 "${third.body.message}" (Retry-After ${third.headers.get("retry-after")})`);

// 3. a waiter takes a ticket for free (join fee 0: it signs 1 unit, refunded in the same transaction)
const waiterStart = await usdcOf(waiter.address);
const joined = await pay(API, "/x429/join", { skipPrice: "10000" }, waiter, 8453);
assert.equal(joined.status, 200, JSON.stringify(joined.body));
assert.equal(joined.body.position, 1);
assert.equal(await usdcOf(waiter.address), waiterStart, "the join cost nothing");
const waiting = await postJson("/x429/use", { token: joined.body.token, url: TARGET });
assert.equal(waiting.status, 429);
step(`waiter joined for free: ticket #${joined.body.ticketId} at #1, posting 0.01 USDC as its price; /use says "${waiting.body.message}"`);

// 4. the next caller's 429 prices the skip: the waiter's 0.01 plus the 3% fee
const fourth = await getJson(renderUrl(""));
assert.equal(fourth.status, 429);
assert.equal(fourth.body.skip.cost, "10300");
step(`fourth caller: 429 "${fourth.body.message}"`);

// 5. the skipper pays the skip with its render params in the body
const skipperStart = await usdcOf(skipper.address);
const paid = await pay(API, "/x429/skip", { target: 1, url: TARGET, format: "markdown", wait: 0 }, skipper, 8453);
assert.equal(paid.status, 200, JSON.stringify(paid.body));
assert.equal(paid.body.position, 1);
assert.equal(paid.body.receipt.charged, "10300");
assert.equal(paid.body.receipt.passed[0].owner, waiter.address);
assert.equal(await usdcOf(skipper.address), skipperStart - 10300n, "charged 0.0103, the rest of the 20% ceiling refunded");
step(`skipper paid ${paid.body.costUsd} (tx ${paid.body.txHash.slice(0, 12)}…): now #1 ahead of the waiter, ${paid.body.status} while both slots are busy`);

// 6. slot A frees: the skipper is served and gets its render; the waiter is still in line
const skipperResult = await until("the skipper's render", async () => {
  const u = await postJson("/x429/use", { token: paid.body.token, url: TARGET });
  return u.status === 200 ? u.body : undefined;
});
const skipperDoneAt = Date.now();
assert.equal(skipperResult.result.format, "markdown");
assert.equal(skipperResult.result.status, 200);
const waiterThen = await postJson("/x429/use", { token: joined.body.token, url: TARGET });
assert.equal(waiterThen.status, 429, "the waiter is still waiting when the skipper has its render");
step(`skipper served first: "${skipperResult.result.title}", ${skipperResult.result.bytes} bytes of markdown in ${skipperResult.result.renderedMs} ms; the waiter has none yet (${waiterThen.body.status}${waiterThen.body.position ? ` at #${waiterThen.body.position}` : ""})`);

// 7. the waiter it passed is paid its 0.01 on-chain, by the operator's payout
const waiterPaid = await until("the waiter's payout", async () => {
  const b = await usdcOf(waiter.address);
  return b > waiterStart ? b - waiterStart : undefined;
});
assert.equal(waiterPaid, 10000n);
const earned = (await getJson(`/x429/earnings/${waiter.address}`)).body;
step(`waiter paid 0.01 USDC on-chain (balance ${Number(waiterStart) / 1e6} → ${Number(waiterStart + waiterPaid) / 1e6}); GET /x429/earnings says received ${JSON.stringify(earned.received ?? earned.earned ?? earned)} units`);

// 8. slot B frees: the waiter is served and renders too
const a = await slowA;
const b = await slowB;
assert.equal(a.status, 200, JSON.stringify(a.body));
assert.equal(b.status, 200, JSON.stringify(b.body));
const waiterResult = await until("the waiter's render", async () => {
  const u = await postJson("/x429/use", { token: joined.body.token, url: TARGET });
  return u.status === 200 ? u.body : undefined;
});
assert.ok(Date.now() > skipperDoneAt);
step(`waiter served after: "${waiterResult.result.title}" in ${waiterResult.result.renderedMs} ms`);

// 9. a free PNG once the line is empty
await until("an empty line", async () => ((await getJson("/x429")).body.queueLength === 0 ? true : undefined));
await until("free slots", async () => ((await getJson("/healthz")).body.slots.busy === 0 ? true : undefined));
const png = await fetch(`${API}${renderUrl("&format=png&wait=0")}`);
assert.equal(png.status, 200);
assert.equal(png.headers.get("content-type"), "image/png");
const img = Buffer.from(await png.arrayBuffer());
assert.equal(img.readUInt32BE(16), 1280);
step(`free PNG: ${img.readUInt32BE(16)}x${img.readUInt32BE(20)}, ${img.length} bytes`);

sampling = false;
await sampler;
assert.ok(peakBusy <= 2, `peak ${peakBusy}`);
assert.equal(peakBusy, 2);
step(`slots sampled every 100 ms: at most ${peakBusy} busy`);
writeFileSync(env("RENDER_SUMMARY"), JSON.stringify({ steps, charged: 10300, waiterPaid: Number(waiterPaid), peakBusy, skipperTicket: paid.body.ticketId, waiterTicket: joined.body.ticketId }));
