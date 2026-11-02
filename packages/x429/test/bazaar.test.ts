// Bazaar discovery: the declaration on the 402 skip offer, and the fire-and-forget POST to the
// facilitator's /verify, which never blocks or fails a paid request.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { x429, type Lane } from "x429";
import { bazaarDeclaration, forwardToFacilitator, resolveBazaar } from "../dist/bazaar.js";
import { adapterApps, freePort, KEYS, listen, newQueue, pay, skipReason, startChain, unb64, type Apps, type Chain } from "./helpers.ts";

type Seen = { path: string; body: any };

/** A facilitator stand-in: "hang" never answers, "500" fails, "ok" answers isValid. */
function facilitator(mode: "hang" | "500" | "ok") {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: JSON.parse(raw) });
      if (mode === "hang") return; // never answers
      res.writeHead(mode === "500" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(mode === "500" ? { error: "boom" } : { isValid: true }));
    });
  });
  return { server, seen };
}

const BAZAAR = {
  serviceName: "Forecast API",
  tags: ["weather", "forecast"],
  iconUrl: "https://api.test.example/icon.png",
  input: { example: { target: 1, city: "Lisbon" } },
  output: { example: { city: "Lisbon", summary: "dry" } },
};

test("declaration: the shape declareDiscoveryExtension builds for a JSON POST", () => {
  const d = bazaarDeclaration(resolveBazaar({ facilitatorUrl: "https://f.example", ...BAZAAR })!);
  assert.deepEqual(d.info.input, { type: "http", method: "POST", bodyType: "json", body: { target: 1, city: "Lisbon" } });
  assert.deepEqual(d.info.output, { type: "json", example: { city: "Lisbon", summary: "dry" } });
  assert.equal(d.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(d.schema.required, ["input"]);
  assert.deepEqual(d.schema.properties.input.required, ["type", "method", "bodyType", "body"]);
  assert.deepEqual(d.schema.properties.input.properties.method, { type: "string", enum: ["POST"] });
  assert.equal(d.schema.properties.input.additionalProperties, false);
  const minimal = bazaarDeclaration(resolveBazaar({ facilitatorUrl: "https://f.example" })!);
  assert.deepEqual(minimal.info.input.body, { target: 1 });
  assert.equal("output" in minimal.info, false);
});

test("forwarding returns at once even if fetch hangs or throws", () => {
  const b = resolveBazaar({ facilitatorUrl: "https://f.example" })!;
  const payment = { version: 2 as const, scheme: "exact", network: "eip155:8453", payload: {} as never, accepted: { amount: "1" }, raw: { x402Version: 2, payload: {} } };
  const logs: unknown[] = [];
  const t0 = performance.now();
  forwardToFacilitator(b, payment, { url: "https://a.example/skip" }, (e) => logs.push(e), () => new Promise(() => {}));
  forwardToFacilitator(b, payment, { url: "https://a.example/skip" }, (e) => logs.push(e), () => {
    throw new Error("sync failure");
  });
  forwardToFacilitator(b, { ...payment, version: 1 }, { url: "https://a.example/skip" }, () => assert.fail("v1 is not forwarded"), () => assert.fail("no fetch for v1") as never);
  assert.ok(performance.now() - t0 < 50);
  assert.equal((logs[0] as { evt: string }).evt, "bazaar_verify_error");
});

let chain: Chain;
const cleanup: (() => Promise<void> | void)[] = [];
before(async () => {
  if (!skipReason) chain = await startChain();
});
after(async () => {
  for (const c of cleanup.reverse()) await c();
  chain?.stop();
});

async function laneWith(facilitatorUrl: string): Promise<{ lane: Lane; apps: Apps; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = [];
  const lane = await x429({
    contract: chain.contract,
    rpcUrl: chain.rpc,
    chainId: 31337,
    usdc: chain.usdc,
    publicUrl: "https://api.test.example",
    operatorKeyFile: chain.keyFile,
    queueId: await newQueue(chain),
    capacity: { perIntervalMs: 60_000, admissionRoundMs: 60_000 },
    serve: () => ({ ok: true }),
    bazaar: { facilitatorUrl, timeoutMs: 30_000, ...BAZAAR },
    logger: (e) => logs.push(e),
    autoStart: false,
  });
  const apps = await adapterApps(lane);
  cleanup.push(() => apps.close(), () => lane.stop());
  // somebody to pass
  const j = await pay(apps.node, "/x429/join", {}, privateKeyToAccount(KEYS[3]!), 31337);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return { lane, apps, logs };
}

async function facilitatorUrl(mode: "hang" | "500" | "ok") {
  const f = facilitator(mode);
  const url = await listen(f.server);
  cleanup.push(() => {
    (f.server as Server).closeAllConnections();
    f.server.close();
  });
  return { url, seen: f.seen };
}

test("the 402 skip offer carries extensions.bazaar and the resource metadata (v2 only)", { skip: skipReason }, async () => {
  const f = await facilitatorUrl("ok");
  const { apps } = await laneWith(f.url);
  const res = await fetch(`${apps.hono}/x429/skip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: 1 }) });
  assert.equal(res.status, 402);
  const v2 = unb64(res.headers.get("payment-required"));
  assert.deepEqual(v2.resource, {
    url: "https://api.test.example/x429/skip",
    description: v2.resource.description,
    mimeType: "application/json",
    serviceName: "Forecast API",
    tags: ["weather", "forecast"],
    iconUrl: "https://api.test.example/icon.png",
  });
  assert.equal(v2.extensions.bazaar.info.input.method, "POST");
  assert.deepEqual(v2.extensions.bazaar.info.output.example, { city: "Lisbon", summary: "dry" });
  const v1 = (await res.json()) as Record<string, unknown>;
  assert.equal("extensions" in v1, false, "the v1 body is unchanged");
  const join = await fetch(`${apps.node}/x429/join`, { method: "POST" });
  assert.equal(unb64(join.headers.get("payment-required")).extensions, undefined, "only the skip offer is declared");
});

test("a facilitator that never answers does not hold up the paid skip; it still gets the payment", { skip: skipReason }, async () => {
  const f = await facilitatorUrl("hang");
  const { apps } = await laneWith(f.url);
  const t0 = Date.now();
  const s = await pay(apps.express, "/x429/skip", { target: 1 }, privateKeyToAccount(KEYS[4]!), 31337, 2);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "served");
  assert.ok(Date.now() - t0 < 10_000, "well under the 30 s facilitator timeout");
  const end = Date.now() + 5_000;
  while (f.seen.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.seen.length, 1);
  const { path, body } = f.seen[0]!;
  assert.equal(path, "/verify");
  assert.equal(body.x402Version, 2);
  assert.equal(body.paymentPayload.x402Version, 2);
  assert.equal(body.paymentPayload.payload.authorization.from, privateKeyToAccount(KEYS[4]!).address);
  assert.deepEqual(body.paymentRequirements, body.paymentPayload.accepted);
  assert.equal(body.paymentPayload.extensions.bazaar.info.input.type, "http");
  assert.equal(body.paymentPayload.resource.url, "https://api.test.example/x429/skip");
});

test("a failing or unreachable facilitator never fails the paid request (logged only)", { skip: skipReason }, async () => {
  const f = await facilitatorUrl("500");
  const a = await laneWith(f.url);
  const s1 = await pay(a.apps.node, "/x429/skip", { target: 1 }, privateKeyToAccount(KEYS[5]!), 31337, 2);
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const down = `http://127.0.0.1:${await freePort()}`;
  const b = await laneWith(down);
  const s2 = await pay(b.apps.hono, "/x429/skip", { target: 1 }, privateKeyToAccount(KEYS[6]!), 31337, 2);
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  const end = Date.now() + 5_000;
  const has = (logs: Record<string, unknown>[], evt: string) => logs.some((l) => l.evt === evt);
  while ((!has(a.logs, "bazaar_verify") || !has(b.logs, "bazaar_verify_error")) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.logs.find((l) => l.evt === "bazaar_verify")?.status, 500);
  assert.ok(has(b.logs, "bazaar_verify_error"));
  // v1 payments are not forwarded (the extension is v2)
  const before = f.seen.length;
  await pay(a.apps.node, "/x429/skip", { target: 1 }, privateKeyToAccount(KEYS[7]!), 31337, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.seen.length, before);
});
