import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Address } from "viem";
import { isQuoteError, quoteSkip, type Snapshot } from "../src/queue.ts";

const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;

function snapshot(prices: bigint[], feeBps = 300, maxLength = 64): Snapshot {
  return {
    queueId: 1,
    operator: addr(999),
    feeBps,
    length: prices.length,
    maxLength,
    skips: 0,
    joined: BigInt(prices.length),
    served: 0n,
    totalCompensation: 0n,
    feesAccrued: 0n,
    meta: "",
    tickets: prices.map((p, i) => ({
      position: i + 1,
      id: BigInt(i + 1),
      owner: addr(i + 1),
      skipPrice: p,
      joinedAt: 0,
      timesPassed: 0,
      earned: 0n,
      paid: 0n,
      firstSeenMs: 0,
    })),
    blockNumber: 1n,
    blockTime: 0,
    fetchedAt: 0,
  };
}

const PRICES = [3_000n, 4_000n, 4_500n, 5_500n, 6_000n, 7_000n];

test("a newcomer to #1 pays every ticket its price plus the fee, with a 20% ceiling", () => {
  const q = quoteSkip(snapshot(PRICES), null, 1, 2_000);
  assert.ok(!isQuoteError(q));
  assert.equal(q.fromPosition, 7);
  assert.equal(q.passes, 6);
  assert.equal(q.compensation, 30_000n);
  assert.equal(q.fee, 900n);
  assert.equal(q.cost, 30_900n);
  assert.equal(q.maxAmountRequired, 37_080n);
  assert.deepEqual(q.passed.map((p) => p.amount), PRICES);
});

test("an existing ticket only pays for the tickets between it and the target", () => {
  const q = quoteSkip(snapshot(PRICES), addr(6), 3, 0);
  assert.ok(!isQuoteError(q));
  assert.equal(q.fromPosition, 6);
  assert.equal(q.passes, 3);
  assert.equal(q.compensation, 4_500n + 5_500n + 6_000n);
});

test("quote errors mirror the contract's", () => {
  assert.equal((quoteSkip(snapshot(PRICES), addr(1), 1, 0) as { error: string }).error, "nothing_to_pass");
  assert.equal((quoteSkip(snapshot(PRICES), null, 0, 0) as { error: string }).error, "invalid_target");
  assert.equal((quoteSkip(snapshot(PRICES, 0, 6), null, 1, 0) as { error: string }).error, "queue_full");
  const long = snapshot(Array.from({ length: 70 }, () => 1n), 0, 256);
  assert.equal((quoteSkip(long, null, 1, 0) as { error: string }).error, "too_many_passes");
  assert.ok(!isQuoteError(quoteSkip(long, null, 7, 0)));
});

test("an all-free line still asks for a positive amount (refunded)", () => {
  const q = quoteSkip(snapshot([0n, 0n], 0), null, 1, 2_000);
  assert.ok(!isQuoteError(q));
  assert.equal(q.cost, 0n);
  assert.equal(q.maxAmountRequired, 1n);
});
