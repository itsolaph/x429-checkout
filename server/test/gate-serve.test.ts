import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeEventTopics, encodeAbiParameters, type Address } from "viem";
import { checkoutAbi } from "../src/abi.ts";
import { Gate } from "../src/gate.ts";

const contract = "0x1B70dcDC800a0B18c7a3100a9833FA4e923044C1" as Address;
const me = "0xCe12eCb70f431Aab1bC35dDfc81F51c061467E66" as Address;
const other = "0xd34b89A1A63071e856Ef47189502F0C155185dcA" as Address;

function servedLog(ticketId: bigint, owner: Address, paid: bigint) {
  return {
    address: contract,
    topics: encodeEventTopics({ abi: checkoutAbi, eventName: "Served", args: { queueId: 1, ticketId, owner } }),
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "uint24" }, { type: "uint128" }, { type: "uint128" }],
      [7, 0, 0n, paid],
    ),
    blockNumber: 2n, transactionHash: "0xbeef", logIndex: 0, blockHash: "0x00", transactionIndex: 0, removed: false,
  };
}

/** A gate over a fake chain: `snapHead` is what the (lagging) reader shows, `servedOnchain` who serve() really served. */
function harness(snapHead: { id: bigint; owner: Address }, servedOnchain: { id: bigint; owner: Address }) {
  const calls: string[] = [];
  const snap = {
    tickets: [{ position: 1, id: snapHead.id, owner: snapHead.owner, skipPrice: 0n, joinedAt: 100, timesPassed: 0, earned: 0n, paid: 0n, firstSeenMs: 0 }],
    blockTime: 107, blockNumber: 1n,
  };
  const relayer = {
    async call(fn: string) {
      calls.push(fn);
      return { transactionHash: "0xserve", gasUsed: 1n, logs: [servedLog(servedOnchain.id, servedOnchain.owner, 15000n)] };
    },
    async exclusive<T>(f: () => Promise<T>) { return f(); },
  };
  const checkout = {
    cfg: { dataDir: undefined, contract, queueId: 1, admissionTtlMs: 300_000, serviceIntervalMs: 15_000, admissionRoundMs: 15_000, demoAgents: new Set(), holdDemoOnly: false },
    relayer,
    reader: { latest: snap, refresh: async () => snap, get: async () => snap },
  };
  const gate = new Gate(checkout as never, () => {});
  return { gate, calls, g: gate as unknown as { busyUntil: number; admissions: Map<bigint, unknown> } };
}

test("a paid #1 is served in its request even when the reader still shows the old head", async () => {
  const { gate, calls } = harness({ id: 4n, owner: other }, { id: 9n, owner: me });
  const r = await gate.serveNow(9n, () => ({ ok: true }), true, { owner: me, paid: 15000n });
  assert.equal(r.status, "served");
  assert.deepEqual(calls, ["serve"]);
  const adm = (r as { admission: { paid: bigint; waited: number } }).admission;
  assert.equal(adm.paid, 15000n, "numbers come from the Served event");
  assert.equal(adm.waited, 7);
});

test("a paid #1 preempts the current service interval instead of answering busy", async () => {
  const { gate, g } = harness({ id: 9n, owner: me }, { id: 9n, owner: me });
  const before = Date.now() + 10_000;
  g.busyUntil = before; // someone was served 5 s ago
  const r = await gate.serveNow(9n, () => ({ ok: true }), true, { owner: me, paid: 15000n });
  assert.equal(r.status, "served");
  assert.ok(g.busyUntil >= before + 15_000 - 50, "the next scheduled serve moves back one interval");
});

test("if serve() served someone else, the payer hears not_head and the other ticket keeps its admission", async () => {
  const { gate, g } = harness({ id: 9n, owner: me }, { id: 4n, owner: other });
  const r = await gate.serveNow(9n, () => ({ ok: true }), true, { owner: me, paid: 15000n });
  assert.equal(r.status, "busy");
  assert.equal((r as { reason: string }).reason, "not_head");
  assert.ok(g.admissions.has(4n));
  assert.equal(g.admissions.has(9n), false);
});
