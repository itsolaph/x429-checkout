// x429 Checkout as a PayBox plugin: a busy API's queue where agents pay the agents waiting ahead of
// them (USDC on Base, x402) to move up, and get paid automatically when someone passes them.
//
// Every call runs in a fresh sandbox: nothing is kept between calls. Reads are plain HTTPS calls to
// X429_API_BASE; the two money steps (join, skip) return an x402 proposal that PayBox pays after the
// user approves. The paid response (with the redeem token) reaches the agent through PayBox.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { atomicAmount, proposeX402, x402OutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
const FETCH_TIMEOUT_MS = 4_000;
const PROPOSAL_TTL_MS = 240_000;
const MAX_SKIP_PRICE_USDC = "0.1";

// ------------------------------------------------------------------ configuration

type Base = { api: string; proposal: string };

const NOT_CONFIGURED =
  "x429 is not configured: the plugin owner must set the X429_API_BASE variable (the https origin of the x429 server) in the PayBox portal.";

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * X429_API_BASE is the https origin of the x429 server. Plain http is accepted only for a loopback
 * host (local testing); then X429_PROPOSAL_ORIGIN (https) is put into x402 proposals instead, since
 * PayBox only pays HTTPS on port 443.
 */
function readBase(): Base | { error: string } {
  const raw = process.env.X429_API_BASE?.trim();
  if (!raw) return { error: NOT_CONFIGURED };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "X429_API_BASE is not a valid URL." };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { error: "X429_API_BASE must be a bare origin such as https://x429.example.com" };
  }
  if (url.protocol === "https:") return { api: url.origin, proposal: url.origin };
  if (url.protocol === "http:" && isLoopback(url.hostname)) {
    const p = process.env.X429_PROPOSAL_ORIGIN?.trim();
    if (!p || !p.startsWith("https://")) return { error: "With a local http X429_API_BASE, set X429_PROPOSAL_ORIGIN to an https origin." };
    return { api: url.origin, proposal: new URL(p).origin };
  }
  return { error: "X429_API_BASE must use https." };
}

class ToolError extends Error {}

function base(): Base {
  const b = readBase();
  if ("error" in b) throw new ToolError(b.error);
  return b;
}

/** One bounded JSON call to the x429 server. Non-2xx answers are returned, not thrown. */
async function api(b: Base, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(`${b.api}${path}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = (err as Error)?.name === "TimeoutError";
    throw new ToolError(timeout ? "The x429 server did not answer within 4 seconds; try again." : "Could not reach the x429 server.");
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}

function serverError(r: { status: number; data: any }): never {
  const msg = typeof r.data?.message === "string" ? r.data.message : typeof r.data?.error === "string" ? r.data.error : `HTTP ${r.status}`;
  throw new ToolError(`x429 server: ${msg}`);
}

// ------------------------------------------------------------------ helpers

const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const token = z.string().regex(/^x429_[A-Za-z0-9_-]{43}$/).describe("Redeem token from the paid x429 join or skip response (starts with x429_).");
const usdcDecimal = z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/);

function usd(v: unknown): string {
  const n = BigInt(String(v ?? 0));
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole}${frac ? `.${frac}` : ""}`;
}

function str(v: unknown): string {
  return String(v ?? "0");
}

function whole(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ok<T extends Record<string, unknown>>(text: string, structuredContent: T) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function fail(err: unknown) {
  const text = err instanceof ToolError || err instanceof Error ? err.message : "Unexpected error.";
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Runs a tool body; known failures become a tool error with a clear message. */
async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

/** The owner address behind a token (null if the server does not know the token). */
async function ownerOf(b: Base, t: string): Promise<string> {
  const r = await api(b, "POST", "/ticket", { token: t });
  if (r.status !== 200) serverError(r);
  return r.data.owner as string;
}

// ------------------------------------------------------------------ schemas

const position = z.object({
  position: z.number().int(),
  skipPrice: units.describe("USDC units this ticket is paid each time someone passes it"),
  costToReach: units.describe("what a newcomer pays now to reach this position (fee included)"),
  etaSeconds: z.number().int(),
  demo: z.boolean().describe("true for the operator's own demo agents"),
}).strict();

const ticketView = z.object({
  ticketId: z.string(),
  owner: z.string(),
  status: z.string().describe("waiting, ready (served, call x429_use), used, serving, expired, left or unknown"),
  position: z.number().int().nullable(),
  etaSeconds: z.number().int().nullable(),
  skipPrice: units.nullable(),
  earned: units.nullable(),
  claimable: units,
}).strict();

const statusOutput = z.object({
  configured: z.boolean(),
  message: z.string(),
  queue: z.object({
    length: z.number().int(),
    maxLength: z.number().int(),
    joinFee: units,
    serviceIntervalSeconds: z.number(),
    etaSecondsForNewcomer: z.number().int(),
    positions: z.array(position),
    contract: z.string(),
    network: z.string(),
  }).strict().optional(),
  you: ticketView.optional(),
  next: z.string(),
}).strict();

const quoteOutput = z.object({
  targetPosition: z.number().int(),
  fromPosition: z.number().int(),
  passes: z.number().int(),
  compensation: units,
  fee: units,
  cost: units,
  costUsd: z.string(),
  ceiling: units.describe("cost plus the slippage buffer: the most the skip payment authorizes; the unused part is refunded"),
  ceilingUsd: z.string(),
  quoteExpiresAt: z.string(),
  passed: z.array(z.object({ position: z.number().int(), owner: z.string(), amount: units }).strict()),
  next: z.string(),
}).strict();

const useOutput = z.object({
  status: z.string().describe("served (result included), waiting, serving, expired or left"),
  ticketId: z.string(),
  position: z.number().int().nullable(),
  etaSeconds: z.number().int().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  skipToFrontCost: units.nullable(),
  message: z.string(),
}).strict();

const earningsOutput = z.object({
  address: z.string(),
  earned: units,
  earnedUsd: z.string(),
  timesPassed: z.number().int(),
  received: units,
  receivedUsd: z.string(),
  claimable: units,
  message: z.string(),
}).strict();

// ------------------------------------------------------------------ tools

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PAY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function createServer() {
  const server = new McpServer({ name: "x429-checkout", version: "0.3.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "x429_status",
    {
      title: "x429 queue status",
      description:
        "Free price discovery, no payment: the x429 line in front of a busy API (HTTP 429 with a price). Shows how many agents wait (demo agents are labeled), each position's posted skip price, what reaching each position costs right now, the join fee and the wait. " +
        "Pass your redeem token to see your own ticket. Next: x429_quote, then x429_skip to pay and get the API answer in the same call; or x429_join to wait for free-ish and x429_use later.",
      inputSchema: z.object({ token: token.optional() }).strict(),
      outputSchema: statusOutput,
      annotations: READ,
    },
    async ({ token: t }) => {
      const b = readBase();
      if ("error" in b) {
        return ok(b.error, { configured: false, message: b.error, next: "Ask the plugin owner to configure X429_API_BASE." });
      }
      return guard(async () => {
        const [q, mine] = await Promise.all([api(b, "GET", "/queue"), t ? api(b, "POST", "/ticket", { token: t }) : Promise.resolve(undefined)]);
        if (q.status !== 200) serverError(q);
        if (mine && mine.status !== 200) serverError(mine);
        const d = q.data;
        const interval = Number(d.serviceIntervalMs ?? 0);
        const costs = new Map<number, string>((d.quotes ?? []).map((x: any) => [Number(x.targetPosition), str(x.cost)]));
        const positions = (d.queue.tickets ?? []).map((x: any) => ({
          position: Number(x.position),
          skipPrice: str(x.skipPrice),
          costToReach: costs.get(Number(x.position)) ?? "0",
          etaSeconds: Math.max(1, Math.ceil(((Number(x.position) - 1) * interval) / 1000)),
          demo: x.demo === true,
        }));
        const you = mine
          ? {
              ticketId: str(mine.data.ticketId),
              owner: str(mine.data.owner),
              status: str(mine.data.status),
              position: mine.data.ticket?.position ?? mine.data.position ?? null,
              etaSeconds: mine.data.etaSeconds ?? null,
              skipPrice: mine.data.ticket ? str(mine.data.ticket.skipPrice) : null,
              earned: mine.data.ticket ? str(mine.data.ticket.earned) : null,
              claimable: str(mine.data.claimable),
            }
          : undefined;
        const length = Number(d.queue.length);
        const message =
          length === 0
            ? `The queue is empty; joining costs ${usd(d.joinFee)}.`
            : `${length} agent(s) waiting. Joining costs ${usd(d.joinFee)} and puts you at #${length + 1}; reaching #1 costs ${usd(costs.get(1) ?? 0)} right now, paid to the agents you pass.` +
              (you ? ` Your ticket #${you.ticketId}: ${you.status}${you.position ? ` at #${you.position}` : ""}.` : "");
        return ok(message, {
          configured: true,
          message,
          queue: {
            length,
            maxLength: Number(d.queue.maxLength),
            joinFee: str(d.joinFee),
            serviceIntervalSeconds: interval / 1000,
            etaSecondsForNewcomer: Number(d.etaSecondsForNewcomer ?? 0),
            positions,
            contract: str(d.queue.contract),
            network: str(d.queue.network),
          },
          ...(you ? { you } : {}),
          next: you
            ? you.status === "ready"
              ? "You are served: call x429_use with your token now."
              : "Call x429_use with your token to get the API result once you are served, or x429_skip to move up."
            : "Call x429_join to get in line (or x429_skip to join and move up in one payment).",
        });
      });
    },
  );

  server.registerTool(
    "x429_quote",
    {
      title: "Quote a skip",
      description:
        "Free price discovery, no payment: what moving to `targetPosition` (1 = served next) costs right now. The cost is paid to each agent you pass at its own posted price (plus any operator fee); the ceiling is what the payment authorizes (cost + buffer, the unused part refunded in the same transaction); the quote has an expiry. " +
        "Pass your token (or wallet address) if you already wait in line. Next: show the user the cost, then x429_skip with the same target.",
      inputSchema: z.object({ targetPosition: z.number().int().min(1).max(256), token: token.optional(), owner: address.optional() }).strict(),
      outputSchema: quoteOutput,
      annotations: READ,
    },
    async ({ targetPosition, token: t, owner }) =>
      guard(async () => {
        const b = base();
        const r = await api(b, "POST", "/quote", { target: targetPosition, ...(t ? { token: t } : owner ? { owner } : {}) });
        if (r.status !== 200) serverError(r);
        const d = r.data;
        const out = {
          targetPosition,
          fromPosition: Number(d.fromPosition),
          passes: Number(d.passes),
          compensation: str(d.compensation),
          fee: str(d.fee),
          cost: str(d.cost),
          costUsd: usd(d.cost),
          ceiling: str(d.maxAmountRequired),
          ceilingUsd: usd(d.maxAmountRequired),
          quoteExpiresAt: whole(Number(d.quoteExpiresAt) * 1000),
          passed: (d.passed ?? []).map((p: any) => ({ position: Number(p.position), owner: str(p.owner), amount: str(p.amount) })),
          next: `Call x429_skip with targetPosition ${targetPosition} to get the payment proposal (at most ${usd(d.maxAmountRequired)}).`,
        };
        return ok(`Moving from #${out.fromPosition} to #${targetPosition} costs ${out.costUsd} now (passes ${out.passes}); the payment authorizes up to ${out.ceilingUsd} and refunds the rest.`, out);
      }),
  );

  server.registerTool(
    "x429_join",
    {
      title: "Join the queue (x402)",
      description:
        "Returns a PayBox x402 payment proposal for joining the x429 queue at the back. The join fee is tiny (see x429_status); you choose `skipPriceUsdc`, what anyone who passes you must pay you (sent to your wallet automatically). " +
        "After the user approves and PayBox pays, the paid response contains your ticketId, position and a redeem token: keep the token and pass it to x429_use, x429_status and x429_quote. Do not call this again to poll.",
      inputSchema: z.object({ skipPriceUsdc: usdcDecimal.optional().describe("USDC (decimal, e.g. \"0.005\") you are paid each time someone passes you; at most 0.1") }).strict(),
      outputSchema: x402OutputSchema,
      annotations: PAY,
    },
    async ({ skipPriceUsdc }) =>
      guard(async () => {
        const b = base();
        const skipPrice = skipPriceUsdc === undefined ? undefined : atomicAmount(skipPriceUsdc, 6);
        if (skipPrice !== undefined && BigInt(skipPrice) > BigInt(atomicAmount(MAX_SKIP_PRICE_USDC, 6))) throw new ToolError("skipPriceUsdc is at most 0.1");
        const r = await api(b, "GET", "/quote");
        if (r.status !== 200) serverError(r);
        const fee = BigInt(str(r.data.joinFee));
        return proposeX402({
          chain: "eip155:8453",
          url: `${b.proposal}/join`,
          method: "POST",
          body: skipPrice === undefined ? {} : { skipPrice },
          maxAmount: (fee > 0n ? fee : 1n).toString(),
        });
      }),
  );

  server.registerTool(
    "x429_skip",
    {
      title: "Skip ahead (x402)",
      description:
        "Returns a PayBox x402 payment proposal (one passkey approval) that moves you to `targetPosition` (1 = served next), paying each agent you pass its own posted price; they get the USDC automatically. No ticket yet? The same payment joins you first. " +
        "The maximum is the live ceiling from x429_quote; you are charged the actual cost and the rest is refunded in the same transaction. " +
        "For targetPosition 1 the paid response contains the API answer (`result`, e.g. the forecast for `city`) and a `receipt` (who was paid what, fee, refund, basescan link, wait saved): show both to the user, nothing else to call. " +
        "If the service is busy it holds your position, ETA and a redeem token instead: then call x429_use with the token.",
      inputSchema: z
        .object({
          targetPosition: z.number().int().min(1).max(256),
          token: token.optional(),
          owner: address.optional().describe("Your wallet address, if you have no token but already wait in line"),
          skipPriceUsdc: usdcDecimal.optional().describe("Only for a new ticket: what you are paid each time someone passes you (at most 0.1 USDC)"),
          city: z.string().min(1).max(60).optional().describe("For the busy API's answer (a city forecast), e.g. \"Lisbon\""),
        })
        .strict(),
      outputSchema: x402OutputSchema,
      annotations: PAY,
    },
    async ({ targetPosition, token: t, owner, skipPriceUsdc, city }) =>
      guard(async () => {
        const b = base();
        const skipPrice = skipPriceUsdc === undefined ? undefined : atomicAmount(skipPriceUsdc, 6);
        if (skipPrice !== undefined && BigInt(skipPrice) > BigInt(atomicAmount(MAX_SKIP_PRICE_USDC, 6))) throw new ToolError("skipPriceUsdc is at most 0.1");
        const who = t ? await ownerOf(b, t) : owner;
        const r = await api(b, "POST", "/quote", { target: targetPosition, ...(who ? { owner: who } : {}) });
        if (r.status !== 200) serverError(r);
        const expires = Math.min(Date.now() + PROPOSAL_TTL_MS, Number(r.data.quoteExpiresAt) * 1000);
        // the body is public: it carries the target and the payer's address, never the token
        return proposeX402({
          chain: "eip155:8453",
          url: `${b.proposal}/skip`,
          method: "POST",
          body: { target: targetPosition, ...(who ? { owner: who } : {}), ...(skipPrice === undefined ? {} : { skipPrice }), ...(city ? { city } : {}) },
          maxAmount: str(r.data.maxAmountRequired),
          expiresAt: whole(expires),
        });
      }),
  );

  server.registerTool(
    "x429_use",
    {
      title: "Use the busy API with your ticket",
      description:
        "Calls the busy API with your redeem token. Once your ticket is served it returns the API result (a city forecast in this demo; pass `city`); calling again within the admission window returns the same result. " +
        "While you wait it returns your position and ETA: wait about etaSeconds and call again, or use x429_quote and x429_skip to move up. No payment.",
      inputSchema: z.object({ token, city: z.string().min(1).max(60).optional() }).strict(),
      outputSchema: useOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ token: t, city }) =>
      guard(async () => {
        const b = base();
        const r = await api(b, "POST", "/use", { token: t, ...(city ? { city } : {}) });
        const d = r.data ?? {};
        if (r.status === 200 && d.status === "served") {
          const result = d.result as Record<string, unknown>;
          const message = typeof result?.summary === "string" ? result.summary : "Served.";
          return ok(`Served. ${message}`, { status: "served", ticketId: str(d.ticketId), position: null, etaSeconds: null, result, skipToFrontCost: null, message });
        }
        if (r.status === 429 && typeof d.status === "string") {
          const message = `${d.message ?? "Waiting."} Call x429_use again in about ${d.etaSeconds} s.`;
          return ok(message, {
            status: d.status,
            ticketId: str(d.ticketId),
            position: d.position ?? null,
            etaSeconds: d.etaSeconds ?? null,
            result: null,
            skipToFrontCost: d.skipToFront ? str(d.skipToFront.cost) : null,
            message,
          });
        }
        if (r.status === 410) {
          const message = `${d.message ?? "This ticket can no longer be used."} Call x429_join for a new ticket.`;
          return ok(message, { status: str(d.status), ticketId: str(d.ticketId), position: null, etaSeconds: null, result: null, skipToFrontCost: null, message });
        }
        serverError(r);
      }),
  );

  server.registerTool(
    "x429_earnings",
    {
      title: "Earnings of an address",
      description:
        "Public read: how much USDC an address earned for being passed in the x429 queue, how much already reached its wallet (sent automatically by the operator) and what is still pending. No payment and nothing to claim. " +
        "Next: x429_status to see the queue, or keep waiting with x429_use.",
      inputSchema: z.object({ address }).strict(),
      outputSchema: earningsOutput,
      annotations: READ,
    },
    async ({ address: a }) =>
      guard(async () => {
        const b = base();
        const r = await api(b, "GET", `/earnings/${a}`);
        if (r.status !== 200) serverError(r);
        const d = r.data;
        const message = `${a} earned ${usd(d.earned)} from being passed ${d.timesPassed} time(s); ${usd(d.received)} reached its wallet, ${usd(d.claimable)} pending.`;
        return ok(message, {
          address: str(d.address),
          earned: str(d.earned),
          earnedUsd: usd(d.earned),
          timesPassed: Number(d.timesPassed),
          received: str(d.received),
          receivedUsd: usd(d.received),
          claimable: str(d.claimable),
          message,
        });
      }),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
