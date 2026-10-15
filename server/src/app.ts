// HTTP routes: the busy API, x402 /skip, gasless /join and /claim, queue reads, the feed, MCP and the dashboard.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash } from "node:crypto";
import type { Address } from "viem";
import { CheckoutError, parseAddress, parseUint, type Checkout, type Log } from "./checkout.ts";
import type { Feed } from "./feed.ts";
import type { Gate } from "./gate.ts";
import { toJson } from "./json.ts";
import { handleMcp } from "./mcp.ts";
import {
  V1_RESPONSE_HEADER,
  V2_REQUIRED_HEADER,
  V2_RESPONSE_HEADER,
  encodeHeader,
  readPayment,
  settlementResponse,
  v1PaymentRequired,
  v2PaymentRequired,
} from "./x402.ts";

export const BUSY_PATH = "/v1/forecast";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-payment, payment-signature, x-429-ticket, x-429-signature, mcp-protocol-version",
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response, retry-after, x-429-queue",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers });
  res.end(toJson(body, 2));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new CheckoutError(413, "body_too_large", "request body over 64 KiB");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CheckoutError(400, "invalid_json", "request body is not JSON");
  }
}

/** A deterministic toy forecast: cheap to compute, looks like a real paid API response. */
function forecast(city: string) {
  const day = new Date().toISOString().slice(0, 10);
  const h = createHash("sha256").update(`${city}|${day}`).digest();
  const conditions = ["clear", "partly cloudy", "overcast", "light rain", "showers", "windy", "fog"];
  return {
    city,
    date: day,
    hours: Array.from({ length: 6 }, (_, i) => ({
      hour: `${String(9 + i * 2).padStart(2, "0")}:00`,
      tempC: 8 + (h[i]! % 18),
      rainPct: h[i + 6]! % 100,
      windKph: 4 + (h[i + 12]! % 30),
      sky: conditions[h[i + 18]! % conditions.length],
    })),
    model: "x429-toy-forecast-1",
  };
}

export type AppDeps = { checkout: Checkout; gate: Gate; feed: Feed; log: Log; siteDir?: string };

export function createApp({ checkout, gate, feed, log, siteDir }: AppDeps): Server {
  const cfg = checkout.cfg;

  async function skip(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = ((req.method === "POST" ? await readBody(req) : undefined) ?? {}) as Record<string, unknown>;
    const target = Number(url.searchParams.get("target") ?? body.target ?? 1);
    if (!Number.isInteger(target) || target < 1) throw new CheckoutError(400, "invalid_request", "target must be an integer >= 1");
    const queue = url.searchParams.get("queue");
    if (queue !== null && Number(queue) !== cfg.queueId) throw new CheckoutError(404, "unknown_queue", `this server runs queue ${cfg.queueId}`);
    const rawPrice = url.searchParams.get("skipPrice") ?? (body.skipPrice as string | undefined);
    const skipPrice = rawPrice !== undefined && rawPrice !== null ? parseUint(rawPrice, "skipPrice") : cfg.suggestedSkipPrice;
    const rawOwner = url.searchParams.get("owner");
    const ownerHint: Address | undefined = rawOwner ? parseAddress(rawOwner, "owner") : undefined;

    /** Answers with fresh payment requirements: for `owner` if possible, else for a newcomer. */
    const paymentRequired = async (status: number, error: string, extra: Record<string, unknown> = {}, owner = ownerHint, failure?: Record<string, unknown>) => {
      const headers: Record<string, string> = {};
      if (failure) {
        headers[V1_RESPONSE_HEADER] = encodeHeader(failure);
        headers[V2_RESPONSE_HEADER] = encodeHeader(failure);
      }
      const price = rawPrice ? skipPrice : undefined;
      let offer;
      let offerError: CheckoutError | undefined;
      for (const who of owner ? [owner, undefined] : [undefined]) {
        try {
          offer = await checkout.skipOffer(target, who, price, 0);
          break;
        } catch (err) {
          if (!(err instanceof CheckoutError)) throw err;
          offerError = err;
        }
      }
      if (!offer) {
        // nothing can be offered (e.g. the queue is empty): keep the failure, explain why
        const reason = status === 402 && !failure ? offerError!.reason : error;
        return send(res, status === 402 && !failure ? offerError!.status : status, { x402Version: 1, error: reason, accepts: [], message: offerError!.message, ...extra }, headers);
      }
      headers[V2_REQUIRED_HEADER] = encodeHeader(v2PaymentRequired(offer.requirements, error));
      send(res, status, { ...v1PaymentRequired(offer.requirements, error), ...extra, quote: checkout.quoteJson(offer.quote) }, headers);
    };

    const payment = readPayment(req.headers);
    if (!payment) return paymentRequired(402, "X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header is required");
    if ("error" in payment) return paymentRequired(400, payment.error, { message: payment.message });

    try {
      const r = await checkout.settleSkip(payment, target, skipPrice);
      const settlement = settlementResponse({ success: true, transaction: r.txHash, chainId: cfg.chainId, version: payment.version, payer: r.owner });
      const header = encodeHeader(settlement);
      send(
        res,
        200,
        {
          ok: true,
          ...r,
          costUsd: `$${(Number(r.cost) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`,
          message: r.refundedInFull
            ? "The payment arrived through a front-run transaction but the skip was no longer possible; it was refunded in full."
            : `You are now #${r.position}. Paid ${r.passes} agent(s) ${r.compensation} units in total, fee ${r.fee}, refunded ${r.refund}.`,
        },
        payment.version === 2 ? { [V2_RESPONSE_HEADER]: header } : { [V1_RESPONSE_HEADER]: header },
      );
    } catch (err) {
      if (!(err instanceof CheckoutError)) throw err;
      log({ evt: "skip_rejected", reason: err.reason, message: err.message, payer: payment.payload.authorization.from });
      const failure = settlementResponse({
        success: false,
        transaction: "",
        chainId: cfg.chainId,
        version: payment.version,
        payer: payment.payload.authorization.from,
        errorReason: err.reason,
      });
      if (err.status === 402) {
        return paymentRequired(402, err.reason, { message: err.message, ...err.details }, payment.payload.authorization.from, failure);
      }
      send(res, err.status, { error: err.reason, message: err.message, ...err.details }, {
        [V1_RESPONSE_HEADER]: encodeHeader(failure),
        [V2_RESPONSE_HEADER]: encodeHeader(failure),
      });
    }
  }

  async function busyApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const d = await gate.admit(req);
    if (d.kind === "reject") {
      return send(res, d.status, d.body, {
        ...(d.retryAfterS ? { "retry-after": String(d.retryAfterS) } : {}),
        "x-429-queue": `${cfg.contract}/${cfg.queueId}`,
      });
    }
    const city = (url.searchParams.get("city") ?? "Lisbon").slice(0, 60);
    const a = d.admission;
    send(res, 200, {
      ...forecast(city),
      admitted: a
        ? { via: "queue", ticketId: a.ticketId, waitedSeconds: a.waited, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, servedTx: a.servedTx }
        : { via: "direct" },
    });
  }

  async function staticFile(res: ServerResponse, pathname: string): Promise<boolean> {
    if (!siteDir) return false;
    const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(siteDir, rel);
    if (!file.startsWith(siteDir)) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (m === "OPTIONS") {
      res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" });
      return void res.end();
    }
    if (p === "/healthz") return send(res, 200, { ok: true, chainId: cfg.chainId, contract: cfg.contract, queueId: cfg.queueId, operator: checkout.relayer?.address ?? null });
    if (p === "/x429") return send(res, 200, gate.descriptor(await checkout.reader.get()));
    if (p === BUSY_PATH) return busyApi(req, res, url);
    if (p === "/skip" && (m === "POST" || m === "GET")) return skip(req, res, url);
    if (p === `/queue/${cfg.queueId}` || p === "/queue") {
      const owner = url.searchParams.get("owner");
      const ownerAddr = owner ? parseAddress(owner, "owner") : undefined;
      const s = await checkout.status(ownerAddr);
      return send(res, 200, { ...s, quotes: await checkout.quotes(ownerAddr), descriptor: gate.descriptor(checkout.reader.latest) });
    }
    if (p.startsWith("/queue/")) throw new CheckoutError(404, "unknown_queue", `this server runs queue ${cfg.queueId}`);
    if (p === "/join/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const price = url.searchParams.get("skipPrice");
      return send(res, 200, await checkout.joinTypedData(owner, price ? parseUint(price, "skipPrice") : undefined));
    }
    if (p === "/join" && m === "POST") return send(res, 200, await checkout.join((await readBody(req)) as never));
    if (p === "/claim/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const recipient = url.searchParams.get("recipient");
      return send(res, 200, await checkout.claimTypedData(owner, recipient ? parseAddress(recipient, "recipient") : undefined));
    }
    if (p === "/claim" && m === "POST") return send(res, 200, await checkout.claim((await readBody(req)) as never));
    if (p === "/feed") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const snap = checkout.reader.latest ?? (await checkout.reader.get());
      return send(res, 200, {
        chainId: cfg.chainId,
        contract: cfg.contract,
        queueId: cfg.queueId,
        explorer: cfg.explorer,
        totals: feed.totals,
        queue: checkout.queueJson(snap),
        events: feed.recent(limit),
      });
    }
    if (p === "/stats") return send(res, 200, { gate: gate.snapshotStats(), gas: checkout.relayer?.gas ?? [] });
    if (p === "/mcp") {
      const body = m === "POST" ? await readBody(req) : undefined;
      return handleMcp(checkout, BUSY_PATH, req, res, body);
    }
    if (m === "GET" && (await staticFile(res, p))) return;
    send(res, 404, { error: "not_found" });
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof CheckoutError) return send(res, err.status, { error: err.reason, message: err.message, ...err.details });
      log({ evt: "error", path: req.url, error: String((err as Error)?.stack ?? err).split("\n").slice(0, 3).join(" | ") });
      send(res, 500, { error: "internal_error" });
    });
  });
}
