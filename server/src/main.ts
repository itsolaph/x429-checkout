// Entry point: node server/src/main.ts (configuration from env, see .env.example).
import { resolve } from "node:path";
import { checkoutAbi } from "./abi.ts";
import { createApp } from "./app.ts";
import { Relayer, makeLogsClients, makePublicClient } from "./chain.ts";
import { Checkout } from "./checkout.ts";
import { loadConfig } from "./config.ts";
import { Feed, rpcHost } from "./feed.ts";
import { Gate } from "./gate.ts";
import { ForecastService } from "./forecast.ts";
import { Payouts } from "./payouts.ts";
import { TokenStore } from "./tokens.ts";
import { toJson } from "./json.ts";
import { QueueReader } from "./queue.ts";

const cfg = loadConfig();
const log = (entry: Record<string, unknown>) => {
  const line = { t: new Date().toISOString(), ...entry };
  console.log(cfg.logJson ? toJson(line) : Object.entries(line).map(([k, v]) => `${k}=${typeof v === "bigint" ? v : JSON.stringify(v)}`).join(" "));
};

const client = makePublicClient(cfg);
const chainId = await client.getChainId();
if (chainId !== cfg.chainId) throw new Error(`RPC is chain ${chainId}, expected ${cfg.chainId}`);

const relayer = cfg.operatorKey ? new Relayer(client, cfg.operatorKey, cfg.contract) : undefined;
const reader = new QueueReader(client, cfg.contract, cfg.queueId, cfg.pollMs);
await reader.get(0); // fails early on a wrong contract or queue id
const operator = await client.readContract({ address: cfg.contract, abi: checkoutAbi, functionName: "operator" });
if (relayer && operator.toLowerCase() !== relayer.address.toLowerCase()) {
  throw new Error(`operator key ${relayer.address} is not the operator of ${cfg.contract} (${operator})`);
}

const tokens = new TokenStore(cfg.dataDir ? resolve(cfg.dataDir) : undefined, cfg.contract);
const checkout = new Checkout(cfg, client, reader, relayer, log, tokens);
const gate = new Gate(checkout, log);
const logsRpcs = makeLogsClients(cfg);
// A feed RPC on another chain would book foreign events: refuse to start. One that does not answer now is
// only logged; the feed rotates past it.
const logsChains = await Promise.allSettled(
  logsRpcs.map((r) =>
    Promise.race([r.client.getChainId(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000).unref())]),
  ),
);
logsChains.forEach((r, i) => {
  const host = rpcHost(logsRpcs[i]!.url);
  if (r.status === "fulfilled" && r.value !== cfg.chainId) throw new Error(`X429_LOGS_RPC_URL ${host} is chain ${r.value}, expected ${cfg.chainId}`);
  if (r.status === "rejected") log({ evt: "feed_rpc_error", host, error: "chain id check failed at startup" });
});
const feed = new Feed({
  rpcs: logsRpcs,
  chainId: cfg.chainId,
  contract: cfg.contract,
  queueId: cfg.queueId,
  fromBlock: cfg.deployBlock,
  dataDir: cfg.dataDir ? resolve(cfg.dataDir) : undefined,
  log,
});
const payouts = new Payouts(checkout, feed, log);
const forecasts = new ForecastService(cfg.forecastSource);
const server = createApp({ checkout, gate, feed, log, payouts, forecasts, siteDir: cfg.siteDir ? resolve(cfg.siteDir) : undefined });

setInterval(() => void reader.refresh().catch(() => {}), cfg.pollMs);
gate.start();
feed.start(cfg.pollMs);
if (cfg.autoPayout) payouts.start(cfg.payoutIntervalMs);
forecasts.start();
server.listen(cfg.port, cfg.host, () => {
  log({
    evt: "listening",
    url: cfg.publicUrl,
    chainId,
    contract: cfg.contract,
    queueId: cfg.queueId,
    operator: relayer?.address ?? null,
    serviceIntervalMs: cfg.serviceIntervalMs,
    admissionRoundMs: cfg.minQueueMs,
  });
});

const shutdown = () => {
  gate.stop();
  feed.stop();
  payouts.stop();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
