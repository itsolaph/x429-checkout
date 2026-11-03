// The HTTP side of render.x429.lol, on node:http and the x429 package's public core API:
// `lane.routes.handle(req)` answers the lane routes (join, skip, use, ticket, quote, queue, feed),
// `lane.handle(req)` decides `GET /v1/render` (admitted, or 429 with the skip offer), and the lane's
// `serve` hook renders for a served ticket (inside a paid skip, on /use, or with X-429-Token).
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { CheckoutError, type Lane, type ServeHook, type ValidateHook } from "x429";
import { onFinished, send, toLaneRequest } from "x429/node";
import type { Buckets } from "./bucket.ts";
import { BlockedError, type Guard } from "./guard.ts";
import { hostPath, RenderError, type RenderRequest, type RenderResult, type Renderer } from "./renderer.ts";
import type { Robots } from "./robots.ts";

export type Log = (e: Record<string, unknown>) => void;

/** At most `size` renders at once; the rest wait their turn. The lane keeps it from queueing in practice. */
export class Slots {
  readonly size: number;
  active = 0;
  peak = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.size = size;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const MAX_WAIT_MS = 5000;

/** Reads render params from a query or a JSON body. Throws a 400 RenderError. */
export function parseParams(p: Record<string, unknown>): RenderRequest {
  const bad = (m: string) => new RenderError(400, "invalid_request", m);
  const url = typeof p.url === "string" ? p.url.trim() : undefined;
  if (!url) throw bad("url is required: /v1/render?url=https://example.com");
  if (url.length > 2048) throw bad("url is longer than 2048 characters");
  const format = p.format === undefined || p.format === "" ? "markdown" : p.format;
  if (format !== "markdown" && format !== "png") throw bad("format is markdown or png");
  let waitMs = 800;
  if (p.wait !== undefined && p.wait !== "") {
    const w = typeof p.wait === "number" ? p.wait : typeof p.wait === "string" && /^[0-9]{1,5}$/.test(p.wait) ? Number(p.wait) : NaN;
    if (!Number.isInteger(w) || w < 0 || w > MAX_WAIT_MS) throw bad(`wait is a whole number of milliseconds from 0 to ${MAX_WAIT_MS}`);
    waitMs = w;
  }
  let full = false;
  if (p.full !== undefined && p.full !== "") {
    if (p.full === "1" || p.full === 1 || p.full === true || p.full === "true") full = true;
    else if (p.full === "0" || p.full === 0 || p.full === false || p.full === "false") full = false;
    else throw bad("full is 0 or 1");
  }
  return { url, format, waitMs, full };
}

/** A render result as JSON (the PNG as base64 when it travels inside a lane answer). */
export function resultJson(r: RenderResult, withPng: boolean) {
  const common = { url: r.url, finalUrl: r.finalUrl, title: r.title, status: r.status };
  if (r.format === "markdown") {
    return { format: "markdown" as const, ...common, markdown: r.markdown, bytes: r.bytes, truncated: r.truncated, renderedMs: r.renderedMs };
  }
  return {
    format: "png" as const,
    ...common,
    contentType: "image/png",
    width: r.width,
    height: r.height,
    bytes: r.png.length,
    renderedMs: r.renderedMs,
    ...(withPng ? { png: r.png.toString("base64") } : {}),
  };
}

function errorOf(err: unknown, log: Log): RenderError {
  if (err instanceof RenderError) return err;
  if (err instanceof BlockedError) return new RenderError(403, "blocked_target", err.message);
  log({ evt: "render_internal_error", error: String((err as Error)?.stack ?? err).split("\n").slice(0, 3).join(" | ") });
  return new RenderError(500, "render_failed", "the render failed");
}

export type CoreDeps = {
  renderer: Renderer;
  guard: Guard;
  robots: Pick<Robots, "allowed">;
  slots: Slots;
  log: Log;
};

/** What the lane and the HTTP route share: checking a request, and rendering it. */
export function createCore(d: CoreDeps) {
  /** Checks params, the URL (SSRF, DNS included) and robots.txt, before any capacity is used. */
  const preflight = async (params: Record<string, unknown>): Promise<RenderRequest> => {
    const p = parseParams(params);
    try {
      await d.guard.check(p.url);
    } catch (err) {
      if (err instanceof BlockedError) throw new RenderError(403, "blocked_target", err.message);
      throw err;
    }
    if (!(await d.robots.allowed(p.url))) {
      const u = new URL(p.url);
      throw new RenderError(403, "robots_disallowed", `robots.txt of ${u.host} disallows ${u.pathname} for x429-render`);
    }
    return p;
  };

  const render = async (p: RenderRequest, via: string, signal?: AbortSignal, ticketId?: bigint): Promise<RenderResult> => {
    const t0 = Date.now();
    try {
      const r = await d.slots.run(() => d.renderer.render(p, signal));
      d.log({ evt: "render", via, ...(ticketId !== undefined ? { ticketId: ticketId.toString() } : {}), target: hostPath(p.url), format: p.format, status: 200, ms: Date.now() - t0, bytes: r.format === "png" ? r.png.length : r.bytes, pageStatus: r.status, requests: r.stats.requests, fetched: r.stats.bytes, blocked: r.stats.blocked, budgetHit: r.stats.budgetHit });
      return r;
    } catch (err) {
      const e = errorOf(err, d.log);
      d.log({ evt: "render", via, ...(ticketId !== undefined ? { ticketId: ticketId.toString() } : {}), target: hostPath(p.url), format: p.format, status: e.status, error: e.code, ms: Date.now() - t0 });
      throw e;
    }
  };

  const asCheckout = (err: unknown) => {
    const e = errorOf(err, d.log);
    return new CheckoutError(e.status, e.code, e.message);
  };

  /** Lane `validate`: refuses a bad URL before a paid skip settles; a skip without a url only moves the ticket. */
  const validate: ValidateHook = async (params, ctx) => {
    if (ctx.route === "skip" && (params.url === undefined || params.url === "")) return;
    try {
      await preflight(params);
    } catch (err) {
      throw asCheckout(err);
    }
  };

  /** Lane `serve`: the render for a served ticket. A failure throws, so the ticket can try again. */
  const serve: ServeHook = async (admission, params) => {
    try {
      const p = await preflight(params);
      return resultJson(await render(p, "ticket", undefined, admission.ticketId), true);
    } catch (err) {
      throw asCheckout(err);
    }
  };

  return { preflight, render, validate, serve, slots: d.slots };
}

export type Core = ReturnType<typeof createCore>;

export type HandlerDeps = {
  core: Core;
  lane: Lane;
  buckets: Buckets;
  renderer: Renderer;
  log: Log;
  landing: string;
  /** Behind a proxy that overwrites X-Forwarded-For (Caddy does): the client address is its last entry. */
  trustProxy: boolean;
  publicUrl: string;
  descriptorPath: string;
  freePerHour: number;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "x-429-token",
  "access-control-expose-headers": "retry-after, x-render-final-url, x-render-ms, x-render-status, x-429-position, x-429-queue, x-429-skip-cost, x-429-skip-url, link",
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers });
  res.end(JSON.stringify(body, null, 2));
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createHandler(h: HandlerDeps): RequestListener {
  const { core, lane, buckets, log } = h;

  const renderRoute = async (req: IncomingMessage, res: ServerResponse, url: URL, t0: number) => {
    const params = Object.fromEntries(url.searchParams);
    const target = typeof params.url === "string" ? hostPath(params.url) : undefined;
    const token = req.headers["x-429-token"];
    const ip = clientAddress(req, h.trustProxy);
    let p: RenderRequest | undefined;
    let took = false;
    const fail = (e: RenderError, via: string) => {
      sendJson(res, e.status, { error: e.code, message: e.message });
      log({ evt: "request", path: url.pathname, via, target, status: e.status, error: e.code, ms: Date.now() - t0 });
    };
    if (token === undefined) {
      try {
        p = await core.preflight(params);
      } catch (err) {
        return fail(errorOf(err, log), "refused");
      }
      if (!buckets.take(ip)) {
        const retry = buckets.retryAfterS(ip);
        sendJson(res, 429, {
          error: "rate_limited",
          message: `Free renders are limited to ${h.freePerHour} an hour per address; try again in about ${retry} s. Renders through the line (a ticket or a paid skip) are not limited: see ${h.publicUrl}${h.descriptorPath}.`,
          retryAfterSeconds: retry,
          descriptor: `${h.publicUrl}${h.descriptorPath}`,
        }, { "retry-after": String(retry) });
        log({ evt: "request", path: url.pathname, via: "rate_limited", target, status: 429, ms: Date.now() - t0 });
        return;
      }
      took = true;
    }

    const d = await lane.handle(toLaneRequest(req));
    if (d.action === "respond") {
      if (took) buckets.refund(ip);
      // a served ticket asking for a PNG on the API route gets the image itself
      if (token !== undefined && d.status === 200 && params.format === "png") {
        try {
          const b = JSON.parse(d.body) as { format?: string; png?: string; finalUrl?: string; renderedMs?: number; status?: number };
          if (b.format === "png" && typeof b.png === "string") {
            res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", ...CORS, "x-render-final-url": encodeURI(b.finalUrl ?? ""), "x-render-ms": String(b.renderedMs ?? 0), "x-render-status": String(b.status ?? 0) });
            res.end(Buffer.from(b.png, "base64"));
            log({ evt: "request", path: url.pathname, via: "ticket", target, status: 200, ms: Date.now() - t0 });
            return;
          }
        } catch {
          // not ours to reshape: send the lane's answer as it is
        }
      }
      send(res, { ...d, headers: { ...d.headers, ...CORS } });
      log({ evt: "request", path: url.pathname, via: token !== undefined ? "ticket" : "lane", target, status: d.status, ms: Date.now() - t0 });
      return;
    }

    onFinished(res, d.done);
    const ac = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    try {
      p ??= await core.preflight(params);
      const r = await core.render(p, d.via, ac.signal);
      if (r.format === "png") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", ...CORS, "x-render-final-url": encodeURI(r.finalUrl), "x-render-ms": String(r.renderedMs), "x-render-status": String(r.status) });
        res.end(r.png);
      } else sendJson(res, 200, resultJson(r, false));
      log({ evt: "request", path: url.pathname, via: d.via, target, status: 200, ms: Date.now() - t0 });
    } catch (err) {
      if (res.destroyed) return;
      fail(errorOf(err, log), d.via);
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://render.local");
    const m = req.method ?? "GET";
    const routed = await lane.routes.handle(toLaneRequest(req));
    if (routed) {
      send(res, routed);
      log({ evt: "request", path: url.pathname, status: routed.status, ms: Date.now() - t0 });
      return;
    }
    if (url.pathname === "/v1/render") {
      if (m === "OPTIONS") {
        res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" });
        return void res.end();
      }
      if (m !== "GET") return sendJson(res, 405, { error: "method_not_allowed", message: "GET /v1/render?url=..." }, { allow: "GET, OPTIONS" });
      return renderRoute(req, res, url, t0);
    }
    if ((m === "GET" || m === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      return void res.end(m === "HEAD" ? undefined : h.landing);
    }
    if (m === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        browser: h.renderer.ready ?? null,
        slots: { total: core.slots.size, busy: core.slots.active, waiting: core.slots.queued },
        operator: lane.operator ?? null,
      });
    }
    if (m === "GET" && url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" });
      return void res.end("User-agent: *\nDisallow: /v1/\nDisallow: /x429/\n");
    }
    sendJson(res, 404, { error: "not_found" });
  };

  return (req, res) => {
    void route(req, res).catch((err: unknown) => {
      log({ evt: "request_error", path: new URL(req.url ?? "/", "http://render.local").pathname, error: String((err as Error)?.message ?? err).split("\n")[0] });
      if (res.headersSent) return void res.end();
      sendJson(res, 500, { error: "internal_error" });
    });
  };
}

/** JSON lines, without query strings, bigints as decimal strings. */
export function jsonLogger(write: (line: string) => void): Log {
  return (e) => {
    try {
      write(JSON.stringify(scrubQueries({ t: new Date().toISOString(), ...e }), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    } catch {
      // a log line never breaks a request
    }
  };
}

/** Log entries without query strings: a URL or path keeps its host and path only. */
export function scrubQueries<T>(v: T): T {
  if (typeof v === "string") return v.replace(/((?:https?:\/\/|\/)[^\s"'?#]*)\?[^\s"']*/g, "$1?…") as T;
  if (Array.isArray(v)) return v.map(scrubQueries) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubQueries(x)])) as T;
  }
  return v;
}
