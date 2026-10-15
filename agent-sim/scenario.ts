// End-to-end scenario against a running server on a Base fork. Run by scripts/e2e-local.sh.
//
// 6 rivals join gaslessly → a new agent hits the busy API → 429 + descriptor → POST /skip → 402 →
// signs EIP-3009 → pays → moves to #1 → is served next and redeems → rivals claim gaslessly.
// Failure cases: replayed payment, expired authorization (v1), expired quote (v2), price moved above
// the signed ceiling, front-run authorization, claim replay. Every balance is asserted to the unit.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseSignature, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkoutAbi } from "../server/src/abi.ts";
import { chainFor, usdcAbi } from "../server/src/chain.ts";
import { fmtUsd } from "../server/src/protocol.ts";
import { decodeHeader } from "../server/src/x402.ts";
import { SimAgent } from "./agent.ts";

const URL_ = process.env.X429_URL ?? "http://127.0.0.1:8429";
const RPC = process.env.X429_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.X429_CHAIN_ID ?? 8453);
const CONTRACT = process.env.X429_CONTRACT as Address;
const USDC = (process.env.X429_USDC ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
const keys = JSON.parse(readFileSync(process.env.E2E_KEYS!, "utf8")) as Record<string, Hex | Hex[]>;
const SUMMARY = process.env.E2E_SUMMARY;
const DEPLOY_BLOCK = BigInt(process.env.X429_DEPLOY_BLOCK ?? 0);
const FEE_BPS = BigInt(process.env.E2E_FEE_BPS ?? 300);
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

const agent = (name: string, key: Hex) => new SimAgent(name, key, URL_, CHAIN_ID);
const rivalKeys = keys.rivals as Hex[];
const rivals = rivalKeys.map((k, i) => agent(`rival-${i + 1}`, k));
const skipper = agent("skipper", keys.skipper as Hex);
const late = agent("late", keys.late as Hex);
const pAgent = agent("cautious", keys.cautious as Hex);
const qAgent = agent("rusher", keys.rusher as Hex);
const fAgent = agent("front-run-victim", keys.victim as Hex);
const watcher = privateKeyToAccount(keys.watcher as Hex); // has ETH, sees X-PAYMENT headers

const RIVAL_PRICES = [3_000n, 4_000n, 4_500n, 5_500n, 6_000n, 7_000n]; // $0.003 … $0.007, sum $0.03
const priceOfTicket = new Map<bigint, bigint>();
const expectedEarned = new Map<string, bigint>(); // owner → compensation credited, from our own ledger
const initialUsdc = new Map<string, bigint>();
const everyone = [...rivals, skipper, late, pAgent, qAgent, fAgent];
let skipperTicket = 0n;
let paidToWaiting = 0n;
let feesTotal = 0n;

/** Checks a successful skip response against our ledger and records what each passed ticket earned. */
function recordSkip(r: any, label: string) {
  check(r.ok === true, `${label}: skip not ok: ${JSON.stringify(r)}`);
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
  paidToWaiting += sum;
  feesTotal += BigInt(r.fee);
  if (r.ticketSkipPrice !== null) priceOfTicket.set(BigInt(r.ticketId), BigInt(r.ticketSkipPrice));
}

async function queueOwners(): Promise<Address[]> {
  const q = await skipper.http("GET", "/queue");
  return q.body.queue.tickets.map((t: any) => t.owner as Address);
}

async function main() {
  for (const a of everyone) initialUsdc.set(a.address, await usdcOf(a.address));

  await step("6 rivals join gaslessly (EIP-712 Join, relayed by the operator)", async () => {
    for (const [i, r] of rivals.entries()) {
      const res = await r.join(RIVAL_PRICES[i]!);
      eq(res.status, 200, `${r.name} join status (${JSON.stringify(res.body)})`);
      priceOfTicket.set(BigInt(res.body.ticketId), RIVAL_PRICES[i]!);
      eq(res.body.position, i + 1, `${r.name} position`);
      eq(await client.getBalance({ address: r.address }), 0n, `${r.name} holds no ETH`);
    }
    const again = await rivals[0]!.join(1n);
    eq(again.status, 409, "second waiting ticket for the same owner is refused");
    eq(again.body.error, "already_waiting", "reason");
  });

  let pr402: Awaited<ReturnType<SimAgent["paymentRequired"]>>;
  await step("new agent hits the busy API: 429 with an x429 descriptor and a price", async () => {
    const r = await skipper.callApi(BUSY);
    eq(r.status, 429, "busy API status");
    check(Number(r.headers.get("retry-after")) >= 1, "Retry-After header");
    const d = r.body.x429;
    eq(d.version, "0.2", "descriptor version");
    eq(d.chainId, CHAIN_ID, "chainId");
    eq(d.position, 7, "you would be #7");
    eq(d.skip.toFront.passes, 6, "skipping to the front passes 6 agents");
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    eq(BigInt(d.skip.toFront.cost), comp + feeOf(comp), "cost to the front");
    say(`429 says: "${r.body.message}"`);
  });

  await step("POST /skip without payment: 402 with v1 accepts and a v2 PAYMENT-REQUIRED header", async () => {
    pr402 = await skipper.paymentRequired("/skip?queue=1&target=1&skipPrice=2000");
    const comp = RIVAL_PRICES.reduce((a, b) => a + b, 0n);
    const cost = comp + feeOf(comp);
    eq(pr402.body.x402Version, 1, "v1 body");
    eq(pr402.v1.scheme, "exact", "scheme");
    eq(pr402.v1.network, "base", "v1 network name");
    eq(pr402.v1.asset.toLowerCase(), USDC.toLowerCase(), "asset");
    eq(pr402.v1.payTo.toLowerCase(), CONTRACT.toLowerCase(), "payTo is the queue contract");
    eq(BigInt(pr402.v1.maxAmountRequired), cost + (cost * 2_000n) / 10_000n, "ceiling = cost + 20%");
    eq(pr402.v1.extra.name, "USD Coin", "EIP-712 name");
    eq(pr402.v2.x402Version, 2, "v2 header");
    eq(pr402.v2.accepts[0].network, `eip155:${CHAIN_ID}`, "v2 network");
    eq(pr402.v2.accepts[0].amount, pr402.v1.maxAmountRequired, "v2 amount");
  });

  let skipHeaders: Record<string, string> = {};
  let skipCost = 0n;
  await step("agent signs EIP-3009, pays, and is moved to #1; each rival is credited its price", async () => {
    const before = await usdcOf(skipper.address);
    const payload = await skipper.signExact({
      asset: pr402.v1.asset,
      payTo: pr402.v1.payTo,
      amount: BigInt(pr402.v1.maxAmountRequired),
      maxTimeoutSeconds: pr402.v1.maxTimeoutSeconds,
    });
    skipHeaders = skipper.v1Header(payload);
    const r = await skipper.http("POST", "/skip?queue=1&target=1&skipPrice=2000", undefined, skipHeaders);
    eq(r.status, 200, `paid skip status (${JSON.stringify(r.body)})`);
    const settle = decodeHeader(r.headers.get("x-payment-response")!) as any;
    eq(settle.success, true, "X-PAYMENT-RESPONSE success");
    eq(settle.transaction, r.body.txHash, "settlement tx");
    recordSkip(r.body, "skipper");
    eq(r.body.position, 1, "skipper is #1");
    eq(r.body.fromPosition, 7, "from #7");
    eq(r.body.passes, 6, "passed 6 agents");
    skipperTicket = BigInt(r.body.ticketId);
    skipCost = BigInt(r.body.cost);
    eq(BigInt(r.body.refund), BigInt(pr402.v1.maxAmountRequired) - skipCost, "refund = ceiling - cost");
    eq(await usdcOf(skipper.address), before - skipCost, "skipper paid exactly the cost");
    for (const [i, rv] of rivals.entries()) {
      eq(await claimableOf(rv.address), RIVAL_PRICES[i]!, `${rv.name} claimable`);
    }
    eq((await queueOwners())[0]!.toLowerCase(), skipper.address.toLowerCase(), "head of the queue");
    say(`skipper paid ${fmtUsd(skipCost)} (refund ${fmtUsd(BigInt(r.body.refund))}) tx ${r.body.txHash}`);
  });

  await step("replayed payment is refused and moves nothing", async () => {
    const before = await usdcOf(skipper.address);
    const r = await skipper.http("POST", "/skip?queue=1&target=1", undefined, skipHeaders);
    eq(r.status, 402, "replay status");
    eq(r.body.error, "payment_already_settled", "replay reason");
    const fail = decodeHeader(r.headers.get("x-payment-response")!) as any;
    eq(fail.success, false, "settlement failure header");
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

  await step("a fresh v2 payment (PAYMENT-SIGNATURE) settles", async () => {
    const pr = await late.paymentRequired("/skip?queue=1&target=2&skipPrice=2500");
    const accepted = pr.v2.accepts[0];
    const payload = await late.signExact({ asset: accepted.asset, payTo: accepted.payTo, amount: BigInt(accepted.amount), maxTimeoutSeconds: accepted.maxTimeoutSeconds });
    const before = await usdcOf(late.address);
    const r = await late.http("POST", "/skip?queue=1&target=2&skipPrice=2500", undefined, late.v2Header(payload, accepted, pr.v2.resource));
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

  await step("the paying agent is served next and redeems its ticket for one request", async () => {
    const deadline = Date.now() + 90_000;
    let last: any;
    while (Date.now() < deadline) {
      last = await skipper.callApi(BUSY, skipperTicket, CONTRACT);
      if (last.status === 200) break;
      check(last.status === 429, `unexpected ${last.status} ${JSON.stringify(last.body)}`);
      await sleep(Math.min(2_000, Number(last.headers.get("retry-after") ?? 1) * 1000));
    }
    eq(last.status, 200, "redeemed");
    eq(last.body.admitted.via, "queue", "admitted through the queue");
    eq(BigInt(last.body.admitted.ticketId), skipperTicket, "ticket");
    const served = await client.getContractEvents({ address: CONTRACT, abi: checkoutAbi, eventName: "Served", fromBlock: DEPLOY_BLOCK });
    eq(served[0]?.args.ticketId, skipperTicket, "first ticket ever served is the skipper's");
    const again = await skipper.callApi(BUSY, skipperTicket, CONTRACT);
    eq(again.status, 403, "a served ticket redeems once");
    say(`forecast: ${JSON.stringify(last.body.hours[0])}`);
  });

  const claimRequests = new Map<string, unknown>();
  await step("rivals claim their compensation gaslessly, to the unit", async () => {
    for (const r of rivals) {
      const owed = expectedEarned.get(r.address.toLowerCase()) ?? 0n;
      eq(await claimableOf(r.address), owed, `${r.name} claimable matches the ledger`);
      const before = await usdcOf(r.address);
      const { request, result } = await r.claim();
      claimRequests.set(r.address, request);
      eq(result.status, 200, `${r.name} claim (${JSON.stringify(result.body)})`);
      eq(BigInt(result.body.amount), owed, `${r.name} claimed amount`);
      eq(await usdcOf(r.address), before + owed, `${r.name} USDC balance`);
      eq(await usdcOf(r.address), initialUsdc.get(r.address)! + owed, `${r.name} earned exactly its prices`);
      eq(await client.getBalance({ address: r.address }), 0n, `${r.name} still holds no ETH`);
      say(`${r.name} claimed ${fmtUsd(owed)}`);
    }
  });

  await step("claim replay is refused and moves nothing, even with new money to claim", async () => {
    const last = rivals[5]!;
    let owners = await queueOwners();
    if (owners.at(-1)?.toLowerCase() !== last.address.toLowerCase()) {
      // rival-6 was already served (or is not last): it joins again, gaslessly, at the tail
      const rejoin = await last.join(RIVAL_PRICES[5]!);
      eq(rejoin.status, 200, `rival-6 rejoins (${JSON.stringify(rejoin.body)})`);
      priceOfTicket.set(BigInt(rejoin.body.ticketId), RIVAL_PRICES[5]!);
      owners = await queueOwners();
    }
    eq(owners.at(-1)!.toLowerCase(), last.address.toLowerCase(), "rival-6 is at the tail");
    // the served skipper comes back as a newcomer and passes exactly the tail ticket (rival-6)
    const again = await skipper.pay(`/skip?queue=1&target=${owners.length}&skipPrice=1000`);
    eq(again.result.status, 200, `skipper passes the tail (${JSON.stringify(again.result.body)})`);
    recordSkip(again.result.body, "skipper again");
    const owed = await claimableOf(last.address);
    eq(owed, RIVAL_PRICES[5]!, "rival-6 has fresh compensation to claim");
    const before = await usdcOf(last.address);
    const replay = await last.http("POST", "/claim", claimRequests.get(last.address));
    eq(replay.status, 409, "replay status");
    eq(replay.body.error, "nonce_already_used", "replay reason");
    eq(await usdcOf(last.address), before, "no money moved");
    eq(await claimableOf(last.address), owed, "claimable untouched");
    const fresh = await last.claim();
    eq(fresh.result.status, 200, "a fresh signature claims");
    eq(await usdcOf(last.address), before + owed, "fresh claim pays exactly");
  });

  await step("books balance: contract USDC = claimables + fees; every payer charged exactly", async () => {
    const held = await usdcOf(CONTRACT);
    const totalClaimable = await client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "totalClaimable" });
    const totalFees = await client.readContract({ address: CONTRACT, abi: checkoutAbi, functionName: "totalFees" });
    eq(held, totalClaimable + totalFees, "contract balance");
    eq(totalFees, feesTotal, "fees match the ledger");
    let owedSum = 0n;
    for (const a of everyone) owedSum += await claimableOf(a.address);
    eq(totalClaimable, owedSum, "claimables are all ours");
    const feed = await skipper.http("GET", "/feed?limit=200");
    eq(BigInt(feed.body.totals.paidToWaiting), paidToWaiting, "dashboard total paid to people waiting");
    for (const a of [skipper, late, pAgent, qAgent, fAgent]) {
      eq(await client.getBalance({ address: a.address }), 0n, `${a.name} holds no ETH: every action was gasless`);
    }
  });

  const stats = await skipper.http("GET", "/stats");
  const summary = {
    results,
    paidToWaiting: paidToWaiting.toString(),
    fees: feesTotal.toString(),
    gas: stats.body.gas,
    gate: stats.body.gate,
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
