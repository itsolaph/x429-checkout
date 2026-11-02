// Server configuration from environment variables (see .env.example): the x429 lane options plus what
// only this app has (HTTP listener, dashboard, forecast source, log format).
import type { X429Options } from "../../packages/x429/src/config.ts";

export type ServerConfig = {
  /** Lane options without the app's hooks (serve, logger, descriptorExtras). */
  lane: X429Options;
  host: string;
  port: number;
  publicUrl: string;
  siteDir: string | undefined;
  /** "open-meteo" (cached real data, demo fallback) or "demo". */
  forecastSource: string;
  logJson: boolean;
};

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${name}`);
}

function int(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(v);
}

function list(name: string): string[] {
  return env(name, "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
}

export function loadConfig(): ServerConfig {
  const host = env("X429_HOST", "127.0.0.1");
  const port = int("X429_PORT", 8429);
  const interval = int("X429_SERVICE_INTERVAL_MS", 15_000);
  const rpcUrl = env("X429_RPC_URL", "http://127.0.0.1:8545");
  const logsRpcUrls = list("X429_LOGS_RPC_URL");
  for (const u of logsRpcUrls) if (!/^https?:\/\//.test(u)) throw new Error("X429_LOGS_RPC_URL entries must be http(s) URLs");
  const publicUrl = env("X429_PUBLIC_URL", `http://${host}:${port}`).replace(/\/$/, "");
  const keyFile = process.env.X429_OPERATOR_KEY_FILE;
  const key = process.env.X429_OPERATOR_KEY?.trim();
  return {
    lane: {
      rpcUrl,
      logsRpcUrls: logsRpcUrls.length > 0 ? logsRpcUrls : undefined,
      chainId: int("X429_CHAIN_ID", 8453),
      usdc: env("X429_USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      contract: env("X429_CONTRACT"),
      queueId: int("X429_QUEUE_ID", 1),
      // the file wins over the variable, as before
      ...(keyFile ? { operatorKeyFile: keyFile } : key ? { operatorKey: key } : {}),
      publicUrl,
      // the PayBox plugin and the dashboard use the root paths: /join, /skip, /use, /queue, /x429 ...
      prefix: "",
      explorer: env("X429_EXPLORER", "https://basescan.org"),
      capacity: { perIntervalMs: interval, admissionRoundMs: int("X429_MIN_QUEUE_MS", interval) },
      admissionTtlMs: int("X429_ADMISSION_TTL_MS", 300_000),
      slippageBps: int("X429_SLIPPAGE_BPS", 2_000),
      paymentTimeoutS: int("X429_PAYMENT_TIMEOUT_S", 120),
      quoteTtlS: int("X429_QUOTE_TTL_S", 600),
      suggestedSkipPrice: env("X429_SUGGESTED_SKIP_PRICE", "0.005"),
      maxSkipPrice: env("X429_MAX_SKIP_PRICE", "0.1"),
      dataDir: process.env.X429_DATA_DIR || undefined,
      autoPayout: env("X429_AUTO_PAYOUT", "1") !== "0",
      payoutIntervalMs: int("X429_PAYOUT_INTERVAL_MS", 3_000),
      serveConfirm: env("X429_SERVE_CONFIRM", "1") === "1",
      holdDemoOnly: env("X429_HOLD_DEMO_ONLY", "1") !== "0",
      legacyJoin: env("X429_LEGACY_JOIN", "0") === "1",
      demoAgents: list("X429_DEMO_AGENTS"),
      joinsPerMinute: int("X429_JOINS_PER_MINUTE", 30),
      pollMs: int("X429_POLL_MS", 1_000),
      deployBlock: BigInt(env("X429_DEPLOY_BLOCK", "0")),
    },
    host,
    port,
    publicUrl,
    siteDir: process.env.X429_SITE_DIR || undefined,
    forecastSource: env("X429_FORECAST_SOURCE", "open-meteo"),
    logJson: env("X429_LOG", "json") === "json",
  };
}
