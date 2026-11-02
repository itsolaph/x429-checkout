// `npx x429`: argument parsing, dry runs that send nothing, deploy / queue create / status on a local
// anvil, the mainnet guard, init, and the key never printed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkoutAbi } from "x429";
import { parseArgs, UsageError } from "../dist/cli.js";
import { cli, KEYS, skipReason, startChain, type Chain } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/x429.js", import.meta.url));
const chains: Chain[] = [];
after(() => chains.forEach((c) => c.stop()));

test("parseArgs: commands, --name value, --name=value, flags; unknown or keyed options are refused", () => {
  const p = parseArgs(["queue", "create", "--max-length", "32", "--meta={\"a\":1}", "--dry-run", "--rpc=http://x"]);
  assert.deepEqual(p.command, ["queue", "create"]);
  assert.deepEqual(p.values, { "max-length": "32", meta: '{"a":1}', rpc: "http://x" });
  assert.deepEqual([...p.flags], ["dry-run"]);
  assert.deepEqual([...parseArgs(["-h"]).flags], ["help"]);
  assert.throws(() => parseArgs(["deploy", "--rcp", "x"]), (e: Error) => e instanceof UsageError && /unknown option --rcp/.test(e.message));
  assert.throws(() => parseArgs(["deploy", "--rpc"]), /--rpc needs a value/);
  assert.throws(() => parseArgs(["deploy", "--rpc", "--dry-run"]), /--rpc needs a value/);
  assert.throws(() => parseArgs(["deploy", "--dry-run=1"]), /takes no value/);
  assert.throws(() => parseArgs(["deploy", "--key", KEYS[0]!]), /never on the command line/);
  assert.throws(() => parseArgs(["deploy", `--key=${KEYS[0]!}`]), (e: Error) => !e.message.includes(KEYS[0]!.slice(2)));
});

test("usage errors exit 2 with a sentence; help and version exit 0", async () => {
  assert.equal((await cli([])).code, 1);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /x429 deploy --rpc <url> --key-file <path>/);
  assert.equal((await cli(["--version"])).out, "0.1.0");
  const noRpc = await cli(["deploy", "--key-file", "/tmp/nope"]);
  assert.equal(noRpc.code, 2);
  assert.match(noRpc.err, /--rpc is required/);
  const noKey = await cli(["deploy", "--rpc", "http://127.0.0.1:9"]);
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /an operator key is needed/);
  const both = await cli(["deploy", "--rpc", "http://127.0.0.1:9", "--key-file", "/tmp/k"], { X429_OPERATOR_KEY: KEYS[0] });
  assert.match(both.err, /not both/);
  const badKey = await cli(["deploy", "--rpc", "http://127.0.0.1:9"], { X429_OPERATOR_KEY: `${KEYS[0]}ff` });
  assert.match(badKey.err, /32 bytes of hex/);
  assert.ok(!badKey.err.includes(KEYS[0]!.slice(2)));
  assert.match((await cli(["deploy", "now"])).err, /unknown command: deploy now/);
  const unreachable = await cli(["status", "--rpc", "http://127.0.0.1:9/key-in-path", "--contract", "0x1B70dcDC800a0B18c7a3100a9833FA4e923044C1"]);
  assert.equal(unreachable.code, 2);
  assert.match(unreachable.err, /cannot reach the RPC at 127\.0\.0\.1:9$/);
});

test("deploy --dry-run simulates and sends nothing; deploy, queue create and status work on anvil", { skip: skipReason }, async () => {
  const c = await startChain({ deploy: false });
  chains.push(c);
  const operator = privateKeyToAccount(KEYS[0]!).address;
  const nonce0 = await c.client.getTransactionCount({ address: operator });

  const dry = await cli(["deploy", "--rpc", c.rpc, "--key-file", c.keyFile, "--usdc", c.usdc, "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  const predicted = dry.out.match(/it would create (0x[0-9a-fA-F]{40})/)![1] as Address;
  assert.match(dry.out, /Nothing was sent\./);
  assert.equal(await c.client.getTransactionCount({ address: operator }), nonce0, "no transaction");
  assert.equal(await c.client.getCode({ address: predicted }), undefined, "no contract");

  const real = await cli(["deploy", "--rpc", c.rpc, "--usdc", c.usdc], { X429_OPERATOR_KEY: KEYS[0] });
  assert.equal(real.code, 0, real.err);
  const contract = real.out.match(/X429_CONTRACT=(0x[0-9a-fA-F]{40})/)![1] as Address;
  assert.equal(contract, getAddress(predicted), "deployed where the dry run said");
  assert.match(real.out, /X429_DEPLOY_BLOCK=\d+/);
  assert.equal(await c.client.readContract({ address: contract, abi: checkoutAbi, functionName: "operator" }), operator);
  assert.equal(await c.client.readContract({ address: contract, abi: checkoutAbi, functionName: "usdc" }), c.usdc);
  for (const out of [dry.out, dry.err, real.out, real.err]) assert.ok(!out.toLowerCase().includes(KEYS[0]!.slice(2)), "the key is never printed");

  const empty = await cli(["status", "--rpc", c.rpc, "--contract", contract]);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /0 queue\(s\); queue 1 does not exist \(run x429 queue create\)/);

  const qdry = await cli(["queue", "create", "--rpc", c.rpc, "--key-file", c.keyFile, "--contract", contract, "--fee-bps", "250", "--join-fee", "0.002", "--meta", '{"name":"cli test"}', "--dry-run"]);
  assert.equal(qdry.code, 0, qdry.err);
  assert.match(qdry.out, /would open queue 1/);
  assert.equal(await c.client.readContract({ address: contract, abi: checkoutAbi, functionName: "queueCount" }), 0);

  const foreign = await cli(["queue", "create", "--rpc", c.rpc, "--contract", contract], { X429_OPERATOR_KEY: KEYS[2] });
  assert.equal(foreign.code, 2);
  assert.match(foreign.err, /the key belongs to 0x[0-9a-fA-F]{40}, the contract's operator is/);

  const tooHigh = await cli(["queue", "create", "--rpc", c.rpc, "--key-file", c.keyFile, "--contract", contract, "--fee-bps", "1001"]);
  assert.equal(tooHigh.code, 2);
  assert.match(tooHigh.err, /--fee-bps must be an integer from 0 to 1000/);

  const q = await cli(["queue", "create", "--rpc", c.rpc, "--key-file", c.keyFile, "--contract", contract, "--fee-bps", "250", "--join-fee", "0.002", "--meta", '{"name":"cli test"}']);
  assert.equal(q.code, 0, q.err);
  assert.match(q.out, /X429_QUEUE_ID=1$/m);

  const st = await cli(["status", "--rpc", c.rpc, "--contract", contract, "--json"]);
  assert.equal(st.code, 0, st.err);
  const s = JSON.parse(st.out);
  assert.equal(s.operator, operator);
  assert.equal(s.queue.feeBps, 250);
  assert.equal(s.queue.joinFee, "2000");
  assert.equal(s.queue.maxLength, 64);
  assert.equal(s.queue.meta, '{"name":"cli test"}');
  assert.deepEqual(s.queue.waiting, []);
  const human = await cli(["status", "--rpc", c.rpc, "--contract", contract]);
  assert.match(human.out, /queue 1: 0\/64 waiting, skip fee 250 bps, join fee \$0\.002/);

  // the bin script runs the compiled CLI
  const bin = spawnSync(process.execPath, [BIN, "status", "--rpc", c.rpc, "--contract", contract], { encoding: "utf8" });
  assert.equal(bin.status, 0, bin.stderr);
  assert.match(bin.stdout, /X429Checkout 0x[0-9a-fA-F]{40} on chain 31337/);
});

test("on a mainnet chain id nothing is sent without --yes; --dry-run still simulates", { skip: skipReason }, async () => {
  const c = await startChain({ deploy: false, chainId: 8453 });
  chains.push(c);
  const operator = privateKeyToAccount(KEYS[0]!).address;
  const nonce0 = await c.client.getTransactionCount({ address: operator });
  const refused = await cli(["deploy", "--rpc", c.rpc, "--key-file", c.keyFile, "--usdc", c.usdc]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /chain 8453 is a mainnet: this sends a real transaction\. Run with --dry-run first, then again with --yes\./);
  const dry = await cli(["deploy", "--rpc", c.rpc, "--key-file", c.keyFile, "--usdc", c.usdc, "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(await c.client.getTransactionCount({ address: operator }), nonce0);
  const noUsdc = await cli(["deploy", "--rpc", c.rpc, "--key-file", c.keyFile, "--dry-run"]);
  assert.equal(noUsdc.code, 2);
  assert.match(noUsdc.err, /--usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 has no code on chain 8453/);
});

test("init writes a template without secrets (mode 600) and never overwrites without --force", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "x429-init-"));
  const first = await cli(["init"], {}, dir);
  assert.equal(first.code, 0, first.err);
  const file = join(dir, ".env.x429");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.match(text, /^X429_CONTRACT=$/m);
  assert.match(text, /^X429_OPERATOR_KEY_FILE=$/m);
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{64}/, "no key in the template");
  const again = await cli(["init"], {}, dir);
  assert.equal(again.code, 1);
  assert.match(again.err, /exists; pass --force/);
  assert.equal((await cli(["init", "--force", "--file", "other.env"], {}, dir)).code, 0);
});
