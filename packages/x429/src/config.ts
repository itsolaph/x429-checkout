// Lane options: what an API owner passes to `x429()`, validated into the internal `Config`.
// Errors name the option and what is wrong; they never echo a key.
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { BazaarOptions } from "./bazaar.ts";
import type { Admission } from "./gate.ts";
import { BASE_CHAIN_ID, BASE_USDC, usdc } from "./protocol.ts";

/** How much the protected API can take. */
export type CapacityOptions =
  /** Fixed service interval: one request per `perIntervalMs` (x429.lol runs this). */
  | { perIntervalMs: number; admissionRoundMs?: number }
  /** Admit while fewer than `concurrency` requests are in flight; the queue head is served as slots free. */
  | { concurrency: number; estimateMs?: number; admissionRoundMs?: number };

export type Capacity =
  | { model: "interval"; perIntervalMs: number }
  | { model: "concurrency"; concurrency: number; estimateMs: number };

/**
 * Builds the API answer for a served ticket, so x429 can answer it itself: inside the paid `/skip`
 * that reached #1 (one paid call = answer + receipt), on `/use`, and on a request with `X-429-Token`.
 * The answer is kept for the admission window: asking again returns the same answer. `params` are
 * the request's extra fields (body and query of `/skip`, body of `/use`, query of the protected route).
 * Without this hook a served ticket's request goes through to your handler once, with `X-429-Token`.
 */
export type ServeHook = (admission: Admission, params: Record<string, unknown>) => unknown;

export type LogEntry = Record<string, unknown> & { evt?: string };

export type X429Options = {
  /** Your X429Checkout contract (deploy one with `npx x429 deploy`). */
  contract: string;
  /** JSON-RPC URL of the chain the contract is on. */
  rpcUrl: string;
  /** Public origin of your API (https in production). x402 resource URLs and the descriptor use it. */
  publicUrl: string;
  capacity: CapacityOptions;
  queueId?: number;
  /** The contract's operator key (hex). Without one the lane is read-only: 429s and quotes, no settlement. */
  operatorKey?: string;
  /** A file holding the operator key (alternative to `operatorKey`). */
  operatorKeyFile?: string;
  chainId?: number;
  usdc?: string;
  /** Where the x429 routes live (`/x429/join`, `/x429/skip`, ...). `""` mounts them at the root. */
  prefix?: string;
  explorer?: string;
  /** RPCs the event feed reads (getLogs), rotated on errors. Default: `[rpcUrl]`. */
  logsRpcUrls?: string[];
  /** First block the event feed indexes (the contract's deploy block). */
  deployBlock?: bigint | number | string;
  /** Where hashed redeem tokens, admissions, paid responses and feed progress survive restarts. */
  dataDir?: string;
  /** How long a served ticket may take to use its request. */
  admissionTtlMs?: number;
  /** Ceiling over the quoted cost in the 402 (2000 = +20%). */
  slippageBps?: number;
  /** x402 maxTimeoutSeconds. */
  paymentTimeoutS?: number;
  quoteTtlS?: number;
  /** Default skip price of a new ticket: USDC as a decimal string ("0.005") or base units (bigint). */
  suggestedSkipPrice?: string | bigint;
  /** Highest skip price a join or skip may post. */
  maxSkipPrice?: string | bigint;
  /** Push compensation to passed owners (operator `payoutBatch`). Default true. */
  autoPayout?: boolean;
  payoutIntervalMs?: number;
  /** A paid skip to #1 waits for its serve receipt before answering. Default true. */
  serveConfirm?: boolean;
  pollMs?: number;
  serve?: ServeHook;
  bazaar?: BazaarOptions;
  /** Addresses of your own filler agents (labeled `demo`; not served while only they wait). */
  demoAgents?: string[];
  holdDemoOnly?: boolean;
  /** Keep the v0.2 gasless EIP-712 join relay open (the operator pays its gas). Default false. */
  legacyJoin?: boolean;
  /** Legacy relayed joins per minute per client. */
  joinsPerMinute?: number;
  /** Fields appended to the descriptor (`GET {prefix}`). */
  descriptorExtras?: Record<string, unknown>;
  /** Receives every log entry (JSON-safe except bigints). Never contains the operator key. */
  logger?: (entry: LogEntry) => void;
  /** Start the operator loop, payouts and feed when `x429()` resolves. Default true. */
  autoStart?: boolean;
};

export type Config = {
  rpcUrl: string;
  logsRpcUrls: string[];
  chainId: number;
  usdc: Address;
  contract: Address;
  queueId: number;
  publicUrl: string;
  /** Route prefix ("" or "/something"). */
  prefix: string;
  /** publicUrl + prefix: where /join, /skip, /use ... are. */
  routeBase: string;
  /** Where the descriptor is: the prefix itself, or /x429 when the routes are at the root. */
  descriptorUrl: string;
  explorer: string;
  capacity: Capacity;
  /** Interval model: the service interval. Concurrency model: the initial per-position estimate. */
  serviceIntervalMs: number;
  /** Admission round: the head is served only after waiting this long since the lane first saw it. */
  minQueueMs: number;
  admissionTtlMs: number;
  slippageBps: number;
  paymentTimeoutS: number;
  quoteTtlS: number;
  suggestedSkipPrice: bigint;
  maxSkipPrice: bigint;
  dataDir: string | undefined;
  autoPayout: boolean;
  payoutIntervalMs: number;
  demoAgents: Set<string>;
  serveConfirm: boolean;
  holdDemoOnly: boolean;
  legacyJoin: boolean;
  joinsPerMinute: number;
  pollMs: number;
  deployBlock: bigint;
  descriptorExtras: Record<string, unknown>;
};

export class OptionsError extends Error {
  constructor(message: string) {
    super(`x429: ${message}`);
    this.name = "OptionsError";
  }
}

const KNOWN = new Set([
  "contract", "rpcUrl", "publicUrl", "capacity", "queueId", "operatorKey", "operatorKeyFile", "chainId", "usdc", "prefix",
  "explorer", "logsRpcUrls", "deployBlock", "dataDir", "admissionTtlMs", "slippageBps", "paymentTimeoutS", "quoteTtlS",
  "suggestedSkipPrice", "maxSkipPrice", "autoPayout", "payoutIntervalMs", "serveConfirm", "pollMs", "serve", "bazaar",
  "demoAgents", "holdDemoOnly", "legacyJoin", "joinsPerMinute", "descriptorExtras", "logger", "autoStart",
]);

function fail(message: string): never {
  throw new OptionsError(message);
}

function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  if (typeof v === "bigint") return `${v}n`;
  return typeof v === "object" ? (v === null ? "null" : Array.isArray(v) ? "an array" : "an object") : String(v);
}

function addr(name: string, v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) fail(`${name} must be an 0x address (got ${show(v)})`);
  return getAddress(v);
}

function httpUrl(name: string, v: unknown): string {
  if (typeof v !== "string") fail(`${name} must be an http(s) URL (got ${show(v)})`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return fail(`${name} must be an http(s) URL (got ${show(v)})`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail(`${name} must be an http(s) URL (got ${show(v)})`);
  return v;
}

function int(name: string, v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer from ${min} to ${max} (got ${show(v)})`);
  return v;
}

function bool(name: string, v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail(`${name} must be true or false (got ${show(v)})`);
  return v;
}

function amount(name: string, v: unknown, fallback: string): bigint {
  if (v === undefined) return usdc(fallback);
  if (typeof v === "bigint") {
    if (v < 0n) fail(`${name} must not be negative`);
    return v;
  }
  if (typeof v !== "string" || !/^[0-9]+(\.[0-9]{1,6})?$/.test(v)) fail(`${name} must be a USDC amount like "0.005" or base units as a bigint (got ${show(v)})`);
  return usdc(v);
}

/** A 32-byte hex private key from `operatorKey` or `operatorKeyFile`. The value never appears in an error. */
export function readOperatorKey(key: unknown, file: unknown): Hex | undefined {
  if (key !== undefined && file !== undefined) fail("pass operatorKey or operatorKeyFile, not both");
  let raw: string | undefined;
  if (file !== undefined) {
    if (typeof file !== "string" || file === "") fail("operatorKeyFile must be a file path");
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch (err) {
      fail(`cannot read operatorKeyFile (${(err as NodeJS.ErrnoException)?.code ?? "error"})`);
    }
  } else if (key !== undefined) {
    if (typeof key !== "string") fail("operatorKey must be a hex string");
    raw = key.trim();
  }
  if (!raw) return undefined;
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) fail("the operator key must be 32 bytes of hex");
  return hex;
}

function capacity(v: unknown): { capacity: Capacity; serviceIntervalMs: number; minQueueMs: number } {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("capacity must be { perIntervalMs } or { concurrency }");
  const c = v as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!["perIntervalMs", "concurrency", "estimateMs", "admissionRoundMs"].includes(k)) fail(`capacity.${k} is not an option`);
  }
  if ((c.perIntervalMs === undefined) === (c.concurrency === undefined)) fail("capacity needs exactly one of perIntervalMs or concurrency");
  if (c.perIntervalMs !== undefined) {
    if (c.estimateMs !== undefined) fail("capacity.estimateMs only applies to { concurrency }");
    const perIntervalMs = int("capacity.perIntervalMs", c.perIntervalMs, 0, 1, 86_400_000);
    return {
      capacity: { model: "interval", perIntervalMs },
      serviceIntervalMs: perIntervalMs,
      minQueueMs: int("capacity.admissionRoundMs", c.admissionRoundMs, perIntervalMs, 0, 86_400_000),
    };
  }
  const concurrency = int("capacity.concurrency", c.concurrency, 0, 1, 100_000);
  const estimateMs = int("capacity.estimateMs", c.estimateMs, 1_000, 1, 86_400_000);
  return {
    capacity: { model: "concurrency", concurrency, estimateMs },
    serviceIntervalMs: Math.max(1, Math.ceil(estimateMs / concurrency)),
    minQueueMs: int("capacity.admissionRoundMs", c.admissionRoundMs, 0, 0, 86_400_000),
  };
}

/** Validates `x429()` options. Returns the config and the operator key separately (the key is never in the config). */
export function resolveOptions(o: X429Options): { cfg: Config; operatorKey: Hex | undefined } {
  if (!o || typeof o !== "object") fail("options must be an object");
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) fail(`unknown option ${JSON.stringify(k)}`);
  const contract = addr("contract", o.contract);
  const rpcUrl = httpUrl("rpcUrl", o.rpcUrl);
  const publicUrl = httpUrl("publicUrl", o.publicUrl).replace(/\/+$/, "");
  if (new URL(publicUrl).pathname !== "/" && new URL(publicUrl).pathname !== "") fail("publicUrl must be an origin without a path (use prefix for the route path)");
  const prefix = o.prefix === undefined ? "/x429" : o.prefix;
  if (typeof prefix !== "string" || !(prefix === "" || /^\/[A-Za-z0-9._~\-/]*[A-Za-z0-9._~-]$/.test(prefix))) {
    fail(`prefix must be "" or a path like "/x429" without a trailing slash (got ${show(prefix)})`);
  }
  const logs = o.logsRpcUrls ?? [];
  if (!Array.isArray(logs)) fail("logsRpcUrls must be an array of URLs");
  const logsRpcUrls = logs.map((u, i) => httpUrl(`logsRpcUrls[${i}]`, u));
  let deployBlock = 0n;
  if (o.deployBlock !== undefined) {
    const d = o.deployBlock;
    if (!(typeof d === "bigint" || (typeof d === "number" && Number.isSafeInteger(d)) || (typeof d === "string" && /^[0-9]+$/.test(d)))) {
      fail(`deployBlock must be a block number (got ${show(d)})`);
    }
    deployBlock = BigInt(d);
    if (deployBlock < 0n) fail("deployBlock must not be negative");
  }
  const dataDir = o.dataDir;
  if (dataDir !== undefined && (typeof dataDir !== "string" || dataDir === "")) fail("dataDir must be a directory path");
  const demo = o.demoAgents ?? [];
  if (!Array.isArray(demo)) fail("demoAgents must be an array of addresses");
  const demoAgents = new Set(demo.map((a, i) => addr(`demoAgents[${i}]`, a).toLowerCase()));
  if (o.serve !== undefined && typeof o.serve !== "function") fail("serve must be a function (admission, params) => answer");
  if (o.logger !== undefined && typeof o.logger !== "function") fail("logger must be a function");
  const extras = o.descriptorExtras ?? {};
  if (typeof extras !== "object" || extras === null || Array.isArray(extras)) fail("descriptorExtras must be an object");
  const cap = capacity(o.capacity);
  const suggestedSkipPrice = amount("suggestedSkipPrice", o.suggestedSkipPrice, "0.005");
  const maxSkipPrice = amount("maxSkipPrice", o.maxSkipPrice, "0.1");
  if (suggestedSkipPrice > maxSkipPrice) fail("suggestedSkipPrice must not be above maxSkipPrice");
  const operatorKey = readOperatorKey(o.operatorKey, o.operatorKeyFile);
  const cfg: Config = {
    rpcUrl,
    logsRpcUrls: logsRpcUrls.length > 0 ? logsRpcUrls : [rpcUrl],
    chainId: int("chainId", o.chainId, BASE_CHAIN_ID, 1),
    usdc: o.usdc === undefined ? BASE_USDC : addr("usdc", o.usdc),
    contract,
    queueId: int("queueId", o.queueId, 1, 1, 2 ** 32 - 1),
    publicUrl,
    prefix,
    routeBase: `${publicUrl}${prefix}`,
    descriptorUrl: `${publicUrl}${prefix || "/x429"}`,
    explorer: (o.explorer === undefined ? "https://basescan.org" : httpUrl("explorer", o.explorer)).replace(/\/+$/, ""),
    capacity: cap.capacity,
    serviceIntervalMs: cap.serviceIntervalMs,
    minQueueMs: cap.minQueueMs,
    admissionTtlMs: int("admissionTtlMs", o.admissionTtlMs, 300_000, 1_000),
    slippageBps: int("slippageBps", o.slippageBps, 2_000, 0, 100_000),
    paymentTimeoutS: int("paymentTimeoutS", o.paymentTimeoutS, 120, 10, 86_400),
    quoteTtlS: int("quoteTtlS", o.quoteTtlS, 600, 1, 86_400),
    suggestedSkipPrice,
    maxSkipPrice,
    dataDir,
    autoPayout: bool("autoPayout", o.autoPayout, true),
    payoutIntervalMs: int("payoutIntervalMs", o.payoutIntervalMs, 3_000, 100),
    demoAgents,
    serveConfirm: bool("serveConfirm", o.serveConfirm, true),
    holdDemoOnly: bool("holdDemoOnly", o.holdDemoOnly, true),
    legacyJoin: bool("legacyJoin", o.legacyJoin, false),
    joinsPerMinute: int("joinsPerMinute", o.joinsPerMinute, 30, 0),
    pollMs: int("pollMs", o.pollMs, 1_000, 50),
    deployBlock,
    descriptorExtras: extras,
  };
  bool("autoStart", o.autoStart, true);
  return { cfg, operatorKey };
}
