// x429/node: a plain node:http request listener. Lane routes are answered; every other request goes
// through the gate, and admitted ones reach your handler.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { readStreamBody, type LaneRequest, type LaneResponse } from "../http.ts";
import type { Decision, Lane } from "../lane.ts";

export type NodeHandler = (req: IncomingMessage, res: ServerResponse, decision: Decision & { action: "next" }) => void | Promise<void>;

/** An IncomingMessage as a LaneRequest. The body is read on demand (at most 64 KiB of JSON). */
export function toLaneRequest(req: IncomingMessage): LaneRequest {
  let body: Promise<unknown> | undefined;
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
    headers: req.headers,
    ip: req.socket?.remoteAddress,
    body: () => (body ??= readStreamBody(req)),
  };
}

/** Writes a LaneResponse. */
export function send(res: ServerResponse, r: LaneResponse): void {
  res.writeHead(r.status, r.headers);
  res.end(r.body);
}

/** Calls `done` once the response is finished or the connection closes. */
export function onFinished(res: ServerResponse, done: () => void): void {
  res.once("finish", done);
  res.once("close", done);
}

/**
 * Wraps `handler`: lane routes under the prefix are answered, everything else is gated. `protect`
 * picks the requests to gate (default: all); unprotected ones go straight to the handler with
 * `{ action: "next", via: "direct" }`.
 */
export function x429Node(lane: Lane, handler: NodeHandler, opts: { protect?: (req: IncomingMessage) => boolean } = {}): RequestListener {
  return (req, res) => {
    void (async () => {
      const lr = toLaneRequest(req);
      const routed = await lane.routes.handle(lr);
      if (routed) return send(res, routed);
      if (req.method === "OPTIONS" || (opts.protect && !opts.protect(req))) {
        return handler(req, res, { action: "next", via: "direct", done: () => {} });
      }
      const d = await lane.handle(lr);
      if (d.action === "respond") return send(res, d);
      onFinished(res, d.done);
      await handler(req, res, d);
    })().catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      send(res, lane.routes.failure(err, req.url));
    });
  };
}
