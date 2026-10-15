// The admission gate in front of the busy API, and the operator loop that serves the queue head.
//
// One request is admitted per service interval. A request without ticket headers is admitted only
// when the queue is empty and the service is idle; otherwise it gets 429 with an x429 descriptor
// that prices a skip. Served tickets redeem one request with an EIP-191 signature of their owner.
import type { IncomingMessage } from "node:http";
import { parseEventLogs, verifyMessage, type Address, type Hash, type Hex } from "viem";
import { checkoutAbi } from "./abi.ts";
import type { Checkout, Log } from "./checkout.ts";
import { PROTOCOL_VERSION, SIGNATURE_HEADER, TICKET_HEADER, caip2, fmtUsd, ticketMessage } from "./protocol.ts";
import { isQuoteError, quoteSkip, type Snapshot } from "./queue.ts";

export type Admission = {
  ticketId: bigint;
  owner: Address;
  servedAt: number;
  expiresAt: number;
  servedTx: Hash;
  waited: number;
  timesPassed: number;
  earned: bigint;
  paid: bigint;
};

export type GateDecision =
  | { kind: "admit"; via: "direct" | "queue"; admission?: Admission }
  | { kind: "reject"; status: 429 | 403; body: unknown; retryAfterS?: number };

export type TicketState = { id: string; status: "waiting" | "serving"; position: number } | null;

const TICKET_RE = /^[0-9]{1,20}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export class Gate {
  private busyUntil = 0;
  private serving = false;
  private lastServeAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly admissions = new Map<bigint, Admission>();
  private readonly consumed = new Set<bigint>();
  readonly stats = { direct: 0, queued: 0, rejected429: 0, forbidden403: 0, served: 0, serveErrors: 0 };

  private readonly checkout: Checkout;
  private readonly log: Log;

  constructor(checkout: Checkout, log: Log) {
    this.checkout = checkout;
    this.log = log;
  }

  private get cfg() {
    return this.checkout.cfg;
  }

  start(tickMs = 250): void {
    if (!this.timer && this.checkout.relayer) this.timer = setInterval(() => void this.operatorTick(), tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Seconds until a request at `position` (1 = head) can expect to be served. */
  etaSeconds(position: number, snap?: Snapshot): number {
    const now = Date.now();
    const free = Math.max(0, this.busyUntil - now);
    let roundLeft = 0;
    const head = snap?.tickets[0];
    if (head) roundLeft = Math.max(0, head.firstSeenMs + this.cfg.minQueueMs - now);
    const wait = Math.max(free, roundLeft) + Math.max(0, position - 1) * this.cfg.serviceIntervalMs;
    return Math.max(1, Math.ceil(wait / 1000));
  }

  /** The x429 descriptor that comes with every 429 (and GET /x429). */
  descriptor(snap: Snapshot | undefined, ticket: TicketState = null) {
    const cfg = this.cfg;
    const position = ticket?.position || (snap?.length ?? 0) + 1;
    const toFront = snap && snap.length > 0 ? quoteSkip(snap, null, 1, cfg.slippageBps) : undefined;
    const front = toFront && !isQuoteError(toFront) ? toFront : undefined;
    return {
      version: PROTOCOL_VERSION,
      network: caip2(cfg.chainId),
      chainId: cfg.chainId,
      contract: cfg.contract,
      queueId: cfg.queueId,
      asset: cfg.usdc,
      currency: { symbol: "USDC", decimals: 6 },
      queueLength: snap?.length ?? 0,
      position,
      serviceIntervalMs: cfg.serviceIntervalMs,
      admissionRoundMs: cfg.minQueueMs,
      admissionTtlMs: cfg.admissionTtlMs,
      suggestedSkipPrice: cfg.suggestedSkipPrice.toString(),
      feeBps: snap?.feeBps ?? 0,
      ticket,
      skip: {
        method: "POST",
        url: this.checkout.skipResourceUrl(1),
        payment: "x402 exact (EIP-3009 USDC on Base); v1 X-PAYMENT or v2 PAYMENT-SIGNATURE",
        toFront: front
          ? {
              targetPosition: 1,
              passes: front.passes,
              compensation: front.compensation.toString(),
              fee: front.fee.toString(),
              cost: front.cost.toString(),
              maxAmountRequired: front.maxAmountRequired.toString(),
              costUsd: fmtUsd(front.cost),
            }
          : null,
        quotes: `${cfg.publicUrl}/queue/${cfg.queueId}`,
      },
      join: {
        method: "POST",
        url: `${cfg.publicUrl}/join`,
        typedData: `${cfg.publicUrl}/join/typed-data?owner=<address>&skipPrice=<units>`,
        gasless: true,
      },
      redeem: {
        headers: [TICKET_HEADER, SIGNATURE_HEADER],
        message: ticketMessage(cfg.chainId, cfg.contract, "<ticketId>"),
        scheme: "EIP-191 personal_sign by the ticket owner",
      },
      mcp: `${cfg.publicUrl}/mcp`,
    };
  }

  /** One sentence for agents: where you are and what skipping costs. */
  headline(snap: Snapshot | undefined, position: number): string {
    const front = snap && snap.length > 0 ? quoteSkip(snap, null, 1, this.cfg.slippageBps) : undefined;
    if (!front || isQuoteError(front)) return `Busy. You would be #${position} in line.`;
    const n = front.passes;
    return `Busy. You are #${position} in line; skipping to the front costs ${fmtUsd(front.cost)} right now, paid to the ${n} agent${n === 1 ? "" : "s"} you pass.`;
  }

  /** Decides whether a request to the busy API may run now. */
  async admit(req: IncomingMessage): Promise<GateDecision> {
    const rawId = header(req, TICKET_HEADER);
    const rawSig = header(req, SIGNATURE_HEADER);
    if (rawId !== undefined || rawSig !== undefined) return this.admitTicket(rawId ?? "", rawSig ?? "");
    const snap = await this.checkout.reader.get().catch(() => this.checkout.reader.latest);
    const now = Date.now();
    if (snap && snap.length === 0 && !this.serving && now >= this.busyUntil) {
      this.busyUntil = now + this.cfg.serviceIntervalMs;
      this.stats.direct++;
      this.log({ evt: "admit", via: "direct" });
      return { kind: "admit", via: "direct" };
    }
    const position = (snap?.length ?? 0) + 1;
    return this.tooMany(snap, null, this.etaSeconds(position, snap), position);
  }

  private tooMany(snap: Snapshot | undefined, ticket: TicketState, retryAfterS: number, position: number): GateDecision {
    this.stats.rejected429++;
    return {
      kind: "reject",
      status: 429,
      retryAfterS,
      body: { error: "too_many_requests", message: this.headline(snap, position), x429: this.descriptor(snap, ticket) },
    };
  }

  private forbidden(reason: string, ticketId?: bigint): GateDecision {
    this.stats.forbidden403++;
    this.log({ evt: "forbidden", reason, ticketId });
    return { kind: "reject", status: 403, body: { error: "forbidden", reason, x429: this.descriptor(this.checkout.reader.latest) } };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, a] of this.admissions) {
      if (a.expiresAt < now) {
        this.admissions.delete(id);
        this.remember(id);
        this.log({ evt: "admission_expired", ticketId: id, owner: a.owner });
      }
    }
  }

  private remember(id: bigint): void {
    this.consumed.add(id);
    if (this.consumed.size > 50_000) this.consumed.delete(this.consumed.values().next().value!);
  }

  private async admitTicket(rawId: string, rawSig: string): Promise<GateDecision> {
    if (!TICKET_RE.test(rawId) || !SIG_RE.test(rawSig)) return this.forbidden("malformed_ticket");
    const id = BigInt(rawId);
    const sig = rawSig as Hex;
    const message = ticketMessage(this.cfg.chainId, this.cfg.contract, id);
    this.sweep();
    if (this.consumed.has(id)) return this.forbidden("ticket_used_or_expired", id);

    const adm = this.admissions.get(id);
    if (adm) {
      const ok = await verifyMessage({ address: adm.owner, message, signature: sig }).catch(() => false);
      if (!ok) return this.forbidden("bad_signature", id);
      if (!this.admissions.has(id) || this.consumed.has(id)) return this.forbidden("ticket_used_or_expired", id);
      this.admissions.delete(id);
      this.remember(id);
      this.stats.queued++;
      this.log({ evt: "admit", via: "queue", ticketId: id, owner: adm.owner, waited: adm.waited });
      return { kind: "admit", via: "queue", admission: adm };
    }

    // not admitted (yet): look the ticket up onchain
    const t = await this.checkout.client
      .readContract({ address: this.cfg.contract, abi: checkoutAbi, functionName: "tickets", args: [id] })
      .catch(() => undefined);
    if (!t) return this.tooMany(this.checkout.reader.latest, null, 2, 0);
    const [owner, queueId, status] = t;
    if (status === 0 || queueId !== this.cfg.queueId) return this.forbidden("unknown_ticket", id);
    const ok = await verifyMessage({ address: owner, message, signature: sig }).catch(() => false);
    if (!ok) return this.forbidden("bad_signature", id);
    if (status === 1) {
      const snap = await this.checkout.reader.get().catch(() => this.checkout.reader.latest);
      const position = snap?.tickets.find((x) => x.id === id)?.position ?? 0;
      return this.tooMany(snap, { id: id.toString(), status: "waiting", position }, this.etaSeconds(position || 1, snap), position);
    }
    if (status === 2 && this.serving) {
      return this.tooMany(this.checkout.reader.latest, { id: id.toString(), status: "serving", position: 0 }, 1, 0);
    }
    return this.forbidden(status === 2 ? "not_admitted" : "ticket_left", id);
  }

  /** Serves the head when the service is free and the head's admission round is over. */
  async operatorTick(): Promise<void> {
    const relayer = this.checkout.relayer;
    if (!relayer || this.serving) return;
    this.sweep();
    let snap: Snapshot;
    try {
      snap = await this.checkout.reader.get(this.cfg.pollMs);
    } catch {
      return;
    }
    if (snap.length === 0 || snap.fetchedAt <= this.lastServeAt) return;
    const now = Date.now();
    if (now < this.busyUntil) return;
    const head = snap.tickets[0]!;
    if (now < head.firstSeenMs + this.cfg.minQueueMs) return; // admission round still open
    this.serving = true;
    try {
      const receipt = await relayer.exclusive(() => relayer.call("serve", [this.cfg.queueId, 1], "serve"));
      const servedAt = Date.now();
      this.lastServeAt = servedAt;
      for (const ev of parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "Served" })) {
        const a = ev.args;
        this.admissions.set(a.ticketId, {
          ticketId: a.ticketId,
          owner: a.owner,
          servedAt,
          expiresAt: servedAt + this.cfg.admissionTtlMs,
          servedTx: receipt.transactionHash,
          waited: Number(a.waited),
          timesPassed: Number(a.timesPassed),
          earned: a.earned,
          paid: a.paid,
        });
        this.stats.served++;
        this.busyUntil = servedAt + this.cfg.serviceIntervalMs;
        this.log({ evt: "served", ticketId: a.ticketId, owner: a.owner, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, tx: receipt.transactionHash, gasUsed: receipt.gasUsed });
      }
    } catch (err) {
      this.stats.serveErrors++;
      this.lastServeAt = Date.now();
      this.busyUntil = Math.max(this.busyUntil, Date.now() + 2000);
      this.log({ evt: "serve_error", error: String((err as Error)?.message ?? err).split("\n")[0] });
    } finally {
      this.serving = false;
      void this.checkout.reader.refresh().catch(() => {});
    }
  }

  snapshotStats() {
    return { ...this.stats, admissions: this.admissions.size, busyUntil: this.busyUntil };
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
