// Server configuration from environment variables. See .env.example for the full list.
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { BASE_CHAIN_ID, BASE_USDC, usdc } from "./protocol.ts";

export type Config = {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  contract: Address;
  queueId: number;
  operatorKey: Hex | undefined;
  host: string;
  port: number;
  publicUrl: string;
  explorer: string;
  /** The busy API admits one request per interval. */
  serviceIntervalMs: number;
  /** Admission round: the head is served only after waiting this long since the server first saw it. */
  minQueueMs: number;
  /** How long a served ticket may take to redeem its request. */
  admissionTtlMs: number;
  /** Ceiling over the quoted cost in the 402 (2000 = +20%). */
  slippageBps: number;
  /** x402 maxTimeoutSeconds: how long a signed authorization may stay valid. */
  paymentTimeoutS: number;
  /** How long a quote's ceiling is honoured (covers the passkey approval). */
  quoteTtlS: number;
  suggestedSkipPrice: bigint;
  /** Highest skip price a paid join or skip may post (bounds what a newcomer can make others pay). */
  maxSkipPrice: bigint;
  /** Where redeem tokens (hashed) are kept across restarts; unset keeps them in memory. */
  dataDir: string | undefined;
  /** Push compensation to passed owners automatically (operator payoutBatch). */
  autoPayout: boolean;
  payoutIntervalMs: number;
  /** Addresses of the operator's own demo agents, labeled as such in /queue, /feed and the dashboard. */
  demoAgents: Set<string>;
  /** Relayed joins per minute per client IP (each costs the operator gas). */
  joinsPerMinute: number;
  pollMs: number;
  deployBlock: bigint;
  siteDir: string | undefined;
  logJson: boolean;
};

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${name}`);
}

function address(name: string, fallback?: string): Address {
  const v = env(name, fallback);
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return getAddress(v);
}

function int(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(v);
}

function operatorKey(): Hex | undefined {
  const file = process.env.X429_OPERATOR_KEY_FILE;
  const raw = file ? readFileSync(file, "utf8").trim() : process.env.X429_OPERATOR_KEY?.trim();
  if (!raw) return undefined;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("operator key must be 32 bytes hex");
  return key;
}

export function loadConfig(): Config {
  const host = env("X429_HOST", "127.0.0.1");
  const port = int("X429_PORT", 8429);
  const interval = int("X429_SERVICE_INTERVAL_MS", 15_000);
  return {
    rpcUrl: env("X429_RPC_URL", "http://127.0.0.1:8545"),
    chainId: int("X429_CHAIN_ID", BASE_CHAIN_ID),
    usdc: address("X429_USDC", BASE_USDC),
    contract: address("X429_CONTRACT"),
    queueId: int("X429_QUEUE_ID", 1),
    operatorKey: operatorKey(),
    host,
    port,
    publicUrl: env("X429_PUBLIC_URL", `http://${host}:${port}`).replace(/\/$/, ""),
    explorer: env("X429_EXPLORER", "https://basescan.org").replace(/\/$/, ""),
    serviceIntervalMs: interval,
    minQueueMs: int("X429_MIN_QUEUE_MS", interval),
    admissionTtlMs: int("X429_ADMISSION_TTL_MS", 300_000),
    slippageBps: int("X429_SLIPPAGE_BPS", 2_000),
    paymentTimeoutS: int("X429_PAYMENT_TIMEOUT_S", 120),
    quoteTtlS: int("X429_QUOTE_TTL_S", 600),
    suggestedSkipPrice: usdc(env("X429_SUGGESTED_SKIP_PRICE", "0.005")),
    maxSkipPrice: usdc(env("X429_MAX_SKIP_PRICE", "0.1")),
    dataDir: process.env.X429_DATA_DIR || undefined,
    autoPayout: env("X429_AUTO_PAYOUT", "1") !== "0",
    payoutIntervalMs: int("X429_PAYOUT_INTERVAL_MS", 3_000),
    demoAgents: new Set(
      env("X429_DEMO_AGENTS", "")
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== ""),
    ),
    joinsPerMinute: int("X429_JOINS_PER_MINUTE", 30),
    pollMs: int("X429_POLL_MS", 1_000),
    deployBlock: BigInt(env("X429_DEPLOY_BLOCK", "0")),
    siteDir: process.env.X429_SITE_DIR || undefined,
    logJson: env("X429_LOG", "json") === "json",
  };
}
