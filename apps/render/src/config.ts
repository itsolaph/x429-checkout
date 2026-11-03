// Configuration from the environment: RENDER_* for the renderer and the HTTP server, X429_* for the
// lane (the same names x429.lol and the examples use). Documented in apps/render/.env.example.
import { existsSync } from "node:fs";
import type { X429Options } from "x429";
import { DEFAULT_LIMITS, type Limits } from "./renderer.ts";

export class ConfigError extends Error {}

export type RenderConfig = {
  host: string;
  port: number;
  publicUrl: string;
  chromiumPath: string;
  sandbox: boolean;
  concurrency: number;
  freePerHour: number;
  trustProxy: boolean;
  robotsTtlMs: number;
  limits: Limits;
  userAgent: string;
  lane: Omit<X429Options, "serve" | "validate" | "logger">;
};

export const VERSION = "0.1.0";
export const ROBOTS_TOKEN = "x429-render";

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): RenderConfig {
  const str = (name: string, fallback?: string): string => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback === undefined) throw new ConfigError(`set ${name} (see apps/render/.env.example)`);
    return fallback;
  };
  const opt = (name: string): string | undefined => (env[name] === undefined || env[name] === "" ? undefined : env[name]);
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = opt(name);
    if (raw === undefined) return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
    const n = Number(raw);
    if (n < min || n > max) throw new ConfigError(`${name} must be from ${min} to ${max}`);
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = opt(name);
    if (raw === undefined) return fallback;
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    throw new ConfigError(`${name} must be 1 or 0`);
  };

  const port = int("RENDER_PORT", 8440, 1, 65535);
  const host = str("RENDER_HOST", "127.0.0.1");
  const publicUrl = str("X429_PUBLIC_URL", `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const chromiumPath = str("RENDER_CHROMIUM_PATH");
  if (!existsSync(chromiumPath)) throw new ConfigError(`RENDER_CHROMIUM_PATH ${chromiumPath} does not exist`);
  const concurrency = int("RENDER_CONCURRENCY", 2, 1, 16);
  const limits: Limits = {
    ...DEFAULT_LIMITS,
    timeoutMs: int("RENDER_TIMEOUT_MS", DEFAULT_LIMITS.timeoutMs, 3_000, 120_000),
    maxBytes: int("RENDER_MAX_BYTES", DEFAULT_LIMITS.maxBytes, 64 * 1024, 100 * 1024 * 1024),
    maxRedirects: int("RENDER_MAX_REDIRECTS", DEFAULT_LIMITS.maxRedirects, 0, 10),
    maxRequests: int("RENDER_MAX_REQUESTS", DEFAULT_LIMITS.maxRequests, 1, 5_000),
    blockMedia: bool("RENDER_BLOCK_MEDIA", true),
    allowPost: bool("RENDER_ALLOW_POST", false),
    markdownMaxBytes: int("RENDER_MARKDOWN_MAX_BYTES", DEFAULT_LIMITS.markdownMaxBytes, 1024, 10 * 1024 * 1024),
    pngMaxHeight: int("RENDER_PNG_MAX_HEIGHT", DEFAULT_LIMITS.pngMaxHeight, 800, 16_000),
  };
  const logsRpc = opt("X429_LOGS_RPC_URLS");
  const lane: RenderConfig["lane"] = {
    contract: str("X429_CONTRACT"),
    rpcUrl: str("X429_RPC_URL"),
    publicUrl,
    capacity: {
      concurrency,
      estimateMs: int("X429_ESTIMATE_MS", 4_000, 1, 600_000),
      admissionRoundMs: int("X429_ADMISSION_ROUND_MS", 0, 0, 600_000),
    },
    queueId: int("X429_QUEUE_ID", 1, 1, 2 ** 32 - 1),
    chainId: int("X429_CHAIN_ID", 8453, 1, 2 ** 53 - 1),
    ...(opt("X429_USDC") ? { usdc: opt("X429_USDC") } : {}),
    ...(opt("X429_OPERATOR_KEY_FILE") ? { operatorKeyFile: opt("X429_OPERATOR_KEY_FILE") } : {}),
    prefix: env.X429_PREFIX ?? "/x429",
    deployBlock: str("X429_DEPLOY_BLOCK", "0"),
    ...(opt("X429_DATA_DIR") ? { dataDir: opt("X429_DATA_DIR") } : {}),
    suggestedSkipPrice: str("X429_SUGGESTED_SKIP_PRICE", "0.01"),
    maxSkipPrice: str("X429_MAX_SKIP_PRICE", "0.05"),
    admissionTtlMs: int("X429_ADMISSION_TTL_MS", 120_000, 5_000, 3_600_000),
    serveConfirm: bool("X429_SERVE_CONFIRM", true),
    pollMs: int("X429_POLL_MS", 1_000, 50, 60_000),
    payoutIntervalMs: int("X429_PAYOUT_INTERVAL_MS", 3_000, 100, 600_000),
    ...(logsRpc ? { logsRpcUrls: logsRpc.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(opt("X429_EXPLORER") ? { explorer: opt("X429_EXPLORER") } : {}),
    descriptorExtras: { service: "render.x429.lol", api: `${publicUrl}/v1/render` },
  };
  return {
    host,
    port,
    publicUrl,
    chromiumPath,
    sandbox: bool("RENDER_CHROMIUM_SANDBOX", false),
    concurrency,
    freePerHour: int("RENDER_FREE_PER_HOUR", 30, 0, 100_000),
    trustProxy: bool("RENDER_TRUST_PROXY", false),
    robotsTtlMs: int("RENDER_ROBOTS_TTL_MS", 600_000, 0, 86_400_000),
    limits,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 ${ROBOTS_TOKEN}/${VERSION} (+${publicUrl})`,
    lane,
  };
}
