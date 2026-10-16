// Chain access: viem clients, the operator relayer (one transaction in flight) and USDC reads.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkoutAbi } from "./abi.ts";
import type { Config } from "./config.ts";

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

export function chainFor(cfg: Pick<Config, "chainId" | "rpcUrl">): Chain {
  if (cfg.chainId === base.id) return { ...base, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  return defineChain({
    id: cfg.chainId,
    name: `chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export function makePublicClient(cfg: Pick<Config, "chainId" | "rpcUrl">): PublicClient {
  return createPublicClient({
    chain: chainFor(cfg),
    // receipts are polled every 250 ms: a paid request waits for its settlement, so this is latency
    pollingInterval: 250,
    transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 20_000 }),
  }) as PublicClient;
}

/** A contract revert decoded into its custom error name and args. */
export class RevertError extends Error {
  readonly errorName: string;
  readonly args: readonly unknown[];

  constructor(errorName: string, args: readonly unknown[], message: string) {
    super(message);
    this.errorName = errorName;
    this.args = args;
  }
}

/** A transaction was sent but its receipt did not arrive in time. It may still be mined. */
export class PendingTxError extends Error {
  readonly hash: Hash;

  constructor(hash: Hash, cause: unknown) {
    super(`transaction ${hash} not confirmed yet: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`);
    this.hash = hash;
  }
}

export function decodeRevert(err: unknown): RevertError | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  const name = revert.data?.errorName ?? (revert.reason ? "Error" : "Unknown");
  const args = revert.data?.args ?? (revert.reason ? [revert.reason] : []);
  return new RevertError(name, args, revert.reason ?? revert.shortMessage);
}

export type GasRecord = { fn: string; gasUsed: bigint; tx: Hash; note?: string };

/**
 * Sends operator transactions one at a time: simulate (so a revert never costs gas and comes back
 * as a decoded error), send, wait for the receipt. Callers that must read state and act on it
 * atomically (relative to our own transactions) wrap the whole step in `exclusive`.
 */
export class Relayer {
  readonly client: PublicClient;
  readonly contract: Address;
  readonly account: Account;
  readonly wallet: WalletClient;
  readonly gas: GasRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(client: PublicClient, key: `0x${string}`, contract: Address) {
    this.client = client;
    this.contract = contract;
    this.account = privateKeyToAccount(key);
    this.wallet = createWalletClient({ account: this.account, chain: client.chain, transport: http(client.transport.url) });
  }

  get address(): Address {
    return this.account.address;
  }

  /** Adds a note (e.g. how many tickets a skip passed) to the gas record of `tx`. */
  annotate(tx: Hash, note: string): void {
    const rec = this.gas.find((g) => g.tx === tx);
    if (rec) rec.note = note;
  }

  /** Runs `fn` after every earlier exclusive step has finished. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Simulates and sends a call to the checkout contract. Must be called inside `exclusive`. */
  async call(functionName: string, args: readonly unknown[], note?: string): Promise<TransactionReceipt> {
    return this.callContract(this.contract, checkoutAbi, functionName, args, note);
  }

  /**
   * Simulates and sends a call without waiting for it to be mined. `receipt` settles later (and
   * records gas); a revert on chain rejects it. Must be called inside `exclusive`; the next call
   * picks the next nonce from the node's pending count.
   */
  async send(functionName: string, args: readonly unknown[], note?: string): Promise<{ hash: Hash; receipt: Promise<TransactionReceipt> }> {
    let request;
    try {
      ({ request } = await this.client.simulateContract({ address: this.contract, abi: checkoutAbi, functionName, args, account: this.account } as never));
    } catch (err) {
      throw decodeRevert(err) ?? err;
    }
    const hash = await this.wallet.writeContract(request as never);
    const receipt = this.client.waitForTransactionReceipt({ hash, timeout: 60_000 }).then((r) => {
      this.gas.push({ fn: functionName, gasUsed: r.gasUsed, tx: hash, note });
      if (this.gas.length > 500) this.gas.shift();
      if (r.status !== "success") throw new RevertError("Reverted", [], `${functionName} reverted in ${hash}`);
      return r;
    });
    receipt.catch(() => {}); // callers attach their own handlers
    return { hash, receipt };
  }

  async callContract(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    note?: string,
  ): Promise<TransactionReceipt> {
    let request;
    try {
      ({ request } = await this.client.simulateContract({
        address,
        abi,
        functionName,
        args,
        account: this.account,
      } as never));
    } catch (err) {
      throw decodeRevert(err) ?? err;
    }
    const hash = await this.wallet.writeContract(request as never);
    let receipt: TransactionReceipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    } catch (err) {
      throw new PendingTxError(hash, err);
    }
    this.gas.push({ fn: functionName, gasUsed: receipt.gasUsed, tx: hash, note });
    if (this.gas.length > 500) this.gas.shift();
    if (receipt.status !== "success") throw new RevertError("Reverted", [], `${functionName} reverted in ${hash}`);
    return receipt;
  }
}
