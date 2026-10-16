// The demo-agent service: keeps 3–5 clearly labeled demo tickets waiting at fixed posted prices, so
// the queue is never empty when someone tries the plugin. Each demo agent pays the x402 join (the
// join fee, USDC only, never ETH) whenever it is not waiting, after a short delay; whatever skippers
// pay it for being passed is pushed back to its wallet by the operator, so the demo is mostly
// self-funding. Hard limits: joins per rolling hour and USDC per rolling day across all demo
// wallets; a wallet that runs low stops (logged), and the service exits when all have stopped.
// Log: one JSON line per event on stdout.
//
// Usage: node agent-sim/demo-agents.ts   (configuration from the environment, see
//        scripts/start-demo-agents.sh and deploy/x429-demo-agents.service)
//   X429_URL                 server origin (default http://127.0.0.1:8429)
//   X429_RPC_URL             Base RPC, read only (balances)
//   X429_CHAIN_ID            default 8453
//   DEMO_KEYS_FILE           JSON array of 3–5 private keys (outside the repo, chmod 600)
//   DEMO_PRICES              posted skip prices in USDC units, comma-separated (default 2000,3000,4000,5000,6000)
//   DEMO_REJOIN_DELAY_MS     wait after a ticket leaves the queue before rejoining (default 30000)
//   DEMO_MAX_JOINS_PER_HOUR  default 30
//   DEMO_MAX_USDC_PER_DAY    default 0.25
//   DEMO_MIN_USDC            a wallet stops below this balance (default 0.005)
//   DEMO_POLL_MS             default 5000
// The server must list the demo addresses (printed at start) in X429_DEMO_AGENTS.
import { readFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { usdcAbi } from "../server/src/chain.ts";
import { fmtUsd, usdc } from "../server/src/protocol.ts";
import { SimAgent } from "./agent.ts";
import { DemoBudget, walletLow } from "./demo-budget.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k];
  if (v !== undefined && v !== "") return v;
  if (d === undefined) throw new Error(`missing ${k}`);
  return d;
};
const API = env("X429_URL", "http://127.0.0.1:8429").replace(/\/$/, "");
const CHAIN_ID = Number(env("X429_CHAIN_ID", "8453"));
const USDC = env("X429_USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
const raw = JSON.parse(readFileSync(env("DEMO_KEYS_FILE"), "utf8")) as Hex[] | { keys: Hex[] };
const keys = Array.isArray(raw) ? raw : raw.keys;
if (keys.length < 3 || keys.length > 5) throw new Error("DEMO_KEYS_FILE must hold 3 to 5 keys");
const prices = env("DEMO_PRICES", "2000,3000,4000,5000,6000").split(",").map((p) => BigInt(p.trim()));
const REJOIN_DELAY_MS = Number(env("DEMO_REJOIN_DELAY_MS", "30000"));
const POLL_MS = Number(env("DEMO_POLL_MS", "5000"));
const MIN_BALANCE = usdc(env("DEMO_MIN_USDC", "0.005"));
const budget = new DemoBudget(Number(env("DEMO_MAX_JOINS_PER_HOUR", "30")), usdc(env("DEMO_MAX_USDC_PER_DAY", "0.25")));
const client = createPublicClient({ transport: http(env("X429_RPC_URL", "http://127.0.0.1:8545")) });

type Demo = { agent: SimAgent; price: bigint; goneSince: number; stopped: boolean };
const demos: Demo[] = keys.map((k, i) => ({
  agent: new SimAgent(`demo-agent-${i + 1}`, k, API, CHAIN_ID),
  price: prices[i % prices.length]!,
  goneSince: Date.now() - REJOIN_DELAY_MS, // join right away at start
  stopped: false,
}));

function log(e: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...e }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

let paused: string | undefined;
let running = true;

async function round(): Promise<void> {
  const q = await demos[0]!.agent.http("GET", "/queue");
  if (q.status !== 200) throw new Error(`GET /queue: ${q.status}`);
  const waiting = new Set<string>(q.body.queue.tickets.map((t: { owner: string }) => t.owner.toLowerCase()));
  const fee = BigInt(q.body.joinFee ?? 0);
  const now = Date.now();
  for (const d of demos) {
    if (d.stopped || !running) continue;
    if (waiting.has(d.agent.address.toLowerCase())) {
      d.goneSince = 0;
      continue;
    }
    if (d.goneSince === 0) d.goneSince = now; // just served (or left): rejoin after the delay
    if (now - d.goneSince < REJOIN_DELAY_MS) continue;
    const balance = await client.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [d.agent.address] });
    if (walletLow(balance, fee, MIN_BALANCE)) {
      d.stopped = true;
      log({ evt: "wallet_low", agent: d.agent.name, address: d.agent.address, balance, balanceUsd: fmtUsd(balance), minUsd: fmtUsd(MIN_BALANCE) });
      continue;
    }
    const ok = budget.canJoin(fee);
    if (!ok.ok) {
      if (paused !== ok.reason) log({ evt: "cap_reached", reason: ok.reason, retryInSeconds: Math.ceil(ok.retryInMs / 1000), joinsThisHour: budget.joinsThisHour(), spentToday: budget.spentToday() });
      paused = ok.reason;
      return;
    }
    paused = undefined;
    const { result } = await d.agent.join(d.price, 2);
    if (result.status === 200) {
      budget.record(BigInt(result.body.fee ?? fee));
      d.goneSince = 0;
      log({ evt: "joined", agent: d.agent.name, address: d.agent.address, ticketId: result.body.ticketId, position: result.body.position, skipPrice: d.price, fee: result.body.fee, tx: result.body.txHash });
    } else {
      log({ evt: "join_failed", agent: d.agent.name, status: result.status, error: result.body?.error, message: result.body?.message });
    }
  }
  if (demos.every((d) => d.stopped)) {
    log({ evt: "stopped", reason: "every demo wallet is low; top them up with USDC on Base and restart" });
    running = false;
  }
}

log({ evt: "start", api: API, agents: demos.map((d) => ({ name: d.agent.name, address: d.agent.address, skipPrice: d.price })), demoAgentsEnv: demos.map((d) => d.agent.address).join(","), maxJoinsPerHour: budget.maxJoinsPerHour, maxUsdcPerDay: fmtUsd(budget.maxSpendPerDay) });
const stop = () => {
  running = false;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
while (running) {
  await round().catch((err) => log({ evt: "error", error: String((err as Error)?.message ?? err).split("\n")[0] }));
  for (let waited = 0; running && waited < POLL_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
}
log({ evt: "exit", joinsThisHour: budget.joinsThisHour(), spentToday: budget.spentToday() });
