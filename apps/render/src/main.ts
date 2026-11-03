// render.x429.lol: `node src/main.ts` (Node 24 or newer). Configuration from the environment, or from
// an env file named by RENDER_ENV_FILE (see .env.example).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x429 } from "x429";
import { Buckets } from "./bucket.ts";
import { ConfigError, loadConfig, ROBOTS_TOKEN, VERSION } from "./config.ts";
import { Guard } from "./guard.ts";
import { ChromiumRenderer } from "./renderer.ts";
import { Robots } from "./robots.ts";
import { createCore, createHandler, jsonLogger, Slots } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));

const log = jsonLogger((line) => process.stdout.write(`${line}\n`));

async function main() {
  if (process.env.RENDER_ENV_FILE) process.loadEnvFile(process.env.RENDER_ENV_FILE);
  const cfg = loadConfig();
  const guard = new Guard();
  const robots = new Robots({ guard, token: ROBOTS_TOKEN, userAgent: cfg.userAgent, ttlMs: cfg.robotsTtlMs, log });
  const renderer = new ChromiumRenderer({ executablePath: cfg.chromiumPath, guard, robots, userAgent: cfg.userAgent, limits: cfg.limits, sandbox: cfg.sandbox, log });
  await renderer.warm();
  const slots = new Slots(cfg.concurrency);
  const core = createCore({ renderer, guard, robots, slots, log });
  const lane = await x429({ ...cfg.lane, serve: core.serve, validate: core.validate, logger: log });
  const prefix = cfg.lane.prefix ?? "/x429";
  const handler = createHandler({
    core,
    lane,
    buckets: new Buckets(cfg.freePerHour),
    renderer,
    log,
    landing: readFileSync(join(here, "../site/index.html"), "utf8"),
    trustProxy: cfg.trustProxy,
    publicUrl: cfg.publicUrl,
    descriptorPath: prefix || "/x429",
    freePerHour: cfg.freePerHour,
  });
  const server = createServer({ requestTimeout: 90_000, headersTimeout: 20_000 }, handler);
  server.listen(cfg.port, cfg.host, () => {
    log({ evt: "listening", version: VERSION, url: `http://${cfg.host}:${cfg.port}`, publicUrl: cfg.publicUrl, operator: lane.operator ?? null, concurrency: cfg.concurrency, freePerHour: cfg.freePerHour });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log({ evt: "stopping" });
    lane.stop();
    server.close();
    server.closeIdleConnections();
    void renderer.close().finally(() => setTimeout(() => process.exit(0), 200).unref());
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err: unknown) => {
  const msg = err instanceof ConfigError ? err.message : String((err as Error)?.message ?? err).split("\n")[0];
  log({ evt: "fatal", error: msg });
  process.exit(1);
});
