// Entry point: node server/src/main.ts (configuration from env, see .env.example).
// x429.lol is a thin app on the x429 package: the lane does the queue, payments, payouts and feed.
import { resolve } from "node:path";
import { toJson } from "../../packages/x429/src/json.ts";
import { x429 } from "../../packages/x429/src/lane.ts";
import { apiResult, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ForecastService } from "./forecast.ts";

const cfg = loadConfig();
const log = (entry: Record<string, unknown>) => {
  const line = { t: new Date().toISOString(), ...entry };
  console.log(cfg.logJson ? toJson(line) : Object.entries(line).map(([k, v]) => `${k}=${typeof v === "bigint" ? v : JSON.stringify(v)}`).join(" "));
};

const forecasts = new ForecastService(cfg.forecastSource);
const lane = await x429({
  ...cfg.lane,
  serve: (admission, params) => apiResult(forecasts, params.city, admission),
  descriptorExtras: { mcp: `${cfg.publicUrl}/mcp` },
  logger: log,
  autoStart: false,
});
const server = createApp({ lane, log, forecasts, siteDir: cfg.siteDir ? resolve(cfg.siteDir) : undefined });

lane.start();
forecasts.start();
server.listen(cfg.port, cfg.host, () => {
  log({
    evt: "listening",
    url: cfg.publicUrl,
    chainId: lane.cfg.chainId,
    contract: lane.cfg.contract,
    queueId: lane.cfg.queueId,
    operator: lane.operator ?? null,
    serviceIntervalMs: lane.cfg.serviceIntervalMs,
    admissionRoundMs: lane.cfg.minQueueMs,
  });
});

const shutdown = () => {
  lane.stop();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
