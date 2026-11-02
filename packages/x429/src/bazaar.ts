// Optional x402 Bazaar discovery (https://docs.x402.org/extensions/bazaar).
//
// The 402 skip offer carries an `extensions.bazaar` declaration and resource metadata (serviceName,
// tags, iconUrl) in its v2 PAYMENT-REQUIRED object. Facilitators that catalog on `/verify` (PayAI
// does since 2026-07-29) index a resource when they see a payment carrying that declaration, so
// after a payment has been verified locally the lane POSTs it, with its requirements, to the
// facilitator's `/verify`, fire and forget. `/verify` moves no funds; the contract still settles.
// Nothing here can block or fail a paid request: the POST is never awaited and every error is
// swallowed into a log line.
//
// The declaration follows `declareDiscoveryExtension` of @x402/extensions 2.29 (body method,
// bodyType json), written out here so the package needs no x402 dependency.
import type { DecodedPayment } from "./x402.ts";

export type BazaarOptions = {
  /** Facilitator base URL; the lane POSTs to `${facilitatorUrl}/verify`. */
  facilitatorUrl: string;
  /** Up to 32 printable ASCII characters. */
  serviceName?: string;
  /** Up to 5 tags of up to 32 printable ASCII characters. */
  tags?: string[];
  /** Absolute http(s) URL of an icon. */
  iconUrl?: string;
  /** The skip request: an example JSON body and optionally its JSON Schema. Default: `{ target: 1 }`. */
  input?: { example?: Record<string, unknown>; schema?: Record<string, unknown> };
  /** The paid response: an example and optionally its JSON Schema. */
  output?: { example?: unknown; schema?: Record<string, unknown> };
  /** Abort the verify POST after this long. Default 5000 ms. */
  timeoutMs?: number;
};

export type BazaarConfig = Required<Pick<BazaarOptions, "facilitatorUrl" | "timeoutMs">> & Omit<BazaarOptions, "facilitatorUrl" | "timeoutMs">;

const PRINTABLE = /^[\x20-\x7e]{1,32}$/;

function bad(message: string): never {
  throw new Error(`x429: bazaar.${message}`);
}

export function resolveBazaar(o: unknown): BazaarConfig | undefined {
  if (o === undefined) return undefined;
  if (!o || typeof o !== "object" || Array.isArray(o)) bad("options must be an object");
  const b = o as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!["facilitatorUrl", "serviceName", "tags", "iconUrl", "input", "output", "timeoutMs"].includes(k)) bad(`${k} is not an option`);
  }
  let url: URL;
  try {
    url = new URL(String(b.facilitatorUrl));
  } catch {
    return bad("facilitatorUrl must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") bad("facilitatorUrl must be an http(s) URL");
  if (b.serviceName !== undefined && (typeof b.serviceName !== "string" || !PRINTABLE.test(b.serviceName))) bad("serviceName must be 1-32 printable ASCII characters");
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || b.tags.length > 5 || !b.tags.every((t) => typeof t === "string" && PRINTABLE.test(t))) {
      bad("tags must be at most 5 strings of 1-32 printable ASCII characters");
    }
  }
  if (b.iconUrl !== undefined) {
    let icon: URL;
    try {
      icon = new URL(String(b.iconUrl));
    } catch {
      return bad("iconUrl must be an absolute http(s) URL");
    }
    if ((icon.protocol !== "https:" && icon.protocol !== "http:") || String(b.iconUrl).length > 2048) bad("iconUrl must be an absolute http(s) URL");
  }
  for (const k of ["input", "output"] as const) {
    if (b[k] !== undefined && (typeof b[k] !== "object" || b[k] === null || Array.isArray(b[k]))) bad(`${k} must be an object`);
  }
  const timeoutMs = b.timeoutMs === undefined ? 5_000 : Number(b.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) bad("timeoutMs must be an integer from 1 to 60000");
  return { ...(b as BazaarOptions), facilitatorUrl: String(b.facilitatorUrl).replace(/\/+$/, ""), timeoutMs };
}

/** The `bazaar` extension for `POST /skip` (JSON body), as `declareDiscoveryExtension` builds it. */
export function bazaarDeclaration(b: BazaarConfig) {
  const example = b.input?.example ?? { target: 1 };
  const inputSchema = b.input?.schema ?? {
    properties: {
      target: { type: "integer", minimum: 1, description: "position to move to (1 = served next)" },
      owner: { type: "string", description: "your payer address, if you already wait in line" },
      skipPrice: { type: "string", description: "USDC base units you are paid when someone passes you (new tickets)" },
    },
  };
  const out = b.output?.example;
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: example },
      ...(out !== undefined ? { output: { type: "json", example: out } } : {}),
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json", "form-data", "text"] },
            body: inputSchema,
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        ...(out !== undefined
          ? {
              output: {
                type: "object",
                properties: { type: { type: "string" }, example: { type: "object", ...(b.output?.schema ?? {}) } },
                required: ["type"],
              },
            }
          : {}),
      },
      required: ["input"],
    },
  };
}

/** Resource metadata the Bazaar reads next to `url`, `description` and `mimeType`. */
export function bazaarResource(b: BazaarConfig): Record<string, unknown> {
  return {
    ...(b.serviceName ? { serviceName: b.serviceName } : {}),
    ...(b.tags?.length ? { tags: b.tags } : {}),
    ...(b.iconUrl ? { iconUrl: b.iconUrl } : {}),
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Sends a locally verified v2 payment to the facilitator's `/verify` and returns at once. The body is
 * the shape of @x402/core's HTTPFacilitatorClient.verify: `{x402Version, paymentPayload,
 * paymentRequirements}`. The payload gets the declaration if the client did not echo it.
 */
export function forwardToFacilitator(
  b: BazaarConfig,
  payment: DecodedPayment,
  resource: { url: string; description?: string },
  log: (entry: Record<string, unknown>) => void,
  fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
): void {
  try {
    if (payment.version !== 2 || !payment.raw || !payment.accepted) return; // the Bazaar extension is v2
    const raw = payment.raw;
    const extensions = { ...((raw.extensions as Record<string, unknown> | undefined) ?? {}) };
    if (!extensions.bazaar) extensions.bazaar = bazaarDeclaration(b);
    const paymentPayload = {
      ...raw,
      resource: raw.resource ?? { url: resource.url, description: resource.description, mimeType: "application/json", ...bazaarResource(b) },
      extensions,
    };
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: payment.accepted });
    const started = Date.now();
    const host = new URL(b.facilitatorUrl).host;
    fetchImpl(`${b.facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(b.timeoutMs),
    }).then(
      (res) => log({ evt: "bazaar_verify", host, status: res.status, ms: Date.now() - started }),
      (err: unknown) => log({ evt: "bazaar_verify_error", host, error: String((err as Error)?.name ?? err), ms: Date.now() - started }),
    ).catch(() => {});
  } catch (err) {
    log({ evt: "bazaar_verify_error", error: String((err as Error)?.message ?? err).split("\n")[0] });
  }
}
