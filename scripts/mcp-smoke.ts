// MCP smoke test: connects to the server's /mcp with the official MCP client (streamable HTTP),
// lists the tools, and drives them the way an agent with PayBox would. Local test keys stand in for
// PayBox `request_wallet_sign` and `pay_x402`.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hex } from "viem";
import { SimAgent } from "../agent-sim/agent.ts";
import { TOOL_NAMES } from "../server/src/mcp.ts";

const API = process.env.X429_URL ?? "http://127.0.0.1:8429";
const keys = JSON.parse(readFileSync(process.env.E2E_KEYS!, "utf8")) as { rivals: Hex[]; skipper: Hex };
let passed = 0;

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
  passed++;
}

type ToolResult = { structuredContent?: any; isError?: boolean; content: { type: string; text?: string }[] };

const client = new Client({ name: "x429-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`)));

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
  check(typeof r.content[0]?.text === "string" && r.structuredContent, `${name} returns text and structured content`);
  return r.structuredContent;
}

// 1. tools are listed, each says what to call next in PayBox and none asks for a private key
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()), `tool list: ${names.join(", ")}`);
for (const t of tools) {
  const d = t.description ?? "";
  check(!/private key/i.test(d) || /never ask/i.test(d), `${t.name} never asks for a private key`);
  check(t.inputSchema?.type === "object", `${t.name} has an input schema`);
}
for (const n of ["x429_join_typed_data", "x429_claim_typed_data", "x429_redeem"]) {
  check(/request_wallet_sign/.test(tools.find((t) => t.name === n)!.description!), `${n} points to PayBox request_wallet_sign`);
}
check(/use_service/.test(tools.find((t) => t.name === "x429_skip")!.description!), "x429_skip points to PayBox use_service");
console.log(`[mcp] ${tools.length} tools: ${names.join(", ")}`);

// 2. status on an empty queue
const empty = await call("x429_status");
check(empty.queue.length === 0, "queue starts empty");
check(empty.queue.chainId === 8453, "Base chain id");

// 3. two agents join through the MCP tools (typed data → wallet signature → relay)
const agents = keys.rivals.slice(0, 2).map((k, i) => new SimAgent(`mcp-rival-${i + 1}`, k, API, 8453));
for (const [i, a] of agents.entries()) {
  const td = await call("x429_join_typed_data", { owner: a.address, skipPrice: String(4_000 + i * 1_000) });
  check(/request_wallet_sign/.test(td.next), "join typed data says to call request_wallet_sign");
  check(td.typedData.primaryType === "Join", "Join typed data");
  const signature = await a.account.signTypedData(td.typedData); // PayBox: request_wallet_sign op typedData
  const joined = await call("x429_join", { ...td.submit, signature });
  check(Number(joined.position) === i + 1, `${a.name} joined at #${i + 1}`);
}

// 4. status and quote
const status = await call("x429_status", { owner: agents[1]!.address });
check(status.queue.length === 2 && status.you.ticket.position === 2, "status shows the caller's ticket");
const quote = await call("x429_quote", { targetPosition: 1 });
check(quote.quote.passes === 2, "a newcomer passes 2 tickets to reach #1");
check(quote.quote.compensation === "9000", "compensation = 4000 + 5000");
check(quote.quote.cost === String(9000 + Math.floor((9000 * 300) / 10000)), "cost includes the 3% fee");
console.log(`[mcp] x429_quote: ${quote.next}`);

// 5. skip: returns the x402 resource for PayBox; pay it like pay_x402 would, then check status
const payer = new SimAgent("mcp-payer", keys.skipper, API, 8453);
const skip = await call("x429_skip", { targetPosition: 1, owner: payer.address });
check(/use_service/.test(skip.next) && skip.method === "POST", "x429_skip says to call PayBox use_service with POST");
check(skip.accepts[0].scheme === "exact" && skip.accepts[0].network === "base", "x402 exact on Base");
const req = skip.accepts[0];
const payload = await payer.signExact({ asset: req.asset, payTo: req.payTo, amount: BigInt(req.maxAmountRequired), maxTimeoutSeconds: req.maxTimeoutSeconds });
const paid = await payer.http("POST", skip.resourceUrl, undefined, payer.v1Header(payload));
check(paid.status === 200 && paid.body.position === 1, `paid skip settles (${paid.status})`);
const after = await call("x429_status", { owner: payer.address });
check(after.you.ticket.position === 1, "payer is #1 after the skip");

// 6. claim typed data for a passed rival, then claim through MCP
const claimTd = await call("x429_claim_typed_data", { owner: agents[0]!.address });
check(claimTd.claimable === "4000", "rival 1 can claim exactly its price");
const claimSig = await agents[0]!.account.signTypedData(claimTd.typedData);
const claimed = await call("x429_claim", { ...claimTd.submit, signature: claimSig });
check(claimed.amount === "4000", "claimed through MCP");

// 7. redeem without a signature returns the exact message to sign
const redeem = await call("x429_redeem", { ticketId: String(after.you.ticket.id) });
check(redeem.message.startsWith("x429:v2:8453:"), "redeem message");
check(/request_wallet_sign/.test(redeem.next), "redeem says to call request_wallet_sign op message");

// 8. a bad input comes back as a tool error, not a crash
const bad = (await client.callTool({ name: "x429_quote", arguments: { targetPosition: 9 } })) as ToolResult;
check(bad.isError === true, "quote beyond the line is a tool error");

// 9. the PayBox-shaped plugin manifest lists the same tools with inline schemas
const manifest = await (await fetch(`${API}/paybox-plugin.json`)).json();
check(manifest.type === "unofficial" && manifest.mcp_url === `${API}/mcp`, "manifest points at /mcp");
check(JSON.stringify(manifest.tools.map((t: { name: string }) => t.name).sort()) === JSON.stringify(names), "manifest tools = MCP tools");
check(manifest.tools.every((t: { inputSchema: { type: string } }) => t.inputSchema.type === "object"), "manifest carries input schemas");

await client.close();
console.log(`[mcp] PASS: ${passed} checks`);
process.exit(0);
