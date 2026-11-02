// Capacity models and the paid lane end to end on a local anvil: fixed interval, concurrency N,
// a paid skip answered in its own request (serve hook), payouts, and a served ticket going through
// to the handler once (no hook).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { x429, type Lane, type X429Options } from "x429";
import { adapterApps, balance, KEYS, newQueue, pay, skipReason, startChain, type Apps, type Chain } from "./helpers.ts";

let chain: Chain;
const open: { lane: Lane; apps: Apps }[] = [];

before(async () => {
  if (skipReason) return;
  chain = await startChain();
});

after(async () => {
  for (const o of open) {
    await o.apps.close();
    o.lane.stop();
  }
  chain?.stop();
});

async function laneOn(extra: Partial<X429Options>, queueId?: number) {
  const lane = await x429({
    contract: chain.contract,
    rpcUrl: chain.rpc,
    chainId: 31337,
    usdc: chain.usdc,
    publicUrl: "https://api.test.example",
    operatorKeyFile: chain.keyFile,
    queueId: queueId ?? chain.queueId,
    deployBlock: chain.deployBlock,
    pollMs: 100,
    payoutIntervalMs: 200,
    capacity: { perIntervalMs: 60_000 },
    ...extra,
  });
  const apps = await adapterApps(lane);
  open.push({ lane, apps });
  return { lane, apps };
}

const call = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers });
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
};

const until = async (ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};

test("interval model: one request per interval, then 429 that says when to retry", { skip: skipReason }, async () => {
  const { lane, apps } = await laneOn({ capacity: { perIntervalMs: 60_000 }, autoStart: false }, await newQueue(chain));
  const rejected: unknown[] = [];
  lane.on("rejected", (e) => rejected.push(e));
  const first = await call(`${apps.node}/api/data`);
  assert.equal(first.status, 200);
  assert.equal(first.body.via, "direct");
  const second = await call(`${apps.express}/api/data`);
  assert.equal(second.status, 429);
  assert.equal(second.body.queueLength, 0);
  assert.equal(second.body.skip, null, "nobody to pass: no skip offer");
  assert.match(second.body.next, /^Retry in about \d+ s\.$/);
  assert.ok(Number(second.headers.get("retry-after")) >= 59);
  assert.equal(rejected.length, 1);
});

test("concurrency model: admits while fewer than N run, frees a slot when a response ends", { skip: skipReason }, async () => {
  const { lane, apps } = await laneOn({ capacity: { concurrency: 2, estimateMs: 500 }, autoStart: false }, await newQueue(chain));
  const slow = [call(`${apps.node}/api/data?hold=800`), call(`${apps.hono}/api/data?hold=800`)];
  await until(() => lane.gate.snapshotStats().inflight === 2);
  const third = await call(`${apps.express}/api/data`);
  assert.equal(third.status, 429, "a third request while two run");
  assert.equal(lane.gate.snapshotStats().slotsFree, 0);
  const done = await Promise.all(slow);
  assert.deepEqual(done.map((r) => r.status), [200, 200]);
  await until(() => lane.gate.snapshotStats().inflight === 0);
  const again = await call(`${apps.express}/api/data`);
  assert.equal(again.status, 200, "a slot is free again");
  const d = (await call(`${apps.node}/x429`)).body;
  assert.equal(d.concurrency, 2);
  assert.ok(d.serviceIntervalMs >= 1, "per-position estimate from observed latency");
});

test("paid skip to #1: the answer and a receipt in one paid call; retries are identical; passed agents are paid", { skip: skipReason }, async () => {
  const served: unknown[] = [];
  const paidOut: { paid: { owner: string; amount: bigint }[] }[] = [];
  const { lane, apps } = await laneOn(
    {
      capacity: { perIntervalMs: 60_000, admissionRoundMs: 60_000 },
      serve: (a, params) => ({ forecast: `sunny in ${String(params.city ?? "nowhere")}`, ticketId: a.ticketId.toString() }),
    },
    await newQueue(chain),
  );
  lane.on("admitted", (e) => served.push(e));
  lane.on("paid_out", (e) => paidOut.push(e as never));
  const waiting = privateKeyToAccount(KEYS[5]!);
  const skipper = privateKeyToAccount(KEYS[6]!);
  const j = await pay(apps.hono, "/x429/join", { skipPrice: "7000" }, waiting, 31337);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const before = await balance(chain, waiting.address);

  const s = await pay(apps.express, "/x429/skip", { target: 1, city: "Paris" }, skipper, 31337, 2);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "served");
  assert.deepEqual(s.body.result, { forecast: "sunny in Paris", ticketId: s.body.ticketId });
  assert.equal(s.body.receipt.agentsPaid, 1);
  assert.equal(s.body.receipt.passed[0].owner, waiting.address);
  assert.equal(s.body.receipt.passed[0].amount, "7000");
  assert.equal(s.body.receipt.charged, "7210", "0.007 plus the 3% fee");
  assert.match(s.body.token, /^x429_[A-Za-z0-9_-]{43}$/);
  assert.ok(s.headers.get("payment-response"), "v2 settlement header");

  // the same payment again: the identical bytes, marked as a replay, nothing charged twice
  const paidBefore = await balance(chain, skipper.address);
  const again = await s.retry();
  assert.equal(again.status, 200);
  assert.equal(again.text, s.text);
  assert.equal(again.headers.get("x-429-idempotent-replay"), "true");
  assert.equal(await balance(chain, skipper.address), paidBefore);

  // the passed agent gets its posted price pushed to its wallet
  await until(() => paidOut.length > 0);
  assert.equal(await balance(chain, waiting.address), before + 7000n);

  // using the token again returns the same answer (one request per ticket)
  const use = await fetch(`${apps.node}/x429/use`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: s.body.token, city: "Rome" }) });
  const u = (await use.json()) as { status: string; replayed: boolean; result: unknown };
  assert.equal(use.status, 200);
  assert.equal(u.replayed, true);
  assert.deepEqual(u.result, s.body.result);
  // and on the protected route with X-429-Token
  const viaHeader = await call(`${apps.hono}/api/data?city=Oslo`, { "x-429-token": s.body.token });
  assert.equal(viaHeader.status, 200);
  assert.deepEqual(viaHeader.body, s.body.result);
  assert.ok(served.length >= 1);
});

test("no serve hook: a served ticket's request goes through to the handler once, and holds its slot until then", { skip: skipReason }, async () => {
  const { lane, apps } = await laneOn({ capacity: { concurrency: 1, estimateMs: 300, admissionRoundMs: 0 } }, await newQueue(chain));
  const servedEvents: unknown[] = [];
  lane.on("served", (e) => servedEvents.push(e));
  // the only slot is busy, so a new agent has to join
  const slow = call(`${apps.node}/api/data?hold=1500`);
  await until(() => lane.gate.snapshotStats().inflight === 1);
  const agent = privateKeyToAccount(KEYS[7]!);
  const j = await pay(apps.node, "/x429/join", {}, agent, 31337);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  const token = j.body.token as string;
  const waiting = await call(`${apps.express}/api/data`, { "x-429-token": token });
  assert.equal(waiting.status, 429);
  assert.equal(waiting.body.you.status, "waiting");
  await slow;
  // the operator serves the head once the slot frees
  await until(() => servedEvents.length > 0);
  const blocked = await call(`${apps.hono}/api/data`);
  assert.equal(blocked.status, 429, "the served ticket holds the slot until it uses its request");
  const through = await call(`${apps.hono}/api/data`, { "x-429-token": token });
  assert.equal(through.status, 200);
  assert.equal(through.body.via, "token");
  assert.equal(through.body.ticketId, j.body.ticketId);
  const again = await call(`${apps.node}/api/data`, { "x-429-token": token });
  assert.equal(again.status, 410);
  assert.equal(again.body.error, "used");
  await until(() => lane.gate.snapshotStats().inflight === 0);
  assert.equal((await call(`${apps.node}/api/data`)).status, 200, "the slot is free again");
});
