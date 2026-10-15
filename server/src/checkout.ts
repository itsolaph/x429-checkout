// The x429 Checkout service: quotes, gasless join/claim relays and x402 skip settlement.
// HTTP routes (app.ts) and MCP tools (mcp.ts) are thin wrappers over this class.
import {
  getAddress,
  isAddress,
  isHex,
  parseEventLogs,
  parseSignature,
  verifyTypedData,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { checkoutAbi } from "./abi.ts";
import { RevertError, usdcAbi, type Relayer } from "./chain.ts";
import type { Config } from "./config.ts";
import {
  caip2,
  claimTypedData,
  fmtUsd,
  joinTypedData,
  transferWithAuthorizationTypes,
  usdcDomain,
} from "./protocol.ts";
import { isQuoteError, quoteSkip, type Quote, type QueueReader, type Snapshot } from "./queue.ts";
import { v1Network, type DecodedPayment, type RequirementsInput } from "./x402.ts";

export type Log = (entry: Record<string, unknown>) => void;

/** A failed request: HTTP status, a machine-readable reason and a sentence for humans and agents. */
export class CheckoutError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, reason: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

export type SkipOffer = {
  quote: Quote;
  requirements: RequirementsInput;
  resourceUrl: string;
};

export type SkipResult = {
  ticketId: bigint;
  owner: Address;
  fromPosition: number;
  position: number;
  passes: number;
  compensation: bigint;
  fee: bigint;
  cost: bigint;
  refund: bigint;
  frontRun: boolean;
  refundedInFull: boolean;
  /** Set when the payment also created the payer's ticket (join + skip): the skip price it posted. */
  ticketSkipPrice: bigint | null;
  passed: { ticketId: bigint; owner: Address; amount: bigint }[];
  txHash: Hex;
  explorerUrl: string;
};

const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

function randomNonce(): Hex {
  return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
}

/** Contract custom errors → HTTP status + reason. */
const REVERTS: Record<string, [number, string, string]> = {
  InvalidSignature: [400, "invalid_signature", "the signature does not match the owner and the signed fields"],
  SignatureExpired: [400, "signature_expired", "the signed deadline has passed; ask for fresh typed data"],
  NonceAlreadyUsed: [409, "nonce_already_used", "this signature was already used (or its nonce cancelled)"],
  AlreadyWaiting: [409, "already_waiting", "this owner already has a waiting ticket in the queue"],
  QueueFull: [409, "queue_full", "the queue is full"],
  NothingToClaim: [409, "nothing_to_claim", "nothing to claim for this owner"],
  InvalidRecipient: [400, "invalid_recipient", "recipient must not be the zero address"],
  UnknownQueue: [404, "unknown_queue", "unknown queue"],
};

function mapRevert(err: unknown): never {
  if (err instanceof RevertError) {
    const known = REVERTS[err.errorName];
    if (known) throw new CheckoutError(known[0], known[1], known[2]);
    throw new CheckoutError(502, "reverted", `the contract reverted: ${err.errorName} ${err.message}`);
  }
  throw err;
}

export class Checkout {
  readonly cfg: Config;
  readonly client: PublicClient;
  readonly reader: QueueReader;
  readonly relayer: Relayer | undefined;
  private readonly log: Log;

  constructor(cfg: Config, client: PublicClient, reader: QueueReader, relayer: Relayer | undefined, log: Log) {
    this.cfg = cfg;
    this.client = client;
    this.reader = reader;
    this.relayer = relayer;
    this.log = log;
  }

  explorerTx(hash: string): string {
    return `${this.cfg.explorer}/tx/${hash}`;
  }

  // ------------------------------------------------------------------ reads

  async claimable(owner: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.cfg.contract,
      abi: checkoutAbi,
      functionName: "claimable",
      args: [owner],
    });
  }

  /** The queue, the caller's ticket and claimable balance (if `owner` is given). */
  async status(owner?: Address) {
    const snap = await this.reader.get();
    const mine = owner ? snap.tickets.find((t) => t.owner.toLowerCase() === owner.toLowerCase()) : undefined;
    return {
      queue: this.queueJson(snap),
      you: owner
        ? {
            owner,
            ticket: mine ? { id: mine.id, position: mine.position, skipPrice: mine.skipPrice, earned: mine.earned } : null,
            claimable: await this.claimable(owner),
          }
        : undefined,
    };
  }

  queueJson(snap: Snapshot) {
    return {
      chainId: this.cfg.chainId,
      network: caip2(this.cfg.chainId),
      contract: this.cfg.contract,
      asset: this.cfg.usdc,
      queueId: snap.queueId,
      operator: snap.operator,
      feeBps: snap.feeBps,
      length: snap.length,
      maxLength: snap.maxLength,
      skips: snap.skips,
      joined: snap.joined,
      served: snap.served,
      totalCompensation: snap.totalCompensation,
      feesAccrued: snap.feesAccrued,
      blockNumber: snap.blockNumber,
      tickets: snap.tickets.map((t) => ({
        position: t.position,
        ticketId: t.id,
        owner: t.owner,
        skipPrice: t.skipPrice,
        joinedAt: t.joinedAt,
        timesPassed: t.timesPassed,
        earned: t.earned,
        paid: t.paid,
      })),
    };
  }

  quoteJson(q: Quote) {
    return {
      fromPosition: q.fromPosition,
      targetPosition: q.targetPosition,
      passes: q.passes,
      compensation: q.compensation,
      fee: q.fee,
      cost: q.cost,
      maxAmountRequired: q.maxAmountRequired,
      costUsd: fmtUsd(q.cost),
      maxUsd: fmtUsd(q.maxAmountRequired),
      passed: q.passed,
    };
  }

  /** Quotes for every target position ahead of `owner` (or of a newcomer). */
  async quotes(owner?: Address) {
    const snap = await this.reader.get();
    const out = [];
    for (let target = 1; target <= snap.length; target++) {
      const q = quoteSkip(snap, owner ?? null, target, this.cfg.slippageBps);
      if (!isQuoteError(q)) out.push(this.quoteJson(q));
    }
    return out;
  }

  async quote(target: number, owner?: Address): Promise<Quote> {
    const snap = await this.reader.get();
    const q = quoteSkip(snap, owner ?? null, target, this.cfg.slippageBps);
    if (isQuoteError(q)) throw new CheckoutError(409, q.error, q.message);
    return q;
  }

  // ------------------------------------------------------------------ join

  async joinTypedData(owner: Address, skipPrice?: bigint) {
    const nonce = randomNonce();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const price = skipPrice ?? this.cfg.suggestedSkipPrice;
    return {
      typedData: joinTypedData({
        chainId: this.cfg.chainId,
        contract: this.cfg.contract,
        owner,
        queueId: this.cfg.queueId,
        skipPrice: price,
        nonce,
        deadline,
      }),
      submit: { owner, skipPrice: price, nonce, deadline },
    };
  }

  async join(input: { owner: string; skipPrice: string | bigint; nonce: string; deadline: string | bigint; signature: string }) {
    const relayer = this.requireRelayer();
    const owner = parseAddress(input.owner, "owner");
    const skipPrice = parseUint(input.skipPrice, "skipPrice");
    const deadline = parseUint(input.deadline, "deadline");
    const nonce = parseBytes32(input.nonce, "nonce");
    const signature = parseSignatureHex(input.signature);
    const receipt = await relayer
      .exclusive(() =>
        relayer.call("joinWithSig", [owner, this.cfg.queueId, skipPrice, nonce, deadline, signature], "joinWithSig"),
      )
      .catch(mapRevert);
    const [joined] = parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "Joined" });
    if (!joined) throw new CheckoutError(502, "no_join_event", "join mined without a Joined event");
    this.reader.markSeen(joined.args.ticketId);
    await this.reader.atLeast(receipt.blockNumber).catch(() => undefined);
    this.log({ evt: "joined", owner, ticketId: joined.args.ticketId, position: joined.args.position, tx: receipt.transactionHash });
    return {
      ticketId: joined.args.ticketId,
      position: joined.args.position,
      skipPrice,
      txHash: receipt.transactionHash,
      explorerUrl: this.explorerTx(receipt.transactionHash),
      gasUsed: receipt.gasUsed,
    };
  }

  // ------------------------------------------------------------------ claim

  async claimTypedData(owner: Address, recipient?: Address) {
    const nonce = randomNonce();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const to = recipient ?? owner;
    return {
      claimable: await this.claimable(owner),
      typedData: claimTypedData({ chainId: this.cfg.chainId, contract: this.cfg.contract, owner, recipient: to, nonce, deadline }),
      submit: { owner, recipient: to, nonce, deadline },
    };
  }

  async claim(input: { owner: string; recipient?: string; nonce: string; deadline: string | bigint; signature: string }) {
    const relayer = this.requireRelayer();
    const owner = parseAddress(input.owner, "owner");
    const recipient = input.recipient ? parseAddress(input.recipient, "recipient") : owner;
    const deadline = parseUint(input.deadline, "deadline");
    const nonce = parseBytes32(input.nonce, "nonce");
    const signature = parseSignatureHex(input.signature);
    const receipt = await relayer
      .exclusive(() => relayer.call("claimWithSig", [owner, recipient, nonce, deadline, signature], "claimWithSig"))
      .catch(mapRevert);
    const [claimed] = parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "Claimed" });
    this.log({ evt: "claimed", owner, recipient, amount: claimed?.args.amount, tx: receipt.transactionHash });
    return {
      owner,
      recipient,
      amount: claimed?.args.amount ?? 0n,
      amountUsd: fmtUsd(claimed?.args.amount ?? 0n),
      txHash: receipt.transactionHash,
      explorerUrl: this.explorerTx(receipt.transactionHash),
      gasUsed: receipt.gasUsed,
    };
  }

  // ------------------------------------------------------------------ skip

  skipResourceUrl(target: number, skipPrice?: bigint, owner?: Address): string {
    const u = new URL(`${this.cfg.publicUrl}/skip`);
    u.searchParams.set("queue", String(this.cfg.queueId));
    u.searchParams.set("target", String(target));
    if (skipPrice !== undefined) u.searchParams.set("skipPrice", skipPrice.toString());
    if (owner) u.searchParams.set("owner", owner);
    return u.toString();
  }

  /** What a 402 for `POST /skip` advertises right now. `owner` only refines the quote. */
  async skipOffer(target: number, owner?: Address, skipPrice?: bigint, maxAgeMs?: number): Promise<SkipOffer> {
    const snap = await this.reader.get(maxAgeMs);
    const q = quoteSkip(snap, owner ?? null, target, this.cfg.slippageBps);
    if (isQuoteError(q)) throw new CheckoutError(409, q.error, q.message);
    const now = Math.floor(Date.now() / 1000);
    const resourceUrl = this.skipResourceUrl(target, skipPrice, owner);
    const who = q.passes === 1 ? "the 1 agent" : `the ${q.passes} agents`;
    return {
      quote: q,
      resourceUrl,
      requirements: {
        chainId: this.cfg.chainId,
        asset: this.cfg.usdc,
        payTo: this.cfg.contract,
        amount: q.maxAmountRequired,
        resourceUrl,
        description: `x429: move from #${q.fromPosition} to #${target} in queue ${this.cfg.queueId}. Costs ${fmtUsd(q.cost)} now, paid to ${who} you pass; up to ${fmtUsd(q.maxAmountRequired)} is authorized and the unused part is refunded in the same transaction.`,
        maxTimeoutSeconds: this.cfg.paymentTimeoutS,
        quote: {
          queueId: this.cfg.queueId,
          fromPosition: q.fromPosition,
          targetPosition: target,
          passes: q.passes,
          compensation: q.compensation.toString(),
          fee: q.fee.toString(),
          cost: q.cost.toString(),
          slippageBps: this.cfg.slippageBps,
          quotedAt: now,
          quoteExpiresAt: now + this.cfg.quoteTtlS,
          refund: "unused amount is refunded to the payer in the same transaction",
        },
      },
    };
  }

  /**
   * Verifies an x402 `exact` payment and settles it onchain with `skip`. Throws CheckoutError with
   * an x402 error reason; nothing moves unless the result is returned.
   */
  async settleSkip(payment: DecodedPayment, target: number, newTicketSkipPrice: bigint): Promise<SkipResult> {
    const relayer = this.requireRelayer();
    const { authorization: auth, signature } = payment.payload;
    const fail = (status: number, reason: string, message: string, details?: Record<string, unknown>) =>
      new CheckoutError(status, reason, message, { payer: auth.from, ...details });

    if (payment.scheme !== "exact") throw fail(400, "invalid_scheme", `scheme must be "exact"`);
    const networks = new Set([caip2(this.cfg.chainId), v1Network(this.cfg.chainId)]);
    if (!networks.has(payment.network)) throw fail(400, "invalid_network", `network must be ${caip2(this.cfg.chainId)}`);
    if (payment.accepted) {
      const a = payment.accepted;
      if (a.asset && a.asset.toLowerCase() !== this.cfg.usdc.toLowerCase()) {
        throw fail(400, "invalid_payment_requirements", "asset must be USDC");
      }
      if (a.payTo && a.payTo.toLowerCase() !== this.cfg.contract.toLowerCase()) {
        throw fail(400, "invalid_payment_requirements", "payTo must be the queue contract");
      }
      const quote = (a.extra?.x429 ?? {}) as { quoteExpiresAt?: number };
      if (typeof quote.quoteExpiresAt === "number" && quote.quoteExpiresAt < Date.now() / 1000) {
        throw fail(402, "quote_expired", "the accepted quote has expired; request /skip again for a fresh 402");
      }
    }
    if (auth.to.toLowerCase() !== this.cfg.contract.toLowerCase()) {
      throw fail(402, "invalid_exact_evm_payload_recipient_mismatch", "authorization.to must be the queue contract (payTo)");
    }
    const validSig = await verifyTypedData({
      address: auth.from,
      domain: usdcDomain(this.cfg.chainId, this.cfg.usdc),
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: auth,
      signature,
    }).catch(() => false);
    if (!validSig) throw fail(402, "invalid_exact_evm_payload_signature", "the EIP-3009 signature does not recover to authorization.from");

    return relayer.exclusive(async () => {
      const block = await this.client.getBlock();
      const chainNow = block.timestamp;
      if (auth.validBefore <= chainNow + 2n) {
        throw fail(402, "invalid_exact_evm_payload_authorization_valid_before", "the payment authorization has expired");
      }
      if (auth.validAfter >= chainNow + 1n) {
        throw fail(402, "invalid_exact_evm_payload_authorization_valid_after", "the payment authorization is not valid yet");
      }
      const [settled, used] = await Promise.all([
        this.client.readContract({
          address: this.cfg.contract,
          abi: checkoutAbi,
          functionName: "paymentSettled",
          args: [auth.from, auth.nonce],
        }),
        this.client.readContract({
          address: this.cfg.usdc,
          abi: usdcAbi,
          functionName: "authorizationState",
          args: [auth.from, auth.nonce],
        }),
      ]);
      if (settled) throw fail(402, "payment_already_settled", "this payment was already used for a skip (replay)");
      let frontRun = false;
      if (used) {
        // someone submitted the authorization straight to USDC. Only settle it if that transfer
        // really paid this contract (a cancelled authorization also marks the nonce used).
        frontRun = await this.frontRunPaidUs(auth.from, auth.nonce, auth.value);
        if (!frontRun) throw fail(402, "invalid_transaction_state", "this authorization was already used or cancelled elsewhere");
        this.log({ evt: "front_run_detected", payer: auth.from, nonce: auth.nonce, value: auth.value });
      } else {
        const balance = await this.client.readContract({
          address: this.cfg.usdc,
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [auth.from],
        });
        if (balance < auth.value) throw fail(402, "insufficient_funds", `the payer holds ${fmtUsd(balance)}, the authorization is for ${fmtUsd(auth.value)}`);
        const snap = await this.reader.refresh();
        const q = quoteSkip(snap, auth.from, target, this.cfg.slippageBps);
        if (isQuoteError(q)) throw fail(409, q.error, q.message);
        if (q.cost > auth.value) {
          throw fail(402, "price_moved", `the price moved: reaching #${target} now costs ${fmtUsd(q.cost)}, above the ${fmtUsd(auth.value)} you signed. Nothing was charged.`, {
            cost: q.cost,
            signed: auth.value,
          });
        }
      }

      const { r, s, v, yParity } = parseSignature(signature);
      const authTuple = {
        from: auth.from,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        v: Number(v ?? BigInt(yParity + 27)),
        r,
        s,
      };
      let receipt: TransactionReceipt;
      try {
        receipt = await relayer.call("skip", [this.cfg.queueId, target, newTicketSkipPrice, authTuple], frontRun ? "skip (front-run)" : "skip");
      } catch (err) {
        if (err instanceof RevertError && err.errorName === "CostExceedsPayment") {
          const [cost, value] = err.args as [bigint, bigint];
          throw fail(402, "price_moved", `the price moved: the skip now costs ${fmtUsd(cost)}, above the ${fmtUsd(value)} you signed. Nothing was charged.`, { cost, signed: value });
        }
        if (err instanceof RevertError) throw fail(402, "invalid_transaction_state", `settlement would revert: ${err.errorName} ${err.message}`);
        throw err;
      }
      await this.reader.atLeast(receipt.blockNumber).catch(() => undefined);
      const result = this.parseSkipReceipt(receipt, auth.from, frontRun);
      const joinedNote = result.ticketSkipPrice !== null ? ", join + skip" : "";
      relayer.annotate(receipt.transactionHash, `${result.passes} passes${joinedNote}${frontRun ? ", front-run settle" : ""}`);
      return result;
    });
  }

  /** Looks for the USDC AuthorizationUsed(from, nonce) log and a Transfer(from → contract, value) in the same tx. */
  private async frontRunPaidUs(from: Address, nonce: Hex, value: bigint): Promise<boolean> {
    const latest = await this.client.getBlockNumber({ cacheTime: 0 });
    const window = 50_000n; // about a day of Base blocks
    let fromBlock = latest > window ? latest - window : 0n;
    if (fromBlock < this.cfg.deployBlock) fromBlock = this.cfg.deployBlock;
    const logs = await this.client.getContractEvents({
      address: this.cfg.usdc,
      abi: usdcAbi,
      eventName: "AuthorizationUsed",
      args: { authorizer: from, nonce },
      fromBlock,
      toBlock: "latest",
    });
    for (const log of logs) {
      const receipt = await this.client.getTransactionReceipt({ hash: log.transactionHash! });
      const transfers = parseEventLogs({ abi: usdcAbi, logs: receipt.logs, eventName: "Transfer" });
      const paid = transfers.some(
        (t) =>
          t.address.toLowerCase() === this.cfg.usdc.toLowerCase() &&
          t.args.from.toLowerCase() === from.toLowerCase() &&
          t.args.to.toLowerCase() === this.cfg.contract.toLowerCase() &&
          t.args.value === value,
      );
      if (paid) return true;
    }
    return false;
  }

  private parseSkipReceipt(receipt: TransactionReceipt, payer: Address, frontRun: boolean): SkipResult {
    const logs = parseEventLogs({ abi: checkoutAbi, logs: receipt.logs });
    const skipped = logs.find((l) => l.eventName === "Skipped");
    const refunded = logs.find((l) => l.eventName === "PaymentRefunded");
    const received = logs.find((l) => l.eventName === "PaymentReceived");
    const value = received?.eventName === "PaymentReceived" ? received.args.value : 0n;
    const passed = logs
      .filter((l) => l.eventName === "Passed")
      .map((l) => (l.eventName === "Passed" ? { ticketId: l.args.passedTicketId, owner: l.args.passedOwner, amount: l.args.amount } : null))
      .filter((x) => x !== null);
    const joined = logs.find((l) => l.eventName === "Joined");
    const base = {
      owner: payer,
      txHash: receipt.transactionHash,
      explorerUrl: this.explorerTx(receipt.transactionHash),
      frontRun,
      passed,
      ticketSkipPrice: joined?.eventName === "Joined" ? joined.args.skipPrice : null,
    };
    if (skipped?.eventName === "Skipped") {
      const a = skipped.args;
      this.log({ evt: "skipped", payer, ticketId: a.ticketId, from: a.fromPosition, to: a.toPosition, compensation: a.compensation, fee: a.fee, refund: a.refund, frontRun, tx: receipt.transactionHash, gasUsed: receipt.gasUsed });
      this.reader.markSeen(a.ticketId);
      return {
        ...base,
        ticketId: a.ticketId,
        fromPosition: a.fromPosition,
        position: a.toPosition,
        passes: passed.length,
        compensation: a.compensation,
        fee: a.fee,
        cost: a.compensation + a.fee,
        refund: a.refund,
        refundedInFull: false,
      };
    }
    this.log({ evt: "front_run_refunded", payer, value, tx: receipt.transactionHash });
    return {
      ...base,
      ticketId: 0n,
      fromPosition: 0,
      position: 0,
      passes: 0,
      compensation: 0n,
      fee: 0n,
      cost: 0n,
      refund: refunded?.eventName === "PaymentRefunded" ? refunded.args.value : value,
      refundedInFull: true,
    };
  }

  private requireRelayer(): Relayer {
    if (!this.relayer) throw new CheckoutError(503, "no_operator", "this server runs without an operator key and cannot relay");
    return this.relayer;
  }
}

// ------------------------------------------------------------------ input parsing

export function parseAddress(v: unknown, name: string): Address {
  if (typeof v !== "string" || !isAddress(v)) throw new CheckoutError(400, "invalid_request", `${name} must be an address`);
  return getAddress(v);
}

export function parseUint(v: unknown, name: string): bigint {
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
  throw new CheckoutError(400, "invalid_request", `${name} must be a non-negative integer (decimal string)`);
}

function parseBytes32(v: unknown, name: string): Hex {
  if (typeof v !== "string" || !isHex(v) || v.length !== 66) throw new CheckoutError(400, "invalid_request", `${name} must be 32 bytes hex`);
  return v as Hex;
}

function parseSignatureHex(v: unknown): Hex {
  if (typeof v !== "string" || !SIG_RE.test(v)) throw new CheckoutError(400, "invalid_request", "signature must be 65 bytes hex");
  return v as Hex;
}
