// Redeem tokens: the proof that a caller owns a ticket, handed out in the body of a paid x402 response.
//
// With x402 as the only user action, the server learns who paid (authorization.from) but the caller
// never signs anything else, so later calls (use the busy API, read your ticket) carry a bearer token
// instead. Tokens are 256-bit random, shown once, and stored only as their SHA-256. The store also
// remembers which ticket each settled payment produced, so a retried paid request (same payment,
// within its authorization window) gets a fresh token for the same ticket instead of an error.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";

export type TokenEntry = { ticketId: bigint; owner: Address; issuedAt: number };

type Stored = {
  version: 1;
  contract: string;
  tokens: Record<string, { ticketId: string; owner: Address; issuedAt: number }>;
  payments: Record<string, { ticketId: string; txHash: string }>;
};

const TOKEN_RE = /^x429_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class TokenStore {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly payments = new Map<string, { ticketId: bigint; txHash: Hex }>();
  private readonly file: string | undefined;
  private readonly contract: string;

  /** `dir` undefined keeps everything in memory (tests). One store per contract. */
  constructor(dir: string | undefined, contract: Address) {
    this.contract = contract.toLowerCase();
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `tokens-${this.contract}.json`);
    let raw: Stored | undefined;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Stored;
    } catch {
      return; // first start
    }
    if (raw.version !== 1 || raw.contract !== this.contract) return;
    for (const [h, t] of Object.entries(raw.tokens)) this.tokens.set(h, { ticketId: BigInt(t.ticketId), owner: t.owner, issuedAt: t.issuedAt });
    for (const [k, v] of Object.entries(raw.payments)) this.payments.set(k, { ticketId: BigInt(v.ticketId), txHash: v.txHash as Hex });
  }

  get size(): number {
    return this.tokens.size;
  }

  /** A new token for `ticketId`. The plain value is returned once and never stored. */
  issue(ticketId: bigint, owner: Address): string {
    const token = `x429_${randomBytes(32).toString("base64url")}`;
    this.tokens.set(hashToken(token), { ticketId, owner, issuedAt: Date.now() });
    this.save();
    return token;
  }

  lookup(token: unknown): TokenEntry | undefined {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;
    return this.tokens.get(hashToken(token));
  }

  static wellFormed(token: unknown): token is string {
    return typeof token === "string" && TOKEN_RE.test(token);
  }

  /** Remembers that the payment (from, nonce) produced `ticketId` in transaction `txHash`. */
  recordPayment(from: Address, nonce: Hex, ticketId: bigint, txHash: Hex): void {
    this.payments.set(`${from.toLowerCase()}:${nonce.toLowerCase()}`, { ticketId, txHash });
    this.save();
  }

  paymentTicket(from: Address, nonce: Hex): bigint | undefined {
    return this.payments.get(`${from.toLowerCase()}:${nonce.toLowerCase()}`)?.ticketId;
  }

  paymentTx(from: Address, nonce: Hex): Hex | undefined {
    return this.payments.get(`${from.toLowerCase()}:${nonce.toLowerCase()}`)?.txHash;
  }

  private save(): void {
    if (!this.file) return;
    const out: Stored = { version: 1, contract: this.contract, tokens: {}, payments: {} };
    for (const [h, t] of this.tokens) out.tokens[h] = { ticketId: t.ticketId.toString(), owner: t.owner, issuedAt: t.issuedAt };
    for (const [k, v] of this.payments) out.payments[k] = { ticketId: v.ticketId.toString(), txHash: v.txHash };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
