import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Gate, type Admission } from "../src/gate.ts";

const contract = "0x1B70dcDC800a0B18c7a3100a9833FA4e923044C1";

function fakeCheckout(dataDir: string) {
  return { cfg: { dataDir, contract, admissionTtlMs: 300_000 } } as never;
}

test("served admissions (and their answers) survive a restart; expired ones do not", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "x429-gate-"));
  const logs: unknown[] = [];
  const g1 = new Gate(fakeCheckout(dir), (l) => logs.push(l));
  const now = Date.now();
  const live: Admission = {
    ticketId: 42n, owner: "0x000000000000000000000000000000000000dEaD", servedAt: now, expiresAt: now + 60_000,
    servedTx: "0xabc" as never, waited: 3, timesPassed: 1, earned: 5000n, paid: 15000n, result: { city: "Lisbon", tempC: 19 },
  };
  const old: Admission = { ...live, ticketId: 41n, expiresAt: now - 1, result: undefined };
  const g = g1 as unknown as { admissions: Map<bigint, Admission>; save(): void };
  g.admissions.set(42n, live);
  g.admissions.set(41n, old);
  g.save();

  const file = join(dir, `admissions-${contract.toLowerCase()}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes("x429_"), "no redeem tokens on disk");

  const g2 = new Gate(fakeCheckout(dir), () => {}) as unknown as { admissions: Map<bigint, Admission>; consumed: Set<bigint> };
  const back = g2.admissions.get(42n);
  assert.ok(back, "live admission restored");
  assert.equal(back.earned, 5000n);
  assert.equal(back.paid, 15000n);
  assert.deepEqual(back.result, { city: "Lisbon", tempC: 19 });
  assert.equal(g2.admissions.has(41n), false, "expired admission dropped");
  assert.equal(g2.consumed.has(41n), true, "expired admission remembered as used");
});

test("no data dir keeps admissions in memory only", () => {
  const g = new Gate({ cfg: { dataDir: undefined, contract, admissionTtlMs: 1 } } as never, () => {}) as unknown as { save(): void };
  g.save(); // no throw, nothing written
});
