import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { checkoutAbi } from "../../packages/x429/src/abi.ts";
import { Routes } from "../../packages/x429/src/routes.ts";
import { createApp } from "../src/app.ts";
import { decodeState, encodeState, Feed, type FeedRpc } from "../../packages/x429/src/feed.ts";

const contract = "0x1B70dcDC800a0B18c7a3100a9833FA4e923044C1" as Address;
const alice = "0xCe12eCb70f431Aab1bC35dDfc81F51c061467E66" as Address;
const bob = "0xd34b89A1A63071e856Ef47189502F0C155185dcA" as Address;
const BIG = 2n ** 100n + 7n; // beyond Number precision

const meta = (block: bigint, i: number) => ({
  address: contract, blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, "0")}` as const,
  logIndex: i, blockHash: `0x${"00".repeat(32)}` as const, transactionIndex: 0, removed: false,
});

function passedLog(block: bigint, owner: Address, amount: bigint, queueId = 1) {
  return {
    ...meta(block, 0),
    topics: encodeEventTopics({ abi: checkoutAbi, eventName: "Passed", args: { queueId, passedTicketId: 3n, passedOwner: owner } }),
    data: encodeAbiParameters([{ type: "uint64" }, { type: "uint128" }], [9n, amount]),
  };
}

function paidOutLog(block: bigint, owner: Address, amount: bigint) {
  return {
    ...meta(block, 1),
    topics: encodeEventTopics({ abi: checkoutAbi, eventName: "PaidOut", args: { owner } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}

type RawLog = ReturnType<typeof passedLog>;

/** A fake RPC over a fixed set of logs. `fail` makes the named method throw. */
function mockRpc(head: bigint, logs: RawLog[], fail: Partial<Record<"getLogs" | "getBlock" | "getBlockNumber", Error>> = {}) {
  const calls: { method: string; from?: bigint; to?: bigint }[] = [];
  const client = {
    async getBlockNumber() {
      calls.push({ method: "getBlockNumber" });
      if (fail.getBlockNumber) throw fail.getBlockNumber;
      return head;
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.push({ method: "getLogs", from: fromBlock, to: toBlock });
      if (fail.getLogs) throw fail.getLogs;
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      calls.push({ method: "getBlock" });
      if (fail.getBlock) throw fail.getBlock;
      return { timestamp: 1_700_000_000n + blockNumber };
    },
  };
  return { client: client as unknown as FeedRpc, calls };
}

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "x429-feed-"));
const base = { chainId: 8453, contract, queueId: 1, fromBlock: 100n, saveEveryMs: 0 };

test("bigint state JSON round-trips exactly, including nested and huge values", () => {
  const v = { a: BIG, b: [1n, { c: -5n }], s: "123", n: 4, o: { $other: "x" } };
  assert.deepEqual(decodeState(encodeState(v)), v);
  assert.throws(() => decodeState('{"x":{"$bigint":"12abc"}}'));
});

test("feed state persists (bigints intact) and a restart resumes from the saved block", async () => {
  const dir = tmp();
  const logs = [passedLog(150n, alice, BIG), passedLog(2_500n, alice, 5n), paidOutLog(2_500n, alice, 7n), passedLog(3_000n, bob, 1n, 2)];
  const r1 = mockRpc(3_000n, logs);
  const f1 = new Feed({ ...base, rpcs: [{ url: "https://one.example/key123", client: r1.client }], dataDir: dir });
  await f1.poll();
  f1.stop();
  assert.deepEqual(f1.sync, { next: "3001", head: "3000", caughtUp: true });
  assert.equal(f1.totals.passes, 2, "queue 2's event is not booked");
  assert.equal(f1.totals.earnedBy[alice.toLowerCase()], BIG + 5n);
  assert.deepEqual(r1.calls.filter((c) => c.method === "getLogs").map((c) => [c.from, c.to]), [[100n, 2_099n], [2_100n, 3_000n]]);

  const file = join(dir, `feed-8453-${contract.toLowerCase()}-1.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes("key123"), "no RPC URLs on disk");

  const r2 = mockRpc(3_500n, [passedLog(3_400n, bob, 2n)]);
  const logged: Record<string, unknown>[] = [];
  const f2 = new Feed({ ...base, rpcs: [{ url: "https://one.example", client: r2.client }], dataDir: dir, log: (l) => logged.push(l) });
  assert.equal(logged[0]?.evt, "feed_resumed");
  assert.deepEqual(f2.totals, f1.totals);
  assert.deepEqual(f2.events, f1.events);
  assert.equal(typeof f2.totals.earnedBy[alice.toLowerCase()], "bigint");
  assert.equal(f2.sync.next, "3001");
  assert.equal(f2.sync.caughtUp, false, "head unknown until the first poll");

  await f2.poll();
  assert.deepEqual(r2.calls.filter((c) => c.method === "getLogs").map((c) => [c.from, c.to]), [[3_001n, 3_500n]], "resumes, no re-index");
  assert.equal(f2.totals.passes, 3);
  assert.equal(f2.totals.earnedBy[bob.toLowerCase()], 2n);
  assert.equal(f2.recent(1)[0]?.owner, bob);
});

test("a corrupt or foreign state file is ignored and indexing starts at the deploy block", async () => {
  const dir = tmp();
  const file = join(dir, `feed-8453-${contract.toLowerCase()}-1.json`);
  for (const [content, evt] of [
    ["{not json", "feed_state_corrupt"],
    [encodeState({ version: 1, next: 9n, totals: { paidToWaiting: "1" }, events: [], times: [] }), "feed_state_corrupt"],
  ] as const) {
    writeFileSync(file, content);
    const logged: Record<string, unknown>[] = [];
    const r = mockRpc(200n, []);
    const f = new Feed({ ...base, rpcs: [{ url: "https://x.example", client: r.client }], dataDir: dir, log: (l) => logged.push(l) });
    assert.equal(logged[0]?.evt, evt);
    assert.equal(f.sync.next, "100");
    await f.poll();
    assert.equal(r.calls.find((c) => c.method === "getLogs")?.from, 100n);
  }

  // a state saved with another deploy block is not reused
  const r = mockRpc(200n, [passedLog(150n, alice, 1n)]);
  const f = new Feed({ ...base, rpcs: [{ url: "https://x.example", client: r.client }], dataDir: dir });
  await f.poll();
  f.stop();
  const logged: Record<string, unknown>[] = [];
  const g = new Feed({ ...base, fromBlock: 120n, rpcs: [{ url: "https://x.example", client: r.client }], dataDir: dir, log: (l) => logged.push(l) });
  assert.equal(logged[0]?.evt, "feed_state_mismatch");
  assert.equal(g.sync.next, "120");
  assert.equal(g.totals.passes, 0);
});

test("on an RPC error the feed rotates to the next URL, backs off, and logs the host only", async () => {
  let now = 1_000_000;
  const limited = Object.assign(new Error("request limit reached https://bad.example/secret-key"), { code: -32011 });
  const bad = mockRpc(3_000n, [], { getLogs: limited });
  const good = mockRpc(3_000n, [passedLog(150n, alice, 4n)]);
  const logged: Record<string, unknown>[] = [];
  const f = new Feed({
    ...base,
    rpcs: [{ url: "https://bad.example/secret-key", client: bad.client }, { url: "https://good.example", client: good.client }],
    log: (l) => logged.push(l),
    now: () => now,
  });

  await f.poll();
  assert.equal(f.totals.passes, 0);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.evt, "feed_rpc_error");
  assert.equal(logged[0]!.host, "bad.example");
  assert.equal(logged[0]!.code, -32011);
  assert.equal(logged[0]!.retryInMs, 1_000);
  assert.ok(!JSON.stringify(logged, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes("secret-key"), "the URL path (API key) is never logged");

  await f.poll(); // still backing off: no request at all
  assert.equal(good.calls.length, 0);

  now += 1_000;
  await f.poll();
  assert.equal(f.totals.passes, 1, "indexed through the second RPC");
  assert.equal(f.sync.caughtUp, true);
});

test("backoff grows exponentially up to the cap, error lines are rate-limited, and success resets it", async () => {
  let now = 0;
  const fail: { getBlockNumber?: Error } = { getBlockNumber: new Error("ECONNREFUSED") };
  const down = mockRpc(500n, [], fail);
  const logged: Record<string, unknown>[] = [];
  const f = new Feed({ ...base, rpcs: [{ url: "https://down.example", client: down.client }], log: (l) => logged.push(l), now: () => now, errorLogEveryMs: 30_000 });
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    const before = down.calls.length;
    await f.poll();
    assert.equal(down.calls.length, before + 1, "one request per attempt, never a spin");
    const retryAt = (f as unknown as { retryAt: number }).retryAt;
    delays.push(retryAt - now);
    now = retryAt;
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  assert.ok(logged.length < 8 && logged.length >= 3, `rate-limited: ${logged.length} lines`);
  assert.ok(logged.some((l) => typeof l.suppressed === "number" && l.suppressed > 0));

  delete fail.getBlockNumber;
  await f.poll();
  assert.equal(f.sync.caughtUp, true);
  fail.getBlockNumber = new Error("ECONNREFUSED");
  await f.poll();
  assert.equal((f as unknown as { retryAt: number }).retryAt - now, 1_000, "a success resets the backoff");
});

test("saves are throttled while catching up, and stop() flushes the rest", async () => {
  let now = 0;
  const dir = tmp();
  const r = mockRpc(10_000n, []);
  const get = r.client.getLogs.bind(r.client);
  (r.client as unknown as { getLogs: typeof get }).getLogs = async (a) => {
    now += 1_000; // each chunk takes a second
    return get(a);
  };
  const f = new Feed({ ...base, fromBlock: 1n, saveEveryMs: 3_000, chunkBlocks: 1_000n, rpcs: [{ url: "https://x.example", client: r.client }], dataDir: dir, now: () => now });
  let saves = 0;
  const save = f.save.bind(f);
  f.save = () => {
    saves++;
    save();
  };
  await f.poll(); // 10 chunks over 10 s
  assert.ok(saves >= 3 && saves <= 4, `throttled: ${saves} saves for 10 chunks`);
  f.stop();
  const g = new Feed({ ...base, fromBlock: 1n, rpcs: [{ url: "https://x.example", client: r.client }], dataDir: dir });
  assert.equal(g.sync.next, "10001", "stop() saved the last chunk");
});

test("a chunk that fails halfway books nothing, so the retry does not double count", async () => {
  let now = 0;
  let blockCalls = 0;
  const r = mockRpc(300n, [passedLog(150n, alice, 10n), passedLog(160n, alice, 10n)]);
  const flaky = r.client as unknown as { getBlock: (a: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> };
  const real = flaky.getBlock;
  flaky.getBlock = async (a) => {
    if (++blockCalls === 2) throw new Error("timeout");
    return real(a);
  };
  const f = new Feed({ ...base, rpcs: [{ url: "https://x.example", client: r.client }], now: () => now });
  await f.poll();
  assert.equal(f.totals.passes, 0);
  assert.equal(f.sync.next, "100");
  now += 1_000;
  await f.poll();
  assert.equal(f.totals.passes, 2);
  assert.equal(f.totals.earnedBy[alice.toLowerCase()], 20n);
});

test("GET /feed reports sync progress and allows any origin", async () => {
  const r = mockRpc(5_000n, [passedLog(150n, alice, 4n)]);
  const get = r.client.getLogs.bind(r.client);
  // only the first chunk answers: the feed is still catching up
  (r.client as unknown as { getLogs: typeof get }).getLogs = async (a) => {
    if ((a as { fromBlock: bigint }).fromBlock > 100n) throw new Error("rate limited");
    return get(a);
  };
  const feed = new Feed({ ...base, chunkBlocks: 1_000n, rpcs: [{ url: "https://x.example", client: r.client }] });
  await feed.poll();
  const snap = { tickets: [], blockTime: 0, blockNumber: 1n };
  const checkout = {
    cfg: { chainId: 8453, contract, queueId: 1, explorer: "https://basescan.org", demoAgents: new Set(), serviceIntervalMs: 15_000, prefix: "", paymentTimeoutS: 120 },
    reader: { latest: snap, get: async () => snap },
    queueJson: () => [],
  };
  const gate = { intervalMs: () => 15_000 };
  const routes = new Routes({ checkout: checkout as never, gate: gate as never, feed, log: () => {} });
  const server = createApp({ lane: { cfg: checkout.cfg, checkout, routes } as never });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`, { headers: { origin: "https://dash.example" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = (await res.json()) as { sync: unknown; totals: { passes: number; paidToWaiting: string } };
    assert.deepEqual(body.sync, { next: "1100", head: "5000", caughtUp: false });
    assert.equal(body.totals.passes, 1);
    assert.equal(body.totals.paidToWaiting, "4");
  } finally {
    server.close();
  }
});
