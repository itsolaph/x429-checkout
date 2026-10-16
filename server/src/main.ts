// Entry point: node server/src/main.ts (configuration from env, see .env.example).
import { resolve } from "node:path";
import { checkoutAbi } from "./abi.ts";
import { createApp } from "./app.ts";
import { Relayer, makePublicClient } from "./chain.ts";
import { Checkout } from "./checkout.ts";
import { loadConfig } from "./config.ts";
import { Feed } from "./feed.ts";
import { Gate } from "./gate.ts";
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
const feed = new Feed(client, cfg.contract, cfg.queueId, cfg.deployBlock);
const payouts = new Payouts(checkout, feed, log);
const server = createApp({ checkout, gate, feed, log, payouts, siteDir: cfg.siteDir ? resolve(cfg.siteDir) : undefined });

setInterval(() => void reader.refresh().catch(() => {}), cfg.pollMs);
gate.start();
feed.start(cfg.pollMs);
if (cfg.autoPayout) payouts.start(cfg.payoutIntervalMs);
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
