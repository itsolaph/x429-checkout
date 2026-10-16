// Demo agents for a live demo: keeps each one waiting in line by paying the x402 join whenever it is
// not in the queue (after being served). They are the operator's own agents: list their addresses in
// the server's X429_DEMO_AGENTS so /queue, the dashboard and the plugin label them as demo agents.
// Each one needs a little USDC on Base (join fees), never ETH; whatever passing agents pay them is
// pushed back to their wallets by the operator.
//
// Usage: node agent-sim/demo-rivals.ts <keys-file> [api]
//   keys-file: JSON {"keys": ["0x…", …], "prices": ["3000", …]} kept outside the repo (chmod 600)
//   api:       server origin (default $X429_URL or http://127.0.0.1:8429)
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { SimAgent } from "./agent.ts";

const [file, apiArg] = process.argv.slice(2);
if (!file) throw new Error("usage: node agent-sim/demo-rivals.ts <keys-file> [api]");
const api = apiArg ?? process.env.X429_URL ?? "http://127.0.0.1:8429";
const cfg = JSON.parse(readFileSync(file, "utf8")) as { keys: Hex[]; prices?: string[] };
const chainId = Number(process.env.X429_CHAIN_ID ?? 8453);
const agents = cfg.keys.map((k, i) => ({ agent: new SimAgent(`demo-agent-${i + 1}`, k, api, chainId), price: BigInt(cfg.prices?.[i] ?? 3_000 + i * 1_000) }));
const POLL_MS = Number(process.env.DEMO_POLL_MS ?? 15_000);

async function round() {
  const q = await agents[0]!.agent.http("GET", "/queue");
  if (q.status !== 200) throw new Error(`queue: ${q.status}`);
  const waiting = new Set<string>(q.body.queue.tickets.map((t: any) => String(t.owner).toLowerCase()));
  for (const { agent, price } of agents) {
    if (waiting.has(agent.address.toLowerCase())) continue;
    const { result } = await agent.join(price, 2);
    const b = result.body;
    console.log(JSON.stringify({ t: new Date().toISOString(), agent: agent.name, address: agent.address, status: result.status, position: b?.position, error: b?.error }));
  }
}

for (;;) {
  await round().catch((err) => console.error(`demo-rivals: ${(err as Error).message}`));
  await new Promise((r) => setTimeout(r, POLL_MS));
}
