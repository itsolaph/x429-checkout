// Framework-neutral HTTP shapes. The core speaks LaneRequest/LaneResponse; each adapter (node, express,
// hono) only converts to and from them, so every adapter answers with the same status, headers and bytes.
import { CheckoutError } from "./checkout.ts";
import { toJson } from "./json.ts";

export type Headers = Record<string, string | string[] | undefined>;

export type LaneRequest = {
  method: string;
  /** Path and query, e.g. `/x429/skip?target=1`. */
  url: string;
  /** Header names in lower case. */
  headers: Headers;
  /** The client address (rate limits of the legacy relay; idempotent replays of paid requests). */
  ip?: string;
  /** Reads the JSON body (undefined when empty). Throws a 400/413 CheckoutError on bad input. */
  body?: () => Promise<unknown>;
};

export type LaneResponse = { status: number; headers: Record<string, string>; body: string };

export const MAX_BODY_BYTES = 64 * 1024;

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-payment, payment-signature, x-429-token, x-429-ticket, x-429-signature, mcp-protocol-version",
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response, retry-after, link, server-timing, x-429-queue, x-429-position, x-429-skip-cost, x-429-skip-url, x-429-idempotent-replay",
};

/** A JSON response (bigints as decimal strings, 2-space indent), no-store, CORS open. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): LaneResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers }, body: toJson(body, 2) };
}

export function preflight(): LaneResponse {
  return { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" }, body: "" };
}

/** Parses a request body that was read as text. */
export function parseJsonBody(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new CheckoutError(413, "body_too_large", "request body over 64 KiB");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckoutError(400, "invalid_json", "request body is not JSON");
  }
}

/** Reads a JSON body from a Node stream (an IncomingMessage), at most 64 KiB. */
export async function readStreamBody(stream: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new CheckoutError(413, "body_too_large", "request body over 64 KiB");
    chunks.push(b);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CheckoutError(400, "invalid_json", "request body is not JSON");
  }
}

/** The first value of a header. */
export function header(headers: Headers, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** The caller's address from X-Forwarded-For, else the socket. Behind a proxy, have the proxy overwrite X-Forwarded-For. */
export function clientIp(headers: Headers, remote: string | undefined): string {
  const first = header(headers, "x-forwarded-for")?.split(",")[0]?.trim();
  return first || remote || "unknown";
}
