// x429/express: one middleware. Mounted on the lane prefix it answers the x429 routes; mounted on your
// API it gates requests (429 + skip offer when over capacity) and calls next() for admitted ones.
//
//   app.use("/x429", x429Express(lane));
//   app.use("/forecast", x429Express(lane));
//
// The decision is on `req.x429` for your handler. Works with or without express.json() before it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readStreamBody, type LaneRequest } from "../http.ts";
import type { Decision, Lane } from "../lane.ts";
import { onFinished, send } from "./node.ts";

/** The parts of an Express request this adapter reads (no dependency on @types/express). */
export type ExpressRequest = IncomingMessage & { originalUrl?: string; body?: unknown; _body?: boolean; x429?: Decision };
export type ExpressNext = (err?: unknown) => void;

function laneRequest(req: ExpressRequest): LaneRequest {
  let body: Promise<unknown> | undefined;
  return {
    method: req.method ?? "GET",
    url: req.originalUrl ?? req.url ?? "/",
    headers: req.headers,
    ip: req.socket?.remoteAddress,
    // a body parser that ran already consumed the stream: body-parser 1 (Express 4) sets _body,
    // body-parser 2 (Express 5) leaves req.body undefined unless it parsed
    body: () => (body ??= (req._body || (req.body !== undefined && req.readableEnded)) ? Promise.resolve(emptyToUndefined(req.body)) : readStreamBody(req)),
  };
}

function emptyToUndefined(v: unknown): unknown {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0 ? undefined : v;
}

export function x429Express(lane: Lane): (req: ExpressRequest, res: ServerResponse, next: ExpressNext) => void {
  return (req, res, next) => {
    void (async () => {
      const lr = laneRequest(req);
      const routed = await lane.routes.handle(lr);
      if (routed) return send(res, routed);
      if (req.method === "OPTIONS") return next();
      const d = await lane.handle(lr);
      if (d.action === "respond") return send(res, d);
      req.x429 = d;
      onFinished(res, d.done);
      next();
    })().catch(next);
  };
}
