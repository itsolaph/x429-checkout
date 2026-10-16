import assert from "node:assert/strict";
import { test } from "node:test";
import { DemoBudget, walletLow } from "../../agent-sim/demo-budget.ts";

test("joins per rolling hour are capped", () => {
  let t = 0;
  const b = new DemoBudget(3, 1_000_000n, () => t);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(b.canJoin(1000n), { ok: true });
    b.record(1000n);
    t += 60_000;
  }
  const d = b.canJoin(1000n);
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.reason, "joins_per_hour");
  assert.equal(d.ok === false && d.retryInMs, 3_600_000 - 180_000);
  t = 3_600_001; // the first join left the window
  assert.deepEqual(b.canJoin(1000n), { ok: true });
});

test("USDC per rolling day is capped", () => {
  let t = 0;
  const b = new DemoBudget(1000, 2_500n, () => t);
  b.record(1000n);
  b.record(1000n);
  const d = b.canJoin(1000n);
  assert.equal(d.ok === false && d.reason, "usdc_per_day");
  assert.equal(b.spentToday(), 2000n);
  assert.deepEqual(b.canJoin(500n), { ok: true });
  t = 24 * 3_600_000 + 1;
  assert.equal(b.spentToday(), 0n);
  assert.deepEqual(b.canJoin(1000n), { ok: true });
});

test("a wallet is low when it cannot pay the fee and keep the minimum", () => {
  assert.equal(walletLow(999n, 1000n, 0n), true);
  assert.equal(walletLow(5_999n, 1000n, 5_000n), true);
  assert.equal(walletLow(6_000n, 1000n, 5_000n), false);
});
