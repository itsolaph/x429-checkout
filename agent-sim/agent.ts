// A PayBox-style agent for local testing. It signs with a local test key exactly the payloads a
// PayBox wallet produces: EIP-3009 TransferWithAuthorization for x402 `exact`, EIP-712 Join/Claim
// for gasless queue actions, and an EIP-191 message to redeem a served ticket. It never sends a
// transaction itself and never holds ETH.
import { randomBytes } from "node:crypto";
import { type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SIGNATURE_HEADER, TICKET_HEADER, ticketMessage, transferWithAuthorizationTypedData } from "../server/src/protocol.ts";
import { buildPaymentHeader, decodeHeader, type ExactPayload } from "../server/src/x402.ts";

export type HttpResult<T = any> = { status: number; body: T; headers: Headers };

export type V1Accepts = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: Address;
  payTo: Address;
  resource: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; x429: Record<string, unknown> };
};

export type PaymentRequired = { status: number; body: any; v1: V1Accepts; v2: any; headers: Headers };

export class SimAgent {
  readonly name: string;
  readonly account: LocalAccount;
  readonly baseUrl: string;
  readonly chainId: number;

  constructor(name: string, key: Hex, baseUrl: string, chainId: number) {
    this.name = name;
    this.account = privateKeyToAccount(key);
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.chainId = chainId;
  }

  get address(): Address {
    return this.account.address;
  }

  async http<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep text
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  /** Gasless join: fetch typed data, sign it (PayBox: request_wallet_sign op typedData), relay it. */
  async join(skipPrice: bigint) {
    const td = await this.http("GET", `/join/typed-data?owner=${this.address}&skipPrice=${skipPrice}`);
    if (td.status !== 200) throw new Error(`${this.name} join typed-data: ${td.status} ${JSON.stringify(td.body)}`);
    const signature = await this.account.signTypedData(td.body.typedData);
    return this.http("POST", "/join", { ...td.body.submit, signature });
  }

  /** Gasless claim to `recipient` (default self). Returns the signed body too, so tests can replay it. */
  async claim(recipient?: Address) {
    const td = await this.http("GET", `/claim/typed-data?owner=${this.address}${recipient ? `&recipient=${recipient}` : ""}`);
    if (td.status !== 200) throw new Error(`${this.name} claim typed-data: ${td.status} ${JSON.stringify(td.body)}`);
    const signature = await this.account.signTypedData(td.body.typedData);
    const request = { ...td.body.submit, signature };
    return { request, result: await this.http("POST", "/claim", request) };
  }

  /** Requests a protected resource without payment and parses the 402 (v1 body + v2 header). */
  async paymentRequired(path: string, method = "POST"): Promise<PaymentRequired> {
    const r = await this.http(method, path);
    if (r.status !== 402) throw new Error(`${this.name}: expected 402 from ${path}, got ${r.status} ${JSON.stringify(r.body)}`);
    const v2raw = r.headers.get("payment-required");
    return { status: r.status, body: r.body, v1: r.body.accepts[0], v2: v2raw ? decodeHeader(v2raw) : undefined, headers: r.headers };
  }

  /** Signs the EIP-3009 authorization for an x402 `exact` requirement, like PayBox `pay_x402` does. */
  async signExact(
    req: { asset: Address; payTo: Address; amount: bigint; maxTimeoutSeconds: number },
    opts: { now?: number; validAfter?: bigint; validBefore?: bigint; value?: bigint } = {},
  ): Promise<ExactPayload> {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.address,
      to: req.payTo,
      value: opts.value ?? req.amount,
      validAfter: opts.validAfter ?? BigInt(now - 600),
      validBefore: opts.validBefore ?? BigInt(now + req.maxTimeoutSeconds),
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    };
    const signature = await this.account.signTypedData(
      transferWithAuthorizationTypedData({ chainId: this.chainId, usdc: req.asset, ...authorization }),
    );
    return { signature, authorization };
  }

  /** v1: X-PAYMENT header. */
  v1Header(payload: ExactPayload): Record<string, string> {
    return { "x-payment": buildPaymentHeader(1, this.chainId, payload) };
  }

  /** v2: PAYMENT-SIGNATURE header echoing the accepted requirements. */
  v2Header(payload: ExactPayload, accepted: unknown, resource: unknown): Record<string, string> {
    return { "payment-signature": buildPaymentHeader(2, this.chainId, payload, accepted, resource) };
  }

  /** The whole x402 round trip with v1: 402 → sign → pay. */
  async pay(path: string, opts: { value?: bigint } = {}) {
    const pr = await this.paymentRequired(path);
    const payload = await this.signExact({
      asset: pr.v1.asset,
      payTo: pr.v1.payTo,
      amount: BigInt(pr.v1.maxAmountRequired),
      maxTimeoutSeconds: pr.v1.maxTimeoutSeconds,
    }, { value: opts.value });
    const headers = this.v1Header(payload);
    const result = await this.http("POST", path, undefined, headers);
    return { pr, payload, headers, result };
  }

  /** Calls the busy API, optionally redeeming a served ticket (EIP-191 signature, PayBox op message). */
  async callApi(path: string, ticketId?: bigint, contract?: Address) {
    const headers: Record<string, string> = {};
    if (ticketId !== undefined && contract) {
      headers[TICKET_HEADER] = ticketId.toString();
      headers[SIGNATURE_HEADER] = await this.account.signMessage({ message: ticketMessage(this.chainId, contract, ticketId) });
    }
    return this.http("GET", path, undefined, headers);
  }
}
