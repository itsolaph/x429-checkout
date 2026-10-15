import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("allows `limit` hits per window per key, then refuses until the window slides", () => {
  const rl = new RateLimiter(2, 1_000);
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("a", 10), true);
  assert.equal(rl.take("a", 20), false);
  assert.equal(rl.take("b", 20), true, "keys are independent");
  assert.equal(rl.take("a", 1_001), true, "the first hit left the window");
  assert.equal(rl.take("a", 1_002), false);
});
