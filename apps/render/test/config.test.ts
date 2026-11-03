// Configuration from env, and the free-render bucket's arithmetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Buckets } from "../src/bucket.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { RENDER_CHROMIUM_PATH: process.execPath, X429_CONTRACT: "0x0000000000000000000000000000000000000001", X429_RPC_URL: "http://127.0.0.1:8545" };

test("config: defaults match the brief; the x429 lane gets concurrency 2; bad values name the variable", () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8440);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.concurrency, 2);
  assert.deepEqual(c.lane.capacity, { concurrency: 2, estimateMs: 4000, admissionRoundMs: 0 });
  assert.equal(c.limits.timeoutMs, 20_000);
  assert.equal(c.limits.maxBytes, 5 * 1024 * 1024);
  assert.equal(c.limits.maxRedirects, 2);
  assert.equal(c.limits.markdownMaxBytes, 200 * 1024);
  assert.equal(c.limits.pngMaxHeight, 8000);
  assert.equal(c.limits.blockMedia, true);
  assert.equal(c.freePerHour, 30);
  assert.equal(c.lane.suggestedSkipPrice, "0.01");
  assert.equal(c.lane.chainId, 8453);
  assert.equal(c.lane.prefix, "/x429");
  assert.match(c.userAgent, /x429-render\/\d/);
  const prod = loadConfig({ ...base, X429_PUBLIC_URL: "https://render.x429.lol/", RENDER_TRUST_PROXY: "1", RENDER_FREE_PER_HOUR: "10" });
  assert.equal(prod.publicUrl, "https://render.x429.lol");
  assert.equal(prod.trustProxy, true);
  assert.equal(prod.freePerHour, 10);
  assert.match(prod.userAgent, /\(\+https:\/\/render\.x429\.lol\)$/);
  assert.throws(() => loadConfig({ ...base, X429_CONTRACT: undefined }), (e: unknown) => e instanceof ConfigError && /X429_CONTRACT/.test(e.message));
  assert.throws(() => loadConfig({ ...base, RENDER_CHROMIUM_PATH: "/nope/chrome" }), /RENDER_CHROMIUM_PATH/);
  assert.throws(() => loadConfig({ ...base, RENDER_CONCURRENCY: "two" }), /RENDER_CONCURRENCY must be a whole number/);
  assert.throws(() => loadConfig({ ...base, RENDER_TRUST_PROXY: "yes" }), /RENDER_TRUST_PROXY must be 1 or 0/);
});

test("bucket: perHour renders, refilled evenly, refunds capped at the size", () => {
  let now = 0;
  const b = new Buckets(30, () => now);
  for (let i = 0; i < 30; i++) assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), false);
  assert.equal(b.retryAfterS("a"), 120, "one render every 2 minutes");
  now += 120_000;
  assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), false);
  b.refund("a");
  assert.equal(b.take("a"), true);
  b.refund("b");
  for (let i = 0; i < 30; i++) assert.equal(b.take("b"), true, "a refund never adds above the size");
  assert.equal(b.take("b"), false);
  assert.equal(new Buckets(0).take("x"), false, "0 turns free renders off");
});
