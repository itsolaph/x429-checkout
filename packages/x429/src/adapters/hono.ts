// x429/hono: one middleware. Mounted on the lane prefix it answers the x429 routes; mounted on your
// API it gates requests (429 + skip offer when over capacity) and calls next() for admitted ones.
//
//   app.use("/x429/*", x429Hono(lane));
//   app.use("/forecast/*", x429Hono(lane));
//
// The decision is in the context as `c.get("x429")`.
import type { MiddlewareHandler } from "hono";
import { MAX_BODY_BYTES, parseJsonBody, type Headers, type LaneRequest, type LaneResponse } from "../http.ts";
import { CheckoutError } from "../checkout.ts";
import type { Decision, Lane } from "../lane.ts";

export type X429Variables = { x429: Decision };

function toResponse(r: LaneResponse): Response {
  return new Response(r.status === 204 || r.body === "" ? null : r.body, { status: r.status, headers: r.headers });
}

function laneRequest(raw: Request, ip: string | undefined): LaneRequest {
  const u = new URL(raw.url);
  const headers: Headers = {};
  raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let body: Promise<unknown> | undefined;
  return {
    method: raw.method,
    url: `${u.pathname}${u.search}`,
    headers,
    ip,
    body: () =>
      (body ??= (async () => {
        if (Number(raw.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new CheckoutError(413, "body_too_large", "request body over 64 KiB");
        return parseJsonBody(await raw.clone().text());
      })()),
  };
}

export function x429Hono(lane: Lane): MiddlewareHandler<{ Variables: X429Variables }> {
  return async (c, next) => {
    // @hono/node-server exposes the socket as env.incoming
    const ip = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const lr = laneRequest(c.req.raw, ip);
    const routed = await lane.routes.handle(lr);
    if (routed) return toResponse(routed);
    if (c.req.method === "OPTIONS") return next();
    const d = await lane.handle(lr);
    if (d.action === "respond") return toResponse(d);
    c.set("x429", d);
    try {
      await next();
    } finally {
      d.done();
    }
  };
}
