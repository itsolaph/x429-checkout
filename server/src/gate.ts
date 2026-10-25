// The admission gate in front of the busy API, and the operator loop that serves the queue head.
//
// One request is admitted per service interval. A request without a ticket is admitted only when the
// queue is empty and the service is idle; otherwise it gets 429 with an x429 descriptor that prices a
// skip. A served ticket redeems one request, either with the redeem token from its paid join/skip
// (`POST /use`, the PayBox plugin path) or with an EIP-191 signature of its owner (headers).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { parseEventLogs, verifyMessage, type Address, type Hash, type Hex } from "viem";
import { checkoutAbi } from "./abi.ts";
import type { Checkout, Log } from "./checkout.ts";
import { toJson } from "./json.ts";
import { PROTOCOL_VERSION, SIGNATURE_HEADER, TICKET_HEADER, caip2, fmtUsd, ticketMessage } from "./protocol.ts";
import { isQuoteError, quoteSkip, type Quote, type Snapshot } from "./queue.ts";

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
  /** Set once the ticket used its request; repeated uses inside the admission window get the same answer. */
  result?: unknown;
};

/** Where a ticket stands for its owner, without using it. */
export type TicketStatus =
  | { status: "waiting"; ticketId: bigint; position: number; etaSeconds: number }
  | { status: "ready" | "used"; ticketId: bigint; admission: Admission; expiresInSeconds: number }
  | { status: "serving"; ticketId: bigint; etaSeconds: number }
  | { status: "expired" | "left" | "unknown"; ticketId: bigint };

/** What happened when a paid skip to #1 asked to be served inside its own request. */
export type ServeNow =
  | { status: "served"; admission: Admission; result: unknown; serveTx: Hash; serveConfirmed: boolean }
  | { status: "busy"; reason: "slot_busy" | "not_head" | "serve_failed"; etaSeconds: number };

/** You, in a 429: the ticket behind a redeem token. */
export type You = { ticketId: bigint; owner: Address; position: number; status: string };

export type GateDecision =
  | { kind: "admit"; via: "direct" | "queue"; admission?: Admission }
  | { kind: "reject"; status: 429 | 403; body: unknown; retryAfterS?: number; headers?: Record<string, string> };

export type TicketState = { id: string; status: "waiting" | "serving"; position: number } | null;

const TICKET_RE = /^[0-9]{1,20}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export class Gate {
  private busyUntil = 0;
  private serving = false;
  /** An operator tick is waiting for (or holding) the relayer. */
  private ticking = false;
  private lastServeAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly admissions = new Map<bigint, Admission>();
  private readonly consumed = new Set<bigint>();
  /** Heads that paid to be #1: they skip the admission round when the slot frees up. */
  private readonly paidHeads = new Set<bigint>();
  readonly stats = { direct: 0, queued: 0, rejected429: 0, forbidden403: 0, served: 0, servedInRequest: 0, serveErrors: 0 };

  private readonly checkout: Checkout;
  private readonly log: Log;

  /** Where admissions survive a restart (a paid ticket served onchain must still redeem its request). */
  private readonly file: string | undefined;

  constructor(checkout: Checkout, log: Log) {
    this.checkout = checkout;
    this.log = log;
    const dir = checkout.cfg.dataDir;
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `admissions-${checkout.cfg.contract.toLowerCase()}.json`);
    this.load();
  }

  private load(): void {
    let raw: { version: 1; admissions: Record<string, unknown>[]; consumed: string[] } | undefined;
    try {
      raw = JSON.parse(readFileSync(this.file!, "utf8"));
    } catch {
      return; // first start
    }
    if (!raw || raw.version !== 1) return;
    const now = Date.now();
    for (const a of raw.admissions ?? []) {
      const adm: Admission = {
        ticketId: BigInt(a.ticketId as string),
        owner: a.owner as Address,
        servedAt: Number(a.servedAt),
        expiresAt: Number(a.expiresAt),
        servedTx: a.servedTx as Hash,
        waited: Number(a.waited),
        timesPassed: Number(a.timesPassed),
        earned: BigInt(a.earned as string),
        paid: BigInt(a.paid as string),
        ...(a.hasResult ? { result: a.result } : {}),
      };
      if (adm.expiresAt >= now) this.admissions.set(adm.ticketId, adm);
      else this.consumed.add(adm.ticketId);
    }
    for (const id of raw.consumed ?? []) this.consumed.add(BigInt(id));
    this.log({ evt: "admissions_loaded", admissions: this.admissions.size, consumed: this.consumed.size });
  }

  private save(): void {
    if (!this.file) return;
    try {
      const admissions = [...this.admissions.values()].map((a) => ({
        ...a,
        ticketId: a.ticketId.toString(),
        earned: a.earned.toString(),
        paid: a.paid.toString(),
        hasResult: a.result !== undefined,
      }));
      const consumed = [...this.consumed].slice(-5_000).map(String);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, toJson({ version: 1, admissions, consumed }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log({ evt: "admissions_save_error", error: String((err as Error)?.message ?? err) });
    }
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
        body: { skipPrice: "<USDC units you are paid each time someone passes you>" },
        payment: "x402 exact: a small join fee, the rest refunded; the response carries your redeem token",
        maxSkipPrice: cfg.maxSkipPrice.toString(),
      },
      use: {
        method: "POST",
        url: `${cfg.publicUrl}/use`,
        body: { token: "<redeem token from the paid /join or /skip response>" },
        answers: "429 with position and ETA while you wait; 200 with the API result once you are served",
      },
      redeemWithSignature: {
        headers: [TICKET_HEADER, SIGNATURE_HEADER],
        message: ticketMessage(cfg.chainId, cfg.contract, "<ticketId>"),
        scheme: "EIP-191 personal_sign by the ticket owner (alternative to the token)",
      },
      gaslessJoin: cfg.legacyJoin
        ? {
            method: "POST",
            url: `${cfg.publicUrl}/join/signed`,
            typedData: `${cfg.publicUrl}/join/typed-data?owner=<address>&skipPrice=<units>`,
          }
        : null,
      payouts: cfg.autoPayout ? "automatic: whoever passes you pays you, and the operator sends it to your wallet" : "claim",
      mcp: `${cfg.publicUrl}/mcp`,
    };
  }

  /**
   * The small JSON a 429 carries: where you are (your ticket if the request had a redeem token),
   * the live price to #1 and exactly what to call to pay it. The full descriptor is at GET /x429.
   */
  offer(snap: Snapshot | undefined, you?: You) {
    const cfg = this.cfg;
    const position = you?.position || (snap?.length ?? 0) + 1;
    const q = snap && position > 1 ? quoteSkip(snap, you?.owner ?? null, 1, cfg.slippageBps) : undefined;
    const front = q && !isQuoteError(q) ? q : undefined;
    const eta = this.etaSeconds(position, snap);
    return {
      error: "too_many_requests",
      message: this.headline(snap, position, front),
      position,
      queueLength: snap?.length ?? 0,
      etaSeconds: eta,
      you: you ? { ticketId: you.ticketId.toString(), status: you.status, position: you.position } : null,
      skip: front
        ? {
            targetPosition: 1,
            passes: front.passes,
            cost: front.cost.toString(),
            costUsd: fmtUsd(front.cost),
            maxAmount: front.maxAmountRequired.toString(),
            waitSavedSeconds: Math.max(0, eta - this.etaSeconds(1, snap)),
            method: "POST",
            url: `${cfg.publicUrl}/skip`,
            body: { target: 1, ...(you ? { owner: you.owner } : {}) },
            payment: "x402 exact, USDC on Base; the unused part of maxAmount is refunded",
            plugin: { tool: "x429_skip", arguments: { targetPosition: 1 } },
            answer: "the paid response contains the API result and a receipt",
          }
        : null,
      wait: you
        ? { plugin: { tool: "x429_use", arguments: { token: "<your token>" } } }
        : { method: "POST", url: `${cfg.publicUrl}/join`, plugin: { tool: "x429_join", arguments: {} } },
      next: front
        ? `Pay ${fmtUsd(front.cost)} to go first (x429_skip, or POST /skip {"target":1} with x402); the paid response is the answer. Or wait about ${eta} s${you ? " and call x429_use" : " after x429_join"}.`
        : `Retry in about ${eta} s.`,
      descriptor: `${cfg.publicUrl}/x429`,
    };
  }

  /** Headers that let an agent act on a 429 without parsing the body. */
  offerHeaders(body: ReturnType<Gate["offer"]>): Record<string, string> {
    const h: Record<string, string> = {
      "retry-after": String(body.etaSeconds),
      "x-429-position": String(body.position),
      "x-429-queue": `${this.cfg.contract}/${this.cfg.queueId}`,
    };
    if (body.skip) {
      h["x-429-skip-cost"] = body.skip.cost;
      h["x-429-skip-url"] = body.skip.url;
      h.link = `<${body.skip.url}>; rel="payment"; title="x402 skip to #1"`;
    }
    return h;
  }

  /** One sentence for agents: where you are and what skipping costs. */
  headline(snap: Snapshot | undefined, position: number, quote?: Quote): string {
    const front = quote ?? (snap && snap.length > 0 ? quoteSkip(snap, null, 1, this.cfg.slippageBps) : undefined);
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
    void ticket;
    void retryAfterS;
    void position;
    return this.reject429(snap);
  }

  /** A 429 with the small offer body and its headers. */
  reject429(snap: Snapshot | undefined, you?: You): GateDecision & { kind: "reject" } {
    this.stats.rejected429++;
    const body = this.offer(snap, you);
    return { kind: "reject", status: 429, retryAfterS: body.etaSeconds, body, headers: this.offerHeaders(body) };
  }

  private forbidden(reason: string, ticketId?: bigint): GateDecision {
    this.stats.forbidden403++;
    this.log({ evt: "forbidden", reason, ticketId });
    return { kind: "reject", status: 403, body: { error: "forbidden", reason, x429: this.descriptor(this.checkout.reader.latest) } };
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, a] of this.admissions) {
      if (a.expiresAt < now) {
        this.admissions.delete(id);
        this.remember(id);
        changed = true;
        this.log({ evt: "admission_expired", ticketId: id, owner: a.owner });
      }
    }
    if (changed) this.save();
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
    if (adm?.result !== undefined) return this.forbidden("ticket_used_or_expired", id);
    if (adm) {
      const ok = await verifyMessage({ address: adm.owner, message, signature: sig }).catch(() => false);
      if (!ok) return this.forbidden("bad_signature", id);
      if (!this.admissions.has(id) || this.consumed.has(id)) return this.forbidden("ticket_used_or_expired", id);
      this.admissions.delete(id);
      this.remember(id);
      this.save();
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

  /** Where ticket `id` stands, without using it. */
  async inspect(id: bigint): Promise<TicketStatus> {
    this.sweep();
    const adm = this.admissions.get(id);
    if (adm) {
      const expiresInSeconds = Math.max(0, Math.ceil((adm.expiresAt - Date.now()) / 1000));
      return { status: adm.result === undefined ? "ready" : "used", ticketId: id, admission: adm, expiresInSeconds };
    }
    if (this.consumed.has(id)) return { status: "expired", ticketId: id };
    const t = await this.checkout.client.readContract({ address: this.cfg.contract, abi: checkoutAbi, functionName: "tickets", args: [id] });
    const [, queueId, status] = t;
    if (status === 0 || queueId !== this.cfg.queueId) return { status: "unknown", ticketId: id };
    if (status === 1) {
      let snap = await this.checkout.reader.get().catch(() => this.checkout.reader.latest);
      if (!snap?.tickets.some((x) => x.id === id)) snap = await this.checkout.reader.refresh().catch(() => snap);
      const position = snap?.tickets.find((x) => x.id === id)?.position ?? 0;
      if (position === 0) return { status: "serving", ticketId: id, etaSeconds: 1 }; // being served right now
      return { status: "waiting", ticketId: id, position, etaSeconds: this.etaSeconds(position, snap) };
    }
    if (status === 2) {
      // served onchain: the admission is recorded as soon as the serve receipt is in
      return this.serving ? { status: "serving", ticketId: id, etaSeconds: 1 } : { status: "expired", ticketId: id };
    }
    return { status: "left", ticketId: id };
  }

  /**
   * Uses a served ticket's request (token path). `make` builds the API answer once; using the ticket
   * again inside its admission window returns that same answer, so a lost response is not a lost request.
   */
  async use(id: bigint, make: (adm: Admission) => unknown): Promise<TicketStatus & { result?: unknown; replayed?: boolean }> {
    const st = await this.inspect(id);
    if (st.status !== "ready" && st.status !== "used") return st;
    const adm = st.admission;
    const replayed = adm.result !== undefined;
    if (!replayed) {
      adm.result = make(adm);
      this.save();
      this.stats.queued++;
      this.log({ evt: "admit", via: "token", ticketId: id, owner: adm.owner, waited: adm.waited });
    }
    return { ...st, status: "used", result: adm.result, replayed };
  }

  /**
   * A paid skip just moved `ticketId` to #1: serve it inside the same request when the service slot is
   * free, skipping the admission round. That round exists so a head that just arrived can still be
   * outbid; a ticket that paid every ticket it passed its own posted price has settled that already,
   * so nobody waiting is treated worse than they asked for. Must run inside the relayer's `exclusive`
   * (right after the settlement). `confirm` waits for the serve receipt; otherwise the serve is sent
   * and confirmed in the background (it is the operator's own transaction; the payer's transfer is
   * already included).
   */
  async serveNow(ticketId: bigint, make: (adm: Admission) => unknown, confirm: boolean): Promise<ServeNow> {
    const relayer = this.checkout.relayer!;
    const now = Date.now();
    const snap = this.checkout.reader.latest;
    const head = snap?.tickets[0];
    if (head?.id === ticketId) {
      this.paidHeads.add(ticketId);
      if (this.paidHeads.size > 1_000) this.paidHeads.delete(this.paidHeads.values().next().value!);
    }
    if (this.serving) {
      return { status: "busy", reason: "slot_busy", etaSeconds: Math.max(1, Math.ceil((Math.max(this.busyUntil, now + 1000) - now) / 1000)) };
    }
    if (!head || head.id !== ticketId) return { status: "busy", reason: "not_head", etaSeconds: this.etaSeconds(1, snap) };
    // A paid #1 takes the slot even inside the current service interval: it already paid every ticket
    // it passed, so making it wait out someone else's interval sells a place without the service.
    // The next scheduled serve moves back one interval, so the API still sees one extra request at most.
    const preempted = now < this.busyUntil;
    this.serving = true;
    this.busyUntil = Math.max(this.busyUntil, now) + this.cfg.serviceIntervalMs;
    const done = (ok: boolean) => {
      this.serving = false;
      this.lastServeAt = Date.now();
      if (!ok) this.busyUntil = Math.max(this.busyUntil, Date.now() + 2000);
      void this.checkout.reader.refresh().catch(() => {});
    };
    try {
      const adm: Admission = {
        ticketId,
        owner: head.owner,
        servedAt: now,
        expiresAt: now + this.cfg.admissionTtlMs,
        servedTx: "0x" as Hash,
        waited: Math.max(0, (snap?.blockTime ?? 0) - head.joinedAt),
        timesPassed: head.timesPassed,
        earned: head.earned,
        paid: head.paid,
      };
      let serveConfirmed = false;
      if (confirm) {
        const receipt = await relayer.call("serve", [this.cfg.queueId, 1], "serve (paid skip)");
        adm.servedTx = receipt.transactionHash;
        serveConfirmed = true;
        done(true);
        // serve(queue, 1) serves whoever is head onchain: make sure that was this ticket
        const servedIds = parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "Served" }).map((e) => e.args);
        const mine = servedIds.find((a) => a.ticketId === ticketId);
        if (!mine) {
          for (const a of servedIds) {
            this.admissions.set(a.ticketId, {
              ticketId: a.ticketId, owner: a.owner, servedAt: Date.now(), expiresAt: Date.now() + this.cfg.admissionTtlMs,
              servedTx: receipt.transactionHash, waited: Number(a.waited), timesPassed: Number(a.timesPassed), earned: a.earned, paid: a.paid,
            });
          }
          this.save();
          this.log({ evt: "serve_mismatch", via: "paid_skip", ticketId, served: servedIds.map((a) => a.ticketId), tx: receipt.transactionHash });
          return { status: "busy", reason: "not_head", etaSeconds: this.etaSeconds(1, this.checkout.reader.latest) };
        }
      } else {
        const sent = await relayer.send("serve", [this.cfg.queueId, 1], "serve (paid skip)");
        adm.servedTx = sent.hash;
        sent.receipt.then(
          (r) => {
            this.log({ evt: "served", via: "paid_skip", ticketId, tx: r.transactionHash, gasUsed: r.gasUsed });
            done(true);
          },
          (err) => {
            this.stats.serveErrors++;
            this.log({ evt: "serve_error", via: "paid_skip", ticketId, error: String((err as Error)?.message ?? err).split("\n")[0] });
            done(false);
          },
        );
      }
      adm.result = make(adm);
      this.admissions.set(ticketId, adm);
      this.save();
      this.stats.served++;
      this.stats.queued++;
      this.stats.servedInRequest++;
      this.log({ evt: "admit", via: "paid_skip", ticketId, owner: adm.owner, serveTx: adm.servedTx, confirmed: serveConfirmed, preempted });
      return { status: "served", admission: adm, result: adm.result, serveTx: adm.servedTx, serveConfirmed };
    } catch (err) {
      this.stats.serveErrors++;
      this.log({ evt: "serve_error", via: "paid_skip", ticketId, error: String((err as Error)?.message ?? err).split("\n")[0] });
      done(false);
      return { status: "busy", reason: "serve_failed", etaSeconds: this.etaSeconds(1, snap) };
    }
  }

  /** Serves the head when the service is free and the head's admission round is over. */
  async operatorTick(): Promise<void> {
    const relayer = this.checkout.relayer;
    if (!relayer || this.serving || this.ticking) return;
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
    // a queue of demo agents only is kept waiting: serving it would only make them pay to rejoin
    if (this.cfg.holdDemoOnly && this.cfg.demoAgents.size > 0 && snap.tickets.every((t) => this.cfg.demoAgents.has(t.owner.toLowerCase()))) return;
    if (!this.paidHeads.has(head.id) && now < head.firstSeenMs + this.cfg.minQueueMs) return; // admission round still open
    this.ticking = true;
    try {
      // `serving` is set only once the relayer is ours: while a paid skip settles, it must still be
      // able to serve its own ticket at once (it checks `serving`), and this tick then stands down.
      const receipt = await relayer.exclusive(async () => {
        if (Date.now() < this.busyUntil) return undefined;
        this.serving = true;
        return relayer.call("serve", [this.cfg.queueId, 1], "serve");
      });
      if (!receipt) return;
      const servedAt = Date.now();
      this.lastServeAt = servedAt;
      for (const ev of parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "Served" })) {
        const a = ev.args;
        // a paid #1 already answered in its own request keeps that answer (one request per ticket)
        if (this.admissions.get(a.ticketId)?.result !== undefined) continue;
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
      this.save();
    } catch (err) {
      this.stats.serveErrors++;
      this.lastServeAt = Date.now();
      this.busyUntil = Math.max(this.busyUntil, Date.now() + 2000);
      this.log({ evt: "serve_error", error: String((err as Error)?.message ?? err).split("\n")[0] });
    } finally {
      this.serving = false;
      this.ticking = false;
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
