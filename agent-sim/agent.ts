// A PayBox-style agent for local testing. It signs with a local test key exactly the payloads a
// PayBox wallet produces: EIP-3009 TransferWithAuthorization for x402 `exact` (and, for the legacy
// paths, EIP-712 Join/Claim and an EIP-191 redeem message). `executeX402` plays PayBox for a plugin's
// x402 proposal: fetch the live 402, check asset and amount against the proposal, pay, retry. It never
// sends a transaction itself and never holds ETH.
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

  /** Legacy gasless join: fetch typed data, sign it (EIP-712), the operator relays it. */
  async joinSigned(skipPrice: bigint) {
    const td = await this.http("GET", `/join/typed-data?owner=${this.address}&skipPrice=${skipPrice}`);
    if (td.status !== 200) throw new Error(`${this.name} join typed-data: ${td.status} ${JSON.stringify(td.body)}`);
    const signature = await this.account.signTypedData(td.body.typedData);
    return this.http("POST", "/join/signed", { ...td.body.submit, signature });
  }

  /** Paid join: x402 `POST /join {skipPrice}`. */
  join(skipPrice: bigint, version: 1 | 2 = 1) {
    return this.pay("/join", { body: { skipPrice: skipPrice.toString() }, version });
  }

  /**
   * Plays PayBox for an x402 proposal returned by a plugin tool: checks the envelope, fetches the live
   * 402 (`route` maps the public https origin to the local server), refuses if the asset differs or the
   * amount exceeds `payment.maxAmount`, signs EIP-3009 for the advertised amount and retries.
   */
  async executeX402(proposal: any, route: (url: string) => string, version: 1 | 2 = 2) {
    if (proposal?.kind !== "x402" || proposal.chain !== "eip155:8453") throw new Error(`not a Base x402 proposal: ${JSON.stringify(proposal)}`);
    const expires = Date.parse(proposal.expiresAt);
    if (!(expires > Date.now() && expires <= Date.now() + 300_000)) throw new Error(`proposal expiry out of range: ${proposal.expiresAt}`);
    const { url, method, body } = proposal.request;
    if (!String(url).startsWith("https://")) throw new Error(`proposal url must be https: ${url}`);
    const local = route(url);
    const pr = await this.paymentRequired(local, method, body);
    const t402 = performance.now();
    const req = version === 2 ? pr.v2.accepts[0] : pr.v1;
    const amount = BigInt(version === 2 ? req.amount : req.maxAmountRequired);
    if (req.asset.toLowerCase() !== String(proposal.payment.asset).toLowerCase()) throw new Error(`402 asset ${req.asset} differs from the proposal`);
    if (amount > BigInt(proposal.payment.maxAmount)) throw new Error(`402 asks ${amount}, above the proposal maximum ${proposal.payment.maxAmount}`);
    const payload = await this.signExact({ asset: req.asset, payTo: req.payTo, amount, maxTimeoutSeconds: req.maxTimeoutSeconds });
    const headers = version === 2 ? this.v2Header(payload, req, pr.v2.resource) : this.v1Header(payload);
    const t0 = performance.now();
    const result = await this.http(method, local, body, headers);
    // ms: the paid request alone; withSigningMs: from the live 402 to the paid response (no passkey here)
    return { pr, amount, payload, headers, result, ms: performance.now() - t0, withSigningMs: performance.now() - t402 };
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
  async paymentRequired(path: string, method = "POST", body?: unknown): Promise<PaymentRequired> {
    const r = await this.http(method, path, body);
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

  /** The whole x402 round trip: 402 → sign → pay (v1 X-PAYMENT by default, or v2). */
  async pay(path: string, opts: { value?: bigint; body?: unknown; version?: 1 | 2 } = {}) {
    const pr = await this.paymentRequired(path, "POST", opts.body);
    const v2 = opts.version === 2;
    const req = v2 ? pr.v2.accepts[0] : pr.v1;
    const payload = await this.signExact({
      asset: req.asset,
      payTo: req.payTo,
      amount: BigInt(v2 ? req.amount : req.maxAmountRequired),
      maxTimeoutSeconds: req.maxTimeoutSeconds,
    }, { value: opts.value });
    const headers = v2 ? this.v2Header(payload, req, pr.v2.resource) : this.v1Header(payload);
    const t0 = performance.now();
    const result = await this.http("POST", path, opts.body, headers);
    return { pr, payload, headers, result, ms: performance.now() - t0 };
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
