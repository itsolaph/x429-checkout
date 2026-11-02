// `npx x429`: deploy your own X429Checkout, open a queue, read its status, write an env template.
// The key comes only from --key-file or X429_OPERATOR_KEY and is never printed.
import { existsSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  isAddress,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkoutAbi } from "./abi.ts";
import { checkoutBytecode, checkoutCompiler } from "./bytecode.ts";
import { chainFor, decodeRevert } from "./chain.ts";
import { readOperatorKey } from "./config.ts";
import { BASE_CHAIN_ID, BASE_USDC, USDC_EIP712, fmtUsd, usdc } from "./protocol.ts";

export const VERSION = "0.1.0";

/** Native USDC by chain id. Other chains need --usdc. */
export const KNOWN_USDC: Record<number, Address> = { [BASE_CHAIN_ID]: BASE_USDC };

const tokenAbi = parseAbi(["function name() view returns (string)", "function version() view returns (string)"]);

export const MAINNETS = new Set([1, 8453, 10, 42161, 137]);

export type Io = { out: (line: string) => void; err: (line: string) => void; env: Record<string, string | undefined>; cwd: string };

export class UsageError extends Error {}

const FLAGS = new Set(["dry-run", "yes", "json", "force", "help", "version"]);
const VALUES = new Set(["rpc", "key-file", "usdc", "contract", "queue", "max-length", "fee-bps", "join-fee", "meta", "file", "chain-id"]);

export type Parsed = { command: string[]; flags: Set<string>; values: Record<string, string> };

/** `x429 queue create --max-length 64 --meta="..." --dry-run` → command, flags, values. Unknown options are errors. */
export function parseArgs(argv: string[]): Parsed {
  const command: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") {
      flags.add("help");
      continue;
    }
    if (a === "-v") {
      flags.add("version");
      continue;
    }
    if (!a.startsWith("--")) {
      command.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (name === "key") throw new UsageError("pass the key with --key-file <path> or the env X429_OPERATOR_KEY, never on the command line");
    if (FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.add(name);
    } else if (VALUES.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || (eq === -1 && v.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
      values[name] = v;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { command, flags, values };
}

const HELP = `x429 ${VERSION}: your own paid priority lane for a rate-limited API (X429Checkout on an EVM chain, USDC, x402)

Usage:
  x429 deploy --rpc <url> --key-file <path> [--usdc <address>] [--dry-run] [--yes]
      Deploys X429Checkout from the bundled bytecode. The key's address becomes the contract's
      operator (it settles payments, serves the queue and pays gas; it never holds user funds).
      Prints X429_CONTRACT and X429_DEPLOY_BLOCK. --dry-run simulates and sends nothing.
  x429 queue create --rpc <url> --key-file <path> --contract <address>
      [--max-length 64] [--fee-bps 0] [--join-fee 0.001] [--meta '{"name":"my api"}'] [--dry-run] [--yes]
      Opens a queue (createQueue + setJoinFee). Prints X429_QUEUE_ID.
  x429 status --rpc <url> --contract <address> [--queue 1] [--json]
      Reads the operator, the queue, its fees and who waits.
  x429 init [--file .env.x429] [--force]
      Writes an env template for your app (no secrets filled in).

The key: --key-file <path> (a file with the 32-byte hex key, chmod 600) or the env X429_OPERATOR_KEY.
Sending to a mainnet (Base, Ethereum, ...) needs --yes.
`;

const ENV_TEMPLATE = `# x429 lane settings (written by \`npx x429 init\`). Keep this file out of git.
# Fill in after \`npx x429 deploy\` and \`npx x429 queue create\`.

# Chain
X429_RPC_URL=
X429_CHAIN_ID=8453
# X429_USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Your contract and queue
X429_CONTRACT=
X429_QUEUE_ID=1
X429_DEPLOY_BLOCK=0

# The operator key: point to a file outside the repo (chmod 600). Do not paste the key here.
X429_OPERATOR_KEY_FILE=

# Your API
X429_PUBLIC_URL=https://api.example.com
X429_PER_INTERVAL_MS=15000
# X429_CONCURRENCY=4
X429_DATA_DIR=.x429-data
`;

function need(values: Record<string, string>, name: string): string {
  const v = values[name];
  if (v === undefined || v === "") throw new UsageError(`--${name} is required`);
  return v;
}

function address(values: Record<string, string>, name: string): Address {
  const v = need(values, name);
  if (!isAddress(v, { strict: false })) throw new UsageError(`--${name} must be an 0x address`);
  return getAddress(v);
}

function intIn(values: Record<string, string>, name: string, fallback: number, min: number, max: number): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  return Number(raw);
}

function rpcUrl(values: Record<string, string>): string {
  const v = need(values, "rpc");
  if (!/^https?:\/\//.test(v)) throw new UsageError("--rpc must be an http(s) URL");
  return v;
}

/** The RPC's host only (a URL path or query may carry an API key). */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function loadKey(values: Record<string, string>, env: Io["env"]): Hex {
  const file = values["key-file"];
  const fromEnv = env.X429_OPERATOR_KEY;
  if (file !== undefined && fromEnv) throw new UsageError("pass --key-file or set X429_OPERATOR_KEY, not both");
  let key: Hex | undefined;
  try {
    key = readOperatorKey(file === undefined ? fromEnv || undefined : undefined, file);
  } catch (err) {
    throw new UsageError(String((err as Error).message).replace(/^x429: /, "").replace("operatorKeyFile", "--key-file"));
  }
  if (!key) throw new UsageError("an operator key is needed: --key-file <path> or the env X429_OPERATOR_KEY");
  return key;
}

async function connect(url: string, values: Record<string, string>): Promise<{ client: PublicClient; chainId: number }> {
  const probe = createPublicClient({ transport: http(url, { retryCount: 1, timeout: 15_000 }) });
  let chainId: number;
  try {
    chainId = await probe.getChainId();
  } catch {
    throw new UsageError(`cannot reach the RPC at ${host(url)}`);
  }
  if (values["chain-id"] !== undefined && Number(values["chain-id"]) !== chainId) {
    throw new UsageError(`the RPC is chain ${chainId}, not --chain-id ${values["chain-id"]}`);
  }
  const client = createPublicClient({ chain: chainFor({ chainId, rpcUrl: url }), pollingInterval: 500, transport: http(url, { retryCount: 2, timeout: 30_000 }) }) as PublicClient;
  return { client, chainId };
}

function guardMainnet(chainId: number, flags: Set<string>): void {
  if (MAINNETS.has(chainId) && !flags.has("dry-run") && !flags.has("yes")) {
    throw new UsageError(`chain ${chainId} is a mainnet: this sends a real transaction. Run with --dry-run first, then again with --yes.`);
  }
}

function why(err: unknown): string {
  const revert = decodeRevert(err);
  if (revert) return `reverted: ${revert.errorName}${revert.message ? ` (${revert.message})` : ""}`;
  return String((err as { shortMessage?: string })?.shortMessage ?? (err as Error)?.message ?? err).split("\n")[0]!;
}

async function deploy(p: Parsed, io: Io): Promise<number> {
  const url = rpcUrl(p.values);
  const key = loadKey(p.values, io.env);
  const { client, chainId } = await connect(url, p.values);
  const account = privateKeyToAccount(key);
  const token = p.values.usdc !== undefined ? address(p.values, "usdc") : KNOWN_USDC[chainId];
  if (!token) throw new UsageError(`no known USDC on chain ${chainId}: pass --usdc <address>`);
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") throw new UsageError(`--usdc ${token} has no code on chain ${chainId}`);
  // the lane verifies EIP-3009 signatures against USDC's domain: another domain would refuse every payment
  const [name, version] = await Promise.all([
    client.readContract({ address: token, abi: tokenAbi, functionName: "name" }).catch(() => undefined),
    client.readContract({ address: token, abi: tokenAbi, functionName: "version" }).catch(() => undefined),
  ]);
  if (name !== USDC_EIP712.name || version !== USDC_EIP712.version) {
    throw new UsageError(`--usdc ${token} has EIP-712 domain name ${JSON.stringify(name ?? null)}, version ${JSON.stringify(version ?? null)}; x429 needs an EIP-3009 token with "${USDC_EIP712.name}", "${USDC_EIP712.version}" (native USDC on Base)`);
  }
  guardMainnet(chainId, p.flags);
  const args = [token, account.address] as const;
  const data = encodeDeployData({ abi: checkoutAbi, bytecode: checkoutBytecode, args });
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  io.out(`chain ${chainId} via ${host(url)}; operator ${account.address}; USDC ${token}`);
  io.out(`X429Checkout bytecode: solc ${checkoutCompiler.solc}, ${(checkoutBytecode.length - 2) / 2} bytes`);
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account, data });
  } catch (err) {
    io.err(`deploy would fail: ${why(err)}`);
    return 1;
  }
  if (p.flags.has("dry-run")) {
    io.out(`dry run: the deploy succeeds in simulation, gas ${gas}; it would create ${predicted} (nonce ${nonce}). Nothing was sent.`);
    return 0;
  }
  const wallet = createWalletClient({ account, chain: client.chain, transport: http(url) });
  const hash = await wallet.sendTransaction({ account, chain: client.chain, data, gas: (gas * 12n) / 10n });
  io.out(`sent ${hash}; waiting for the receipt…`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    io.err(`the deploy transaction failed (${hash})`);
    return 1;
  }
  io.out(`deployed in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  const deployed = getAddress(receipt.contractAddress);
  io.out(`X429_CONTRACT=${deployed}`);
  io.out(`X429_DEPLOY_BLOCK=${receipt.blockNumber}`);
  io.out(`X429_OPERATOR=${account.address}`);
  io.out(`next: x429 queue create --rpc <url> --key-file <path> --contract ${deployed}`);
  return 0;
}

async function queueCreate(p: Parsed, io: Io): Promise<number> {
  const url = rpcUrl(p.values);
  const contract = address(p.values, "contract");
  const key = loadKey(p.values, io.env);
  const maxLength = intIn(p.values, "max-length", 64, 1, 256);
  const feeBps = intIn(p.values, "fee-bps", 0, 0, 1000);
  const rawFee = p.values["join-fee"] ?? "0.001";
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(rawFee)) throw new UsageError('--join-fee is a USDC amount like "0.001"');
  const joinFee = usdc(rawFee);
  if (joinFee > 1_000_000n) throw new UsageError("--join-fee is at most 1 USDC");
  const meta = p.values.meta ?? '{"name":"x429 queue"}';
  if (meta.length > 2_000) throw new UsageError("--meta is at most 2000 characters");
  const { client, chainId } = await connect(url, p.values);
  const account = privateKeyToAccount(key);
  const operator = await client.readContract({ address: contract, abi: checkoutAbi, functionName: "operator" }).catch(() => undefined);
  if (!operator) throw new UsageError(`${contract} is not an X429Checkout on chain ${chainId}`);
  if (operator.toLowerCase() !== account.address.toLowerCase()) throw new UsageError(`the key belongs to ${account.address}, the contract's operator is ${operator}`);
  guardMainnet(chainId, p.flags);
  let queueId: number;
  let request;
  try {
    ({ result: queueId, request } = await client.simulateContract({ account, address: contract, abi: checkoutAbi, functionName: "createQueue", args: [maxLength, feeBps, meta] }));
  } catch (err) {
    io.err(`createQueue would fail: ${why(err)}`);
    return 1;
  }
  io.out(`queue ${queueId}: max length ${maxLength}, skip fee ${feeBps} bps, join fee ${fmtUsd(joinFee)}, meta ${meta}`);
  if (p.flags.has("dry-run")) {
    io.out(`dry run: createQueue succeeds in simulation and would open queue ${queueId}; setJoinFee follows it. Nothing was sent.`);
    return 0;
  }
  const wallet = createWalletClient({ account, chain: client.chain, transport: http(url) });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const created = parseEventLogs({ abi: checkoutAbi, logs: receipt.logs, eventName: "QueueCreated" })[0];
  if (receipt.status !== "success" || !created) {
    io.err(`createQueue failed (${hash})`);
    return 1;
  }
  queueId = created.args.queueId;
  const { request: feeRequest } = await client.simulateContract({ account, address: contract, abi: checkoutAbi, functionName: "setJoinFee", args: [queueId, joinFee] });
  const feeHash = await wallet.writeContract(feeRequest);
  const feeReceipt = await client.waitForTransactionReceipt({ hash: feeHash, timeout: 180_000 });
  if (feeReceipt.status !== "success") {
    io.err(`setJoinFee failed (${feeHash}); the queue exists with join fee 0`);
    return 1;
  }
  io.out(`created in ${hash}, join fee set in ${feeHash}`);
  io.out(`X429_QUEUE_ID=${queueId}`);
  return 0;
}

async function status(p: Parsed, io: Io): Promise<number> {
  const url = rpcUrl(p.values);
  const contract = address(p.values, "contract");
  const queueId = intIn(p.values, "queue", 1, 1, 2 ** 32 - 1);
  const { client, chainId } = await connect(url, p.values);
  let operator: Address;
  try {
    operator = await client.readContract({ address: contract, abi: checkoutAbi, functionName: "operator" });
  } catch {
    throw new UsageError(`${contract} is not an X429Checkout on chain ${chainId}`);
  }
  const [token, count] = await Promise.all([
    client.readContract({ address: contract, abi: checkoutAbi, functionName: "usdc" }),
    client.readContract({ address: contract, abi: checkoutAbi, functionName: "queueCount" }),
  ]);
  if (queueId > count) {
    const out = { chainId, contract, operator, usdc: token, queueCount: count, queue: null };
    if (p.flags.has("json")) io.out(JSON.stringify(out));
    else io.out(`X429Checkout ${contract} on chain ${chainId}: operator ${operator}, USDC ${token}, ${count} queue(s); queue ${queueId} does not exist${count === 0 ? " (run x429 queue create)" : ""}`);
    return count === 0 ? 0 : 1;
  }
  const [info, joinFee, list] = await Promise.all([
    client.readContract({ address: contract, abi: checkoutAbi, functionName: "queueInfo", args: [queueId] }),
    client.readContract({ address: contract, abi: checkoutAbi, functionName: "joinFee", args: [queueId] }),
    client.readContract({ address: contract, abi: checkoutAbi, functionName: "getQueue", args: [queueId, 0, 256] }),
  ]);
  const out = {
    chainId,
    contract,
    operator,
    usdc: token,
    queueCount: count,
    queue: {
      id: queueId,
      length: info.length,
      maxLength: info.maxLength,
      feeBps: info.feeBps,
      joinFee: joinFee.toString(),
      joined: info.joined.toString(),
      served: info.served.toString(),
      skips: info.skips,
      totalCompensation: info.totalCompensation.toString(),
      feesAccrued: info.feesAccrued.toString(),
      meta: info.meta,
      waiting: list.map((t, i) => ({ position: i + 1, ticketId: t.id.toString(), owner: t.owner, skipPrice: t.skipPrice.toString() })),
    },
  };
  if (p.flags.has("json")) {
    io.out(JSON.stringify(out));
    return 0;
  }
  io.out(`X429Checkout ${contract} on chain ${chainId}`);
  io.out(`  operator ${operator}, USDC ${token}`);
  io.out(`  queue ${queueId}: ${info.length}/${info.maxLength} waiting, skip fee ${info.feeBps} bps, join fee ${fmtUsd(joinFee)}`);
  io.out(`  joined ${info.joined}, served ${info.served}, skips ${info.skips}, paid to waiting ${fmtUsd(info.totalCompensation)}, fees ${fmtUsd(info.feesAccrued)}`);
  io.out(`  meta ${info.meta}`);
  for (const w of out.queue.waiting) io.out(`  #${w.position} ticket ${w.ticketId} ${w.owner} asks ${fmtUsd(BigInt(w.skipPrice))}`);
  return 0;
}

function init(p: Parsed, io: Io): number {
  const file = p.values.file ?? ".env.x429";
  const path = file.startsWith("/") ? file : `${io.cwd}/${file}`;
  if (existsSync(path) && !p.flags.has("force")) {
    io.err(`${file} exists; pass --force to overwrite`);
    return 1;
  }
  writeFileSync(path, ENV_TEMPLATE, { mode: 0o600 });
  io.out(`wrote ${file} (mode 600). Fill in X429_RPC_URL, X429_CONTRACT and X429_OPERATOR_KEY_FILE.`);
  return 0;
}

/** Runs the CLI. Returns the exit code; never prints the key. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const p = parseArgs(argv);
    if (p.flags.has("version")) {
      io.out(VERSION);
      return 0;
    }
    const [cmd, sub, ...rest] = p.command;
    if (p.flags.has("help") || !cmd || cmd === "help") {
      io.out(HELP);
      return cmd || p.flags.has("help") ? 0 : 1;
    }
    if (cmd === "deploy" && sub === undefined) return await deploy(p, io);
    if (cmd === "queue" && sub === "create" && rest.length === 0) return await queueCreate(p, io);
    if (cmd === "status" && sub === undefined) return await status(p, io);
    if (cmd === "init" && sub === undefined) return init(p, io);
    throw new UsageError(`unknown command: ${p.command.join(" ")} (see x429 --help)`);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`x429: ${err.message}`);
      return 2;
    }
    io.err(`x429: ${why(err)}`);
    return 1;
  }
}
