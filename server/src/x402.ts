// x402 v1 and v2 for the `exact` scheme on EVM (EIP-3009), server side.
// Spec: github.com/coinbase/x402 specs/x402-specification-v1.md, -v2.md, schemes/exact/scheme_exact_evm.md
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { USDC_EIP712, caip2 } from "./protocol.ts";

export const V1_PAYMENT_HEADER = "x-payment";
export const V1_RESPONSE_HEADER = "x-payment-response";
export const V2_REQUIRED_HEADER = "payment-required";
export const V2_PAYMENT_HEADER = "payment-signature";
export const V2_RESPONSE_HEADER = "payment-response";

export type Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export type ExactPayload = { signature: Hex; authorization: Authorization };

export type RequirementsInput = {
  chainId: number;
  asset: Address;
  payTo: Address;
  amount: bigint;
  resourceUrl: string;
  description: string;
  maxTimeoutSeconds: number;
  /** Scheme-independent data echoed in `extra` (the x429 quote). */
  quote: Record<string, unknown>;
};

/** v1 network names for the chains x402 v1 knows; anything else uses CAIP-2. */
export function v1Network(chainId: number): string {
  if (chainId === 8453) return "base";
  if (chainId === 84532) return "base-sepolia";
  return caip2(chainId);
}

function extra(input: RequirementsInput) {
  return { ...USDC_EIP712, assetTransferMethod: "eip3009", x429: input.quote };
}

export function v1Requirements(input: RequirementsInput) {
  return {
    scheme: "exact",
    network: v1Network(input.chainId),
    maxAmountRequired: input.amount.toString(),
    asset: input.asset,
    payTo: input.payTo,
    resource: input.resourceUrl,
    description: input.description,
    mimeType: "application/json",
    outputSchema: null,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: extra(input),
  };
}

export function v2Requirements(input: RequirementsInput) {
  return {
    scheme: "exact",
    network: caip2(input.chainId),
    amount: input.amount.toString(),
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: extra(input),
  };
}

/** The v1 JSON body of a 402. */
export function v1PaymentRequired(input: RequirementsInput, error: string) {
  return { x402Version: 1, error, accepts: [v1Requirements(input)] };
}

/** The v2 `PaymentRequired` object (sent base64 in the PAYMENT-REQUIRED header). */
export function v2PaymentRequired(input: RequirementsInput, error: string) {
  return {
    x402Version: 2,
    error,
    resource: { url: input.resourceUrl, description: input.description, mimeType: "application/json" },
    accepts: [v2Requirements(input)],
  };
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export type DecodedPayment = {
  version: 1 | 2;
  scheme: string;
  network: string;
  payload: ExactPayload;
  /** v2 only: the requirements the client says it accepted. */
  accepted?: { network?: string; asset?: string; payTo?: string; amount?: string; extra?: Record<string, unknown> };
};

export type PaymentDecodeError = { error: "invalid_payload" | "invalid_x402_version"; message: string };

const U256 = /^[0-9]{1,78}$/;

function parseAuthorization(raw: unknown): Authorization | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const fields = ["value", "validAfter", "validBefore"] as const;
  if (typeof a.from !== "string" || !isAddress(a.from)) return undefined;
  if (typeof a.to !== "string" || !isAddress(a.to)) return undefined;
  if (typeof a.nonce !== "string" || !isHex(a.nonce) || a.nonce.length !== 66) return undefined;
  for (const f of fields) {
    const v = a[f];
    if (!(typeof v === "string" && U256.test(v)) && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) {
      return undefined;
    }
  }
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: BigInt(a.value as string),
    validAfter: BigInt(a.validAfter as string),
    validBefore: BigInt(a.validBefore as string),
    nonce: a.nonce as Hex,
  };
}

/**
 * Reads a payment from the request headers: v2 `PAYMENT-SIGNATURE` or v1 `X-PAYMENT`.
 * Returns undefined when neither header is present.
 */
export function readPayment(headers: Record<string, string | string[] | undefined>): DecodedPayment | PaymentDecodeError | undefined {
  const pick = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const v2 = pick(V2_PAYMENT_HEADER);
  const v1 = pick(V1_PAYMENT_HEADER);
  const raw = v2 ?? v1;
  if (raw === undefined) return undefined;
  let body: Record<string, unknown>;
  try {
    body = decodeHeader(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return { error: "invalid_payload", message: "payment header is not base64 JSON" };
  }
  const version = body.x402Version;
  if (version !== 1 && version !== 2) {
    return { error: "invalid_x402_version", message: `unsupported x402Version ${String(version)}` };
  }
  const payload = body.payload as Record<string, unknown> | undefined;
  const authorization = parseAuthorization(payload?.authorization);
  const signature = payload?.signature;
  if (!authorization || typeof signature !== "string" || !isHex(signature) || signature.length !== 132) {
    return { error: "invalid_payload", message: "payload must carry a 65-byte signature and an EIP-3009 authorization" };
  }
  if (version === 1) {
    return {
      version: 1,
      scheme: String(body.scheme ?? ""),
      network: String(body.network ?? ""),
      payload: { signature: signature as Hex, authorization },
    };
  }
  const accepted = (body.accepted ?? {}) as DecodedPayment["accepted"] & { scheme?: string };
  return {
    version: 2,
    scheme: String(accepted?.scheme ?? ""),
    network: String(accepted?.network ?? ""),
    payload: { signature: signature as Hex, authorization },
    accepted,
  };
}

/** Client side (agent-sim): builds the header value a wallet would send. */
export function buildPaymentHeader(
  version: 1 | 2,
  chainId: number,
  payload: ExactPayload,
  accepted?: unknown,
  resource?: unknown,
): string {
  const authorization = {
    from: payload.authorization.from,
    to: payload.authorization.to,
    value: payload.authorization.value.toString(),
    validAfter: payload.authorization.validAfter.toString(),
    validBefore: payload.authorization.validBefore.toString(),
    nonce: payload.authorization.nonce,
  };
  if (version === 1) {
    return encodeHeader({
      x402Version: 1,
      scheme: "exact",
      network: v1Network(chainId),
      payload: { signature: payload.signature, authorization },
    });
  }
  return encodeHeader({ x402Version: 2, resource, accepted, payload: { signature: payload.signature, authorization } });
}

export function settlementResponse(p: {
  success: boolean;
  transaction: string;
  chainId: number;
  version: 1 | 2;
  payer: Address;
  errorReason?: string;
}) {
  return {
    success: p.success,
    ...(p.errorReason ? { errorReason: p.errorReason } : {}),
    transaction: p.transaction,
    network: p.version === 1 ? v1Network(p.chainId) : caip2(p.chainId),
    payer: p.payer,
  };
}
