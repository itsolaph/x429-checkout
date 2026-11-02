// x429.lol: the busy forecast API behind an x429 lane, plus what is specific to this server: the
// legacy MCP endpoint and its plugin manifest, /healthz and the dashboard. Every x429 route (/join,
// /skip, /use, /ticket, /quote, /queue, /earnings, /feed, /stats, /x429, the legacy join/claim) is the
// lane's, mounted at the root.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { send, toLaneRequest } from "../../packages/x429/src/adapters/node.ts";
import type { Log } from "../../packages/x429/src/checkout.ts";
import type { Admission } from "../../packages/x429/src/gate.ts";
import { clientIp, json, preflight } from "../../packages/x429/src/http.ts";
import type { Lane } from "../../packages/x429/src/lane.ts";
import { demoForecast, type Forecast } from "./forecast.ts";
import { handleMcp, pluginManifest } from "./mcp.ts";

export const BUSY_PATH = "/v1/forecast";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export type Forecasts = { get(city: unknown): Forecast };

export const demoForecasts: Forecasts = { get: (city: unknown) => demoForecast(typeof city === "string" && city ? city : "Lisbon") };

/** The busy API's answer for an admitted ticket (also the lane's `serve` hook). */
export function apiResult(forecasts: Forecasts, city: unknown, a: Admission) {
  return {
    ...forecasts.get(city),
    admitted: { via: "queue", ticketId: a.ticketId, waitedSeconds: a.waited, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, servedTx: a.servedTx },
  };
}

/** `log` is unused here: the lane logs route errors through its own logger. */
export type AppDeps = { lane: Lane; log?: Log; forecasts?: Forecasts; siteDir?: string };

export function createApp({ lane, forecasts: fc, siteDir }: AppDeps): Server {
  const cfg = lane.cfg;
  const checkout = lane.checkout;
  const forecasts = fc ?? demoForecasts;

  async function staticFile(res: Parameters<typeof send>[0], pathname: string): Promise<boolean> {
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

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const m = req.method ?? "GET";
      if (m === "OPTIONS") return send(res, preflight());
      if (p === "/healthz") return send(res, json(200, { ok: true, chainId: cfg.chainId, contract: cfg.contract, queueId: cfg.queueId, operator: lane.operator ?? null }));
      const lr = toLaneRequest(req);
      if (p === BUSY_PATH) {
        // the busy API: 429 with the offer when saturated; with X-429-Token it answers for your ticket
        const d = await lane.handle(lr);
        if (d.action === "respond") return send(res, d);
        try {
          const city = url.searchParams.get("city");
          const a = d.admission;
          return send(res, json(200, a ? apiResult(forecasts, city, a) : { ...forecasts.get(city), admitted: { via: "direct" } }));
        } finally {
          d.done();
        }
      }
      const routed = await lane.routes.handle(lr);
      if (routed) return send(res, routed);
      if (p === "/paybox-plugin.json") return send(res, json(200, await pluginManifest(checkout, BUSY_PATH)));
      if (p === "/mcp") {
        const body = m === "POST" ? await lr.body!() : undefined;
        return handleMcp(checkout, BUSY_PATH, req, res, body, clientIp(req.headers, req.socket.remoteAddress));
      }
      if (m === "GET" && (await staticFile(res, p))) return;
      send(res, json(404, { error: "not_found" }));
    })().catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      send(res, lane.routes.failure(err, req.url));
    });
  });
}
