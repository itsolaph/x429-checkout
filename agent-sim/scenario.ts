// End-to-end scenario against a running server on a Base fork. Run by scripts/e2e-local.sh.
//
// x402 is the only user action. 6 demo rivals join with a paid `POST /join` → a new agent drives the
// PayBox plugin (plugin/dist/plugin.mjs over stdio, a fresh process per call): status → quote → join
// proposal → (PayBox simulator pays) → skip proposal → (pays) → #1 → the rivals it passed are paid
// automatically by the operator → the agent uses its redeem token and is served. Failure cases:
// retried payment, expired authorization (v1), expired quote (v2), price moved above the signed
// ceiling, front-run and cancelled authorizations, double join. Every balance is asserted to the unit.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, parseSignature, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkoutAbi } from "../server/src/abi.ts";
import { chainFor, usdcAbi } from "../server/src/chain.ts";
import { fmtUsd } from "../server/src/protocol.ts";
import { decodeHeader } from "../server/src/x402.ts";
import { SimAgent } from "./agent.ts";
import { PluginClient } from "./plugin-client.ts";

const URL_ = process.env.X429_URL ?? "http://127.0.0.1:8429";
const RPC = process.env.X429_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.X429_CHAIN_ID ?? 8453);
const CONTRACT = process.env.X429_CONTRACT as Address;
const USDC = (process.env.X429_USDC ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
const keys = JSON.parse(readFileSync(process.env.E2E_KEYS!, "utf8")) as Record<string, Hex | Hex[]>;
const SUMMARY = process.env.E2E_SUMMARY;
const DEPLOY_BLOCK = BigInt(process.env.X429_DEPLOY_BLOCK ?? 0);
const FEE_BPS = BigInt(process.env.E2E_FEE_BPS ?? 300);
const JOIN_FEE = BigInt(process.env.E2E_JOIN_FEE ?? 1000);
const PLUGIN = process.env.E2E_PLUGIN ?? "plugin/dist/plugin.mjs";
const PLUGIN_NODE = process.env.E2E_PLUGIN_NODE ?? "node";
// what the plugin puts into proposals (PayBox pays HTTPS on 443 only); the simulator routes it here
const PUBLIC_ORIGIN = "https://x429.example";
const BUSY = "/v1/forecast?city=Lisbon";

const client = createPublicClient({ transport: http(RPC) });
const results: { name: string; ok: boolean; detail?: string }[] = [];

function say(msg: string) {
  console.log(`[agents] ${msg}`);
}

class AssertError extends Error {}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertError(msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new AssertError(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    say(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message) });
    say(`FAIL ${name}: ${(err as Error).message}`);
    throw err;
  }
}

const usdcOf = (a: Address) => client.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
const claimableOf = (a: Address) => client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "claimable", args: [a] });
const authUsed = (a: Address, n: Hex) => client.readContract({ address: USDC, abi: usdcAbi, functionName: "authorizationState", args: [a, n] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const feeOf = (compensation: bigint) => (compensation * FEE_BPS) / 10_000n;
const route = (url: string) => {
  const u = new URL(url);
  check(u.origin === PUBLIC_ORIGIN, `proposal origin ${u.origin}`);
  return `${URL_}${u.pathname}${u.search}`;
};

const agent = (name: string, key: Hex) => new SimAgent(name, key, URL_, CHAIN_ID);
const rivalKeys = keys.rivals as Hex[];
const rivals = rivalKeys.map((k, i) => agent(`demo-rival-${i + 1}`, k));
const skipper = agent("skipper", keys.skipper as Hex);
const late = agent("late", keys.late as Hex);
const pAgent = agent("cautious", keys.cautious as Hex);
const qAgent = agent("rusher", keys.rusher as Hex);
const fAgent = agent("front-run-victim", keys.victim as Hex);
const watcher = privateKeyToAccount(keys.watcher as Hex); // has ETH, sees X-PAYMENT headers
const plugin = new PluginClient(PLUGIN, { X429_API_BASE: URL_, X429_PROPOSAL_ORIGIN: PUBLIC_ORIGIN }, PLUGIN_NODE);

const RIVAL_PRICES = [3_000n, 4_000n, 4_500n, 5_500n, 6_000n, 7_000n]; // $0.003 … $0.007, sum $0.03
const priceOfTicket = new Map<bigint, bigint>();
const expectedEarned = new Map<string, bigint>(); // owner → compensation credited, from our own ledger
const initialUsdc = new Map<string, bigint>();
const joinFeesPaid = new Map<string, bigint>();
const spentBy = new Map<string, bigint>(); // payer → skip costs, from our own ledger
const everyone = [...rivals, skipper, late, pAgent, qAgent, fAgent];
let skipperTicket = 0n;
let skipperToken = "";
let paidToWaiting = 0n;
let feesTotal = 0n;

/** Checks a successful skip response against our ledger and records what each passed ticket earned. */
function recordSkip(r: any, label: string) {
  check(r.ok === true && r.kind === "skip", `${label}: skip not ok: ${JSON.stringify(r)}`);
  let sum = 0n;
  for (const p of r.passed as { ticketId: string; owner: Address; amount: string }[]) {
    const price = priceOfTicket.get(BigInt(p.ticketId));
    check(price !== undefined, `${label}: passed unknown ticket ${p.ticketId}`);
    eq(BigInt(p.amount), price, `${label}: ticket ${p.ticketId} must get exactly its posted price`);
    expectedEarned.set(p.owner.toLowerCase(), (expectedEarned.get(p.owner.toLowerCase()) ?? 0n) + price);
    sum += price;
  }
  eq(BigInt(r.compensation), sum, `${label}: compensation = sum of passed prices`);
  eq(BigInt(r.fee), feeOf(sum), `${label}: fee = ${FEE_BPS} bps`);
  eq(BigInt(r.cost), sum + feeOf(sum), `${label}: cost = compensation + fee`);
  check(typeof r.token === "string" && r.token.startsWith("x429_"), `${label}: a redeem token comes back`);
  paidToWaiting += sum;
  feesTotal += BigInt(r.fee);
  spentBy.set(r.owner.toLowerCase(), (spentBy.get(r.owner.toLowerCase()) ?? 0n) + BigInt(r.cost));
  if (r.ticketSkipPrice !== null) {
    priceOfTicket.set(BigInt(r.ticketId), BigInt(r.ticketSkipPrice));
  }
}

/** Checks a successful paid join and books its fee. */
function recordJoin(a: SimAgent, r: any, price: bigint, label: string) {
  check(r.ok === true && r.kind === "join", `${label}: join not ok: ${JSON.stringify(r)}`);
  eq(r.owner.toLowerCase(), a.address.toLowerCase(), `${label}: the ticket belongs to the payer (authorization.from)`);
  eq(BigInt(r.fee), JOIN_FEE, `${label}: join fee`);
  eq(BigInt(r.skipPrice), price, `${label}: posted skip price`);
  check(typeof r.token === "string" && /^x429_[A-Za-z0-9_-]{43}$/.test(r.token), `${label}: redeem token`);
  priceOfTicket.set(BigInt(r.ticketId), price);
  joinFeesPaid.set(a.address, (joinFeesPaid.get(a.address) ?? 0n) + JOIN_FEE);
  feesTotal += JOIN_FEE;
}

async function queueOwners(): Promise<Address[]> {
  const q = await skipper.http("GET", "/queue");
  return q.body.queue.tickets.map((t: any) => t.owner as Address);
}

/** Waits until the operator has pushed every owed unit to the rivals (no action on their side). */
async function waitForPayouts(label: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    let pending = 0n;
    for (const r of rivals) pending += await claimableOf(r.address);
    if (pending === 0n) return;
    if (Date.now() > deadline) throw new AssertError(`${label}: ${pending} units still not paid out after 30 s`);
    await sleep(500);
  }
}

async function main() {
  for (const a of everyone) initialUsdc.set(a.address, await usdcOf(a.address));

  await step("6 demo rivals join with a paid x402 POST /join; each pays exactly the join fee, no ETH", async () => {
    for (const [i, r] of rivals.entries()) {
      const { result: res, payload } = await r.join(RIVAL_PRICES[i]!, i % 2 === 0 ? 1 : 2);
      eq(res.status, 200, `${r.name} join status (${JSON.stringify(res.body)})`);
      recordJoin(r, res.body, RIVAL_PRICES[i]!, r.name);
      eq(res.body.position, i + 1, `${r.name} position`);
      eq(BigInt(res.body.refund), BigInt(payload.authorization.value) - JOIN_FEE, `${r.name} refund`);
      eq(await usdcOf(r.address), initialUsdc.get(r.address)! - JOIN_FEE, `${r.name} charged exactly the join fee`);
      eq(await client.getBalance({ address: r.address }), 0n, `${r.name} holds no ETH`);
    }
    const before = await usdcOf(rivals[0]!.address);
    const again = await rivals[0]!.join(1n);
    eq(again.result.status, 409, "a second waiting ticket for the same payer is refused");
    eq(again.result.body.error, "already_waiting", "reason");
    eq(await usdcOf(rivals[0]!.address), before, "nothing charged");
    eq(await authUsed(rivals[0]!.address, again.payload.authorization.nonce), false, "authorization unused");
  });

  await step("new agent hits the busy API: 429 with an x429 descriptor and a price", async () => {
    const r = await skipper.callApi(BUSY);
    eq(r.status, 429, "busy API status");
    check(Number(r.headers.get("retry-after")) >= 1, "Retry-After header");
    const d = r.body.x429;
    eq(d.version, "0.3", "descriptor version");
    eq(d.chainId, CHAIN_ID, "chainId");
    eq(d.position, 7, "you would be #7");
    eq(d.skip.toFront.passes, 6, "skipping to the front passes 6 agents");
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    eq(BigInt(d.skip.toFront.cost), comp + feeOf(comp), "cost to the front");
    eq(d.use.url, `${URL_}/use`, "descriptor points at /use");
    say(`429 says: "${r.body.message}"`);
  });

  await step("plugin over stdio: 6 tools, strict schemas; x429_status shows the queue", async () => {
    const tools = await plugin.listTools();
    const names = tools.map((t) => t.name).sort();
    eq(names.join(","), "x429_earnings,x429_join,x429_quote,x429_skip,x429_status,x429_use", "tool names");
    for (const t of tools) {
      check(t.description.length > 80 && /x429_|PayBox/.test(t.description), `${t.name} description tells the agent what to do next`);
      check(!/private key|secret/i.test(t.description), `${t.name} never asks for a key`);
      check(t.outputSchema, `${t.name} declares an output schema`);
    }
    const st = await plugin.call("x429_status", {});
    check(!st.isError, `status error: ${st.content[0]?.text}`);
    const s = st.structuredContent;
    eq(s.configured, true, "configured");
    eq(s.queue.length, 6, "6 waiting");
    eq(s.queue.joinFee, JOIN_FEE.toString(), "join fee");
    eq(s.queue.positions.length, 6, "positions");
    for (const [i, p] of s.queue.positions.entries()) {
      eq(p.skipPrice, RIVAL_PRICES[i]!.toString(), `posted price at #${i + 1}`);
      eq(p.demo, true, `#${i + 1} is labeled as a demo agent`);
    }
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    eq(s.queue.positions[0].costToReach, (comp + feeOf(comp)).toString(), "cost to reach #1");
    say(`x429_status: ${st.content[0]!.text}`);
    const unconfigured = await new PluginClient(PLUGIN, {}, PLUGIN_NODE).call("x429_status", {});
    eq(unconfigured.structuredContent.configured, false, "without X429_API_BASE: a clear not-configured result, no error");
  });

  await step("plugin x429_quote: cost to #1 and the ceiling (cost + 20%) with an expiry", async () => {
    const r = await plugin.call("x429_quote", { targetPosition: 1 });
    check(!r.isError, `quote error: ${r.content[0]?.text}`);
    const q = r.structuredContent;
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    const cost = comp + feeOf(comp);
    eq(q.fromPosition, 7, "a newcomer starts at #7");
    eq(q.passes, 6, "passes");
    eq(q.cost, cost.toString(), "cost");
    eq(q.ceiling, (cost + (cost * 2_000n) / 10_000n).toString(), "ceiling");
    check(Date.parse(q.quoteExpiresAt) > Date.now(), "quote not expired");
    say(`x429_quote: ${r.content[0]!.text}`);
  });

  await step("plugin x429_join → x402 proposal → PayBox pays → token; the payer is #7", async () => {
    const r = await plugin.call("x429_join", { skipPriceUsdc: "0.002" });
    check(!r.isError, `join error: ${r.content[0]?.text}`);
    const keys = Object.keys(r.structuredContent);
    eq(keys.join(","), "io.paybox/transactionProposal", "structuredContent holds only the proposal");
    const p = r.structuredContent["io.paybox/transactionProposal"];
    eq(p.request.url, `${PUBLIC_ORIGIN}/join`, "proposal url");
    eq(p.request.method, "POST", "method");
    eq(JSON.stringify(p.request.body), JSON.stringify({ skipPrice: "2000" }), "body");
    eq(p.payment.asset.toLowerCase(), USDC.toLowerCase(), "asset is Base USDC");
    eq(p.payment.maxAmount, JOIN_FEE.toString(), "maxAmount = join fee");
    const before = await usdcOf(skipper.address);
    const paid = await skipper.executeX402(p, route, 2);
    eq(paid.result.status, 200, `paid join (${JSON.stringify(paid.result.body)})`);
    recordJoin(skipper, paid.result.body, 2_000n, "skipper join");
    eq(paid.result.body.position, 7, "#7");
    eq(await usdcOf(skipper.address), before - JOIN_FEE, "charged exactly the join fee");
    skipperToken = paid.result.body.token;
    skipperTicket = BigInt(paid.result.body.ticketId);
    const st = await plugin.call("x429_status", { token: skipperToken });
    eq(st.structuredContent.you.status, "waiting", "x429_status with the token: waiting");
    eq(st.structuredContent.you.position, 7, "x429_status with the token: #7");
    const use = await plugin.call("x429_use", { token: skipperToken });
    eq(use.structuredContent.status, "waiting", "x429_use while waiting: position and ETA");
    eq(use.structuredContent.position, 7, "x429_use position");
    check(use.structuredContent.etaSeconds >= 1, "ETA");
  });

  let skipHeaders: Record<string, string> = {};
  let skipBody: unknown;
  await step("plugin x429_skip → proposal at the live ceiling → PayBox pays → #1; each rival credited its price", async () => {
    const r = await plugin.call("x429_skip", { targetPosition: 1, token: skipperToken });
    check(!r.isError, `skip error: ${r.content[0]?.text}`);
    const p = r.structuredContent["io.paybox/transactionProposal"];
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    const cost = comp + feeOf(comp);
    const ceiling = cost + (cost * 2_000n) / 10_000n;
    eq(p.request.url, `${PUBLIC_ORIGIN}/skip`, "proposal url");
    eq(JSON.stringify(p.request.body), JSON.stringify({ target: 1, owner: skipper.address }), "body: target and owner, never the token");
    eq(p.payment.maxAmount, ceiling.toString(), "maxAmount = live ceiling");
    check(Date.parse(p.expiresAt) <= Date.now() + 240_000 + 1_000, "expiry at most 4 minutes");
    const before = await usdcOf(skipper.address);
    const paid = await skipper.executeX402(p, route, 1);
    eq(paid.result.status, 200, `paid skip (${JSON.stringify(paid.result.body)})`);
    const settle = decodeHeader(paid.result.headers.get("x-payment-response")!) as any;
    eq(settle.success, true, "X-PAYMENT-RESPONSE success");
    eq(settle.transaction, paid.result.body.txHash, "settlement tx");
    recordSkip(paid.result.body, "skipper");
    eq(paid.result.body.position, 1, "skipper is #1");
    eq(paid.result.body.fromPosition, 7, "from #7");
    eq(paid.result.body.passes, 6, "passed 6 agents");
    eq(BigInt(paid.result.body.ticketId), skipperTicket, "same ticket");
    eq(BigInt(paid.result.body.refund), paid.amount - cost, "refund = authorized - cost");
    eq(await usdcOf(skipper.address), before - cost, "skipper paid exactly the cost");
    eq((await queueOwners())[0]!.toLowerCase(), skipper.address.toLowerCase(), "head of the queue");
    skipperToken = paid.result.body.token;
    skipHeaders = paid.headers;
    skipBody = p.request.body;
    say(`skipper paid ${fmtUsd(cost)} (refund ${fmtUsd(BigInt(paid.result.body.refund))}) tx ${paid.result.body.txHash}`);
  });

  await step("rivals are paid automatically by the operator: balances to the unit, no claim, no ETH", async () => {
    await waitForPayouts("after the skip");
    for (const [i, rv] of rivals.entries()) {
      eq(await claimableOf(rv.address), 0n, `${rv.name} nothing left to claim`);
      eq(await usdcOf(rv.address), initialUsdc.get(rv.address)! - JOIN_FEE + RIVAL_PRICES[i]!, `${rv.name} = start - join fee + its price`);
      eq(await client.getBalance({ address: rv.address }), 0n, `${rv.name} holds no ETH`);
    }
    const r6 = rivals[5]!;
    let e = await plugin.call("x429_earnings", { address: r6.address });
    for (let i = 0; i < 20 && e.structuredContent.received !== RIVAL_PRICES[5]!.toString(); i++) {
      await sleep(250); // the event feed polls
      e = await plugin.call("x429_earnings", { address: r6.address });
    }
    eq(e.structuredContent.earned, RIVAL_PRICES[5]!.toString(), "x429_earnings earned");
    eq(e.structuredContent.received, RIVAL_PRICES[5]!.toString(), "x429_earnings received");
    eq(e.structuredContent.claimable, "0", "x429_earnings pending");
    say(`x429_earnings: ${e.content[0]!.text}`);
  });

  await step("a retried paid request (same payment) gets a fresh token for the same ticket, nothing charged", async () => {
    const before = await usdcOf(skipper.address);
    const r = await skipper.http("POST", "/skip", skipBody, skipHeaders);
    eq(r.status, 200, `retry status (${JSON.stringify(r.body)})`);
    eq(r.body.replayed, true, "replayed");
    eq(BigInt(r.body.ticketId), skipperTicket, "same ticket");
    check(r.body.token !== skipperToken && r.body.token.startsWith("x429_"), "fresh token");
    eq(await usdcOf(skipper.address), before, "no money moved");
  });

  await step("expired authorization (v1, validBefore in the past) is refused before any transaction", async () => {
    const pr = await late.paymentRequired("/skip?queue=1&target=2");
    const block = await client.getBlock();
    const payload = await late.signExact(
      { asset: pr.v1.asset, payTo: pr.v1.payTo, amount: BigInt(pr.v1.maxAmountRequired), maxTimeoutSeconds: 60 },
      { validAfter: 0n, validBefore: block.timestamp - 1n },
    );
    const before = await usdcOf(late.address);
    const r = await late.http("POST", "/skip?queue=1&target=2", undefined, late.v1Header(payload));
    eq(r.status, 402, "status");
    eq(r.body.error, "invalid_exact_evm_payload_authorization_valid_before", "reason");
    check(Array.isArray(r.body.accepts) && r.body.accepts.length === 1, "a fresh quote comes back");
    eq(await usdcOf(late.address), before, "no money moved");
    eq(await authUsed(late.address, payload.authorization.nonce), false, "authorization unused");
  });

  await step("expired quote (v2 PAYMENT-SIGNATURE echoing a stale quote) is refused", async () => {
    const pr = await late.paymentRequired("/skip?queue=1&target=2");
    const accepted = structuredClone(pr.v2.accepts[0]);
    accepted.extra.x429.quoteExpiresAt = Math.floor(Date.now() / 1000) - 5;
    const payload = await late.signExact({ asset: accepted.asset, payTo: accepted.payTo, amount: BigInt(accepted.amount), maxTimeoutSeconds: 60 });
    const before = await usdcOf(late.address);
    const r = await late.http("POST", "/skip?queue=1&target=2", undefined, late.v2Header(payload, accepted, pr.v2.resource));
    eq(r.status, 402, "status");
    eq(r.body.error, "quote_expired", "reason");
    const fail = decodeHeader(r.headers.get("payment-response")!) as any;
    eq(fail.network, `eip155:${CHAIN_ID}`, "v2 failure header network");
    eq(await usdcOf(late.address), before, "no money moved");
  });

  await step("a fresh v2 payment with a JSON body (join + skip in one payment) settles", async () => {
    const before = await usdcOf(late.address);
    const { result: r } = await late.pay("/skip", { body: { target: 2, skipPrice: "2500" }, version: 2 });
    eq(r.status, 200, `v2 status (${JSON.stringify(r.body)})`);
    const settle = decodeHeader(r.headers.get("payment-response")!) as any;
    eq(settle.success, true, "PAYMENT-RESPONSE success");
    recordSkip(r.body, "late (v2)");
    eq(r.body.position, 2, "late is #2");
    eq(await usdcOf(late.address), before - BigInt(r.body.cost), "late paid exactly the cost");
  });

  await step("price moved above the signed ceiling: clear 402, nothing charged; a fresh quote then settles", async () => {
    // the cautious agent prices #2, then a rusher with a high skip price jumps to #2 first
    const pr = await pAgent.paymentRequired("/skip?queue=1&target=2");
    const payload = await pAgent.signExact({ asset: pr.v1.asset, payTo: pr.v1.payTo, amount: BigInt(pr.v1.maxAmountRequired), maxTimeoutSeconds: pr.v1.maxTimeoutSeconds });
    const rush = await qAgent.pay("/skip?queue=1&target=2&skipPrice=50000");
    eq(rush.result.status, 200, `rusher skip (${JSON.stringify(rush.result.body)})`);
    recordSkip(rush.result.body, "rusher");

    const before = await usdcOf(pAgent.address);
    const r = await pAgent.http("POST", "/skip?queue=1&target=2", undefined, pAgent.v1Header(payload));
    eq(r.status, 402, "status");
    eq(r.body.error, "price_moved", "reason");
    check(BigInt(r.body.cost) > BigInt(pr.v1.maxAmountRequired), "the new cost is above the signed ceiling");
    check(BigInt(r.body.accepts[0].maxAmountRequired) > BigInt(pr.v1.maxAmountRequired), "the fresh 402 carries the new price");
    say(`price moved: ${r.body.message}`);
    eq(await usdcOf(pAgent.address), before, "nothing charged");
    eq(await authUsed(pAgent.address, payload.authorization.nonce), false, "authorization still unused");

    const retry = await pAgent.pay("/skip?queue=1&target=2");
    eq(retry.result.status, 200, `retry with the fresh quote (${JSON.stringify(retry.result.body)})`);
    recordSkip(retry.result.body, "cautious retry");
    eq(await usdcOf(pAgent.address), before - BigInt(retry.result.body.cost), "charged exactly the new cost");
  });

  await step("front-run authorization: submitted straight to USDC, then detected and applied", async () => {
    const pr = await fAgent.paymentRequired("/skip?queue=1&target=2");
    const payload = await fAgent.signExact({ asset: pr.v1.asset, payTo: pr.v1.payTo, amount: BigInt(pr.v1.maxAmountRequired), maxTimeoutSeconds: pr.v1.maxTimeoutSeconds });
    const before = await usdcOf(fAgent.address);
    // someone who saw the X-PAYMENT header submits the authorization directly to USDC
    const wallet = createWalletClient({ account: watcher, transport: http(RPC), chain: chainFor({ chainId: CHAIN_ID, rpcUrl: RPC }) });
    const { r, s, v, yParity } = parseSignature(payload.signature);
    const a = payload.authorization;
    const hash = await wallet.writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
    });
    await client.waitForTransactionReceipt({ hash });
    eq(await usdcOf(fAgent.address), before - a.value, "front-run moved the full authorization into the contract");

    const res = await fAgent.http("POST", "/skip?queue=1&target=2", undefined, fAgent.v1Header(payload));
    eq(res.status, 200, `settles despite the front-run (${JSON.stringify(res.body)})`);
    eq(res.body.frontRun, true, "front-run detected");
    recordSkip(res.body, "front-run victim");
    eq(res.body.position, 2, "moved to #2");
    eq(await usdcOf(fAgent.address), before - BigInt(res.body.cost), "net charge is exactly the cost");
  });

  await step("a cancelled authorization (nonce burned at USDC) is refused, nothing moves", async () => {
    const pr = await late.paymentRequired("/skip?queue=1&target=2");
    const payload = await late.signExact({ asset: pr.v1.asset, payTo: pr.v1.payTo, amount: BigInt(pr.v1.maxAmountRequired), maxTimeoutSeconds: pr.v1.maxTimeoutSeconds });
    // the payer signs EIP-3009 CancelAuthorization for the same nonce; anyone may submit it
    const cancelSig = await late.account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
      types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "CancelAuthorization",
      message: { authorizer: late.address, nonce: payload.authorization.nonce },
    });
    const { r, s, v, yParity } = parseSignature(cancelSig);
    const wallet = createWalletClient({ account: watcher, transport: http(RPC), chain: chainFor({ chainId: CHAIN_ID, rpcUrl: RPC }) });
    const hash = await wallet.writeContract({
      address: USDC,
      abi: parseAbi(["function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]),
      functionName: "cancelAuthorization",
      args: [late.address, payload.authorization.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
    });
    await client.waitForTransactionReceipt({ hash });
    eq(await authUsed(late.address, payload.authorization.nonce), true, "nonce burned at USDC");
    const before = await usdcOf(late.address);
    const held = await usdcOf(CONTRACT);
    const res = await late.http("POST", "/skip?queue=1&target=2", undefined, late.v1Header(payload));
    eq(res.status, 402, `status (${JSON.stringify(res.body)})`);
    eq(res.body.error, "invalid_transaction_state", "reason");
    eq(await usdcOf(late.address), before, "payer untouched");
    eq(await usdcOf(CONTRACT), held, "contract untouched");
  });

  await step("the skipper is served next: plugin x429_use returns the API result, again on retry", async () => {
    const deadline = Date.now() + 90_000;
    let last: any;
    while (Date.now() < deadline) {
      last = await plugin.call("x429_use", { token: skipperToken, city: "Lisbon" });
      check(!last.isError, `x429_use error: ${last.content[0]?.text}`);
      if (last.structuredContent.status === "served") break;
      check(["waiting", "serving"].includes(last.structuredContent.status), `unexpected ${JSON.stringify(last.structuredContent)}`);
      await sleep(Math.min(2_000, (last.structuredContent.etaSeconds ?? 1) * 1000));
    }
    eq(last.structuredContent.status, "served", "served");
    const result = last.structuredContent.result;
    eq(result.city, "Lisbon", "forecast city");
    check(typeof result.summary === "string" && result.summary.startsWith("Lisbon"), "a useful summary");
    eq(result.admitted.via, "queue", "admitted through the queue");
    eq(BigInt(result.admitted.ticketId), skipperTicket, "ticket");
    const served = await client.getContractEvents({ address: CONTRACT, abi: checkoutAbi, eventName: "Served", fromBlock: DEPLOY_BLOCK });
    eq(served[0]?.args.ticketId, skipperTicket, "first ticket ever served is the skipper's");
    const again = await plugin.call("x429_use", { token: skipperToken, city: "Paris" });
    eq(again.structuredContent.status, "served", "a retry inside the admission window");
    eq(JSON.stringify(again.structuredContent.result), JSON.stringify(result), "returns the same result (one request per ticket)");
    const legacy = await skipper.callApi(BUSY, skipperTicket, CONTRACT);
    eq(legacy.status, 403, "the same ticket cannot redeem a second request with a signature");
    say(`served: ${result.summary}`);
  });

  await step("an agent already in line pays to move up 3 places (skip without join)", async () => {
    const r1 = rivals[0]!;
    const q = await r1.http("GET", `/queue?owner=${r1.address}`);
    const ticket = q.body.you.ticket;
    check(ticket && ticket.position >= 4, `rival-1 still waits at #4 or later (${JSON.stringify(ticket)})`);
    const target = ticket.position - 3;
    const before = await usdcOf(r1.address);
    const paid = await r1.pay("/skip", { body: { target, owner: r1.address } });
    eq(paid.result.status, 200, `rival-1 skip (${JSON.stringify(paid.result.body)})`);
    recordSkip(paid.result.body, "rival-1 move up");
    eq(paid.result.body.ticketSkipPrice, null, "no new ticket");
    eq(paid.result.body.passes, 3, "passed 3");
    eq(paid.result.body.position, target, "new position");
    eq(BigInt(paid.result.body.ticketId), BigInt(ticket.id), "same ticket");
    eq(await usdcOf(r1.address), before - BigInt(paid.result.body.cost), "charged exactly the cost");
  });

  await step("books balance: everyone passed was paid out; contract USDC = fees; every payer charged exactly", async () => {
    await waitForPayouts("end");
    const deadline = Date.now() + 30_000;
    let totalClaimable = await client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "totalClaimable" });
    while (totalClaimable !== 0n && Date.now() < deadline) {
      await sleep(500);
      totalClaimable = await client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "totalClaimable" });
    }
    eq(totalClaimable, 0n, "nothing left to claim for anyone: all compensation was pushed");
    const held = await usdcOf(CONTRACT);
    const totalFees = await client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "totalFees" });
    eq(held, totalFees, "contract balance = fees (skip fees + join fees)");
    eq(totalFees, feesTotal, "fees match the ledger");
    for (const a of everyone) {
      const k = a.address.toLowerCase();
      const expected = initialUsdc.get(a.address)! - (joinFeesPaid.get(a.address) ?? 0n) - (spentBy.get(k) ?? 0n) + (expectedEarned.get(k) ?? 0n);
      eq(await usdcOf(a.address), expected, `${a.name} final USDC = start - join fees - skip costs + compensation received`);
    }
    // the dashboard feed indexes events by polling; give it a moment to catch up
    let feed = await skipper.http("GET", "/feed?limit=200");
    for (let i = 0; i < 20 && BigInt(feed.body.totals.paidOut) !== paidToWaiting; i++) {
      await sleep(250);
      feed = await skipper.http("GET", "/feed?limit=200");
    }
    eq(BigInt(feed.body.totals.paidToWaiting), paidToWaiting, "dashboard total paid to people waiting");
    eq(BigInt(feed.body.totals.paidOut), paidToWaiting, "dashboard total pushed to wallets");
    for (const a of everyone) {
      eq(await client.getBalance({ address: a.address }), 0n, `${a.name} holds no ETH: every action was an x402 payment or a read`);
    }
    say(`plugin calls (fresh process each): ${plugin.calls}`);
  });

  const stats = await skipper.http("GET", "/stats");
  const summary = {
    results,
    paidToWaiting: paidToWaiting.toString(),
    fees: feesTotal.toString(),
    pluginCalls: plugin.calls,
    gas: stats.body.gas,
    gate: stats.body.gate,
    payouts: stats.body.payouts,
  };
  if (SUMMARY) writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
}

main()
  .then(() => {
    say(`all ${results.length} steps passed`);
    process.exit(0);
  })
  .catch((err) => {
    if (!(err instanceof AssertError)) console.error(err);
    if (SUMMARY) writeFileSync(SUMMARY, JSON.stringify({ results, error: String(err?.message ?? err) }, null, 2));
    process.exit(1);
  });
