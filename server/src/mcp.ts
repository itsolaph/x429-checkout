// Remote MCP server (streamable HTTP, stateless) exposing x429 Checkout as agent tools.
//
// Every tool says which PayBox tool to call next. No tool ever asks for a private key: signatures
// come from PayBox `request_wallet_sign` and payments from PayBox `use_service` / `pay_x402`, so
// every money step goes through the user's passkey approval in PayBox.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CheckoutError, parseAddress, parseUint, type Checkout } from "./checkout.ts";
import { plain, toJson } from "./json.ts";
import { SIGNATURE_HEADER, TICKET_HEADER, fmtUsd, ticketMessage } from "./protocol.ts";
import { v1PaymentRequired } from "./x402.ts";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("EVM address (your PayBox wallet address on Base)");
const units = z.string().regex(/^[0-9]{1,30}$/).describe("USDC amount in base units (6 decimals): 5000 = $0.005");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).describe("65-byte signature returned by PayBox request_wallet_sign");

function ok(value: unknown, next: string) {
  const body = { ...(plain(value) as Record<string, unknown>), next };
  return { content: [{ type: "text" as const, text: toJson(body, 2) }], structuredContent: body };
}

function fail(err: unknown) {
  const body =
    err instanceof CheckoutError
      ? { error: err.reason, message: err.message, ...(plain(err.details) as object) }
      : { error: "internal_error", message: String((err as Error)?.message ?? err).split("\n")[0] };
  return { content: [{ type: "text" as const, text: toJson(body, 2) }], structuredContent: body, isError: true };
}

async function run(fn: () => Promise<ReturnType<typeof ok>>) {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

export const TOOL_NAMES = [
  "x429_status",
  "x429_quote",
  "x429_join_typed_data",
  "x429_join",
  "x429_skip",
  "x429_claim_typed_data",
  "x429_claim",
  "x429_redeem",
] as const;

export function buildMcpServer(checkout: Checkout, busyPath: string, client = "local"): McpServer {
  const cfg = checkout.cfg;
  const server = new McpServer({ name: "x429-checkout", version: "0.2.0" });

  server.registerTool(
    "x429_status",
    {
      title: "Queue status",
      description:
        "Read-only. Shows the x429 queue of this busy API on Base: every waiting ticket with its position, owner and posted skip price, " +
        "and, if you pass `owner` (your PayBox wallet address), your ticket and the USDC you can claim for having been passed. " +
        "Next: to move ahead call x429_quote; to collect compensation call x429_claim_typed_data. Free, no PayBox approval needed.",
      inputSchema: { owner: address.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ owner }) =>
      run(async () => {
        const s = await checkout.status(owner ? parseAddress(owner, "owner") : undefined);
        return ok(s, "Call x429_quote with a targetPosition to price a skip, or x429_join_typed_data to wait in line for free.");
      }),
  );

  server.registerTool(
    "x429_quote",
    {
      title: "Price a skip",
      description:
        "Read-only. Prices moving to `targetPosition` (1 = served next) right now: you pay every ticket you pass its own posted price, plus the operator fee. " +
        "`maxAmountRequired` adds the slippage buffer; that is the most a payment can take, and the unused part is refunded in the same transaction. " +
        "Pass `owner` if you already hold a ticket. Next: show the cost to the user, then call x429_skip. Free, no PayBox approval needed.",
      inputSchema: { targetPosition: z.number().int().min(1).default(1), owner: address.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ targetPosition, owner }) =>
      run(async () => {
        const q = await checkout.quote(targetPosition, owner ? parseAddress(owner, "owner") : undefined);
        return ok(
          { quote: checkout.quoteJson(q), all: await checkout.quotes(owner ? parseAddress(owner, "owner") : undefined) },
          `Skipping to #${targetPosition} costs ${fmtUsd(q.cost)} now (authorize up to ${fmtUsd(q.maxAmountRequired)}). If the user agrees, call x429_skip.`,
        );
      }),
  );

  server.registerTool(
    "x429_join_typed_data",
    {
      title: "Join: typed data to sign",
      description:
        "Builds the EIP-712 `Join` message for your PayBox wallet. Joining is free and gasless: no USDC moves and the operator pays gas. " +
        "`skipPrice` is what you are paid (USDC base units) each time someone passes you. " +
        "Next: call PayBox request_wallet_sign with credential_id = your granted EVM wallet credential and intent {op: \"typedData\", typedData: <typedData>}. " +
        "Then call x429_join with the `submit` fields and the returned signature. Never ask the user for a private key.",
      inputSchema: { owner: address, skipPrice: units.optional() },
    },
    ({ owner, skipPrice }) =>
      run(async () => {
        const r = await checkout.joinTypedData(parseAddress(owner, "owner"), skipPrice ? parseUint(skipPrice, "skipPrice") : undefined);
        return ok(r, 'Call PayBox request_wallet_sign with intent {op: "typedData", typedData}, then x429_join with submit + signature.');
      }),
  );

  server.registerTool(
    "x429_join",
    {
      title: "Join the queue",
      description:
        "Relays your signed `Join` onchain (the operator pays gas). Use the `submit` fields from x429_join_typed_data and the signature from PayBox request_wallet_sign. " +
        "Returns your ticket id, position and the transaction. Next: wait (x429_status shows your position) or pay to move ahead with x429_skip.",
      inputSchema: { owner: address, skipPrice: units, nonce: bytes32, deadline: z.string().regex(/^[0-9]+$/), signature },
    },
    (input) =>
      run(async () => {
        const r = await checkout.join(input, client);
        return ok(r, "You are in line. Poll x429_status; once served, call x429_redeem.");
      }),
  );

  server.registerTool(
    "x429_skip",
    {
      title: "Skip ahead (paid, x402)",
      description:
        "Prepares a paid skip to `targetPosition`. Returns the x402 resource URL (POST) and the current payment requirements (USDC on Base, scheme exact). " +
        "This tool moves no money itself. Next: call PayBox use_service with url = resourceUrl and method = \"POST\": PayBox gets the 402, asks the user to approve with their passkey, " +
        "signs the EIP-3009 authorization, retries, and returns the JSON result (new position, amount paid to each agent passed, refund, tx hash). " +
        "Alternative: PayBox pay_x402 with accepts = accepts and resource_url = resourceUrl, then POST resourceUrl with header X-PAYMENT set to the returned value. " +
        "The authorized amount is a ceiling: you are charged the actual cost when it settles and the rest comes back in the same transaction. " +
        "If the price moved above the ceiling you get a clear error and nothing is charged. If you have no ticket, one is created in the same payment with `skipPrice`.",
      inputSchema: { targetPosition: z.number().int().min(1).default(1), owner: address.optional(), skipPrice: units.optional() },
    },
    ({ targetPosition, owner, skipPrice }) =>
      run(async () => {
        const offer = await checkout.skipOffer(
          targetPosition,
          owner ? parseAddress(owner, "owner") : undefined,
          skipPrice ? parseUint(skipPrice, "skipPrice") : undefined,
        );
        const body = v1PaymentRequired(offer.requirements, "payment required");
        return ok(
          {
            resourceUrl: offer.resourceUrl,
            method: "POST",
            quote: checkout.quoteJson(offer.quote),
            x402Version: 1,
            accepts: body.accepts,
          },
          `Call PayBox use_service with url="${offer.resourceUrl}" and method="POST". The user approves up to ${fmtUsd(offer.quote.maxAmountRequired)} with their passkey; the actual cost is ${fmtUsd(offer.quote.cost)} now.`,
        );
      }),
  );

  server.registerTool(
    "x429_claim_typed_data",
    {
      title: "Claim: typed data to sign",
      description:
        "Shows the USDC you earned for being passed and builds the EIP-712 `Claim` message. Claiming is gasless: the operator relays it and pays gas; the USDC goes to `recipient` (default: you). " +
        "Next: call PayBox request_wallet_sign with intent {op: \"typedData\", typedData}, then x429_claim with the `submit` fields and the signature.",
      inputSchema: { owner: address, recipient: address.optional() },
    },
    ({ owner, recipient }) =>
      run(async () => {
        const r = await checkout.claimTypedData(parseAddress(owner, "owner"), recipient ? parseAddress(recipient, "recipient") : undefined);
        return ok(r, `Claimable now: ${fmtUsd(r.claimable)}. Sign with PayBox request_wallet_sign, then call x429_claim.`);
      }),
  );

  server.registerTool(
    "x429_claim",
    {
      title: "Claim compensation",
      description:
        "Relays your signed `Claim` (operator pays gas) and sends all your claimable USDC to the signed recipient. A signature works once. " +
        "Next: check the balance with PayBox get_portfolio if needed.",
      inputSchema: { owner: address, recipient: address.optional(), nonce: bytes32, deadline: z.string().regex(/^[0-9]+$/), signature },
    },
    (input) =>
      run(async () => {
        const r = await checkout.claim(input);
        return ok(r, `Sent ${fmtUsd(r.amount)} to ${r.recipient}.`);
      }),
  );

  server.registerTool(
    "x429_redeem",
    {
      title: "Use a served ticket",
      description:
        "Once your ticket is served, redeem it for one request to the busy API. Without `signature` this returns the exact message to sign. " +
        "Next: call PayBox request_wallet_sign with intent {op: \"message\", message}, then call x429_redeem again with ticketId and the signature. " +
        "Signing this message moves no money. A served ticket must be redeemed within the admission window.",
      inputSchema: {
        ticketId: z.string().regex(/^[0-9]+$/),
        signature: signature.optional(),
        query: z.string().max(200).optional().describe("query string for the busy API, e.g. city=Lisbon"),
      },
    },
    ({ ticketId, signature: sig, query }) =>
      run(async () => {
        const message = ticketMessage(cfg.chainId, cfg.contract, ticketId);
        if (!sig) {
          return ok({ ticketId, message }, 'Call PayBox request_wallet_sign with intent {op: "message", message}, then x429_redeem with the signature.');
        }
        const url = `${cfg.publicUrl}${busyPath}${query ? `?${query}` : ""}`;
        const res = await fetch(url, { headers: { [TICKET_HEADER]: ticketId, [SIGNATURE_HEADER]: sig } });
        const body = await res.json().catch(() => null);
        const next =
          res.status === 200
            ? "Done: this is the API response."
            : res.status === 429
              ? `Not served yet; retry after ${res.headers.get("retry-after") ?? "a few"} s.`
              : "Redemption refused; see the reason.";
        return ok({ status: res.status, body }, next);
      }),
  );

  return server;
}

/**
 * The MCP tool list in the shape of the PayBox SDK's `PluginSummary` (type "unofficial", tools with
 * inline JSON schemas). The third-party plugin format is not published yet; this is the thin layer
 * to adapt once it is. Built by listing tools from an in-process MCP client, so it never drifts.
 */
export async function pluginManifest(checkout: Checkout, busyPath: string) {
  const server = buildMcpServer(checkout, busyPath);
  const client = new Client({ name: "x429-manifest", version: "0.2.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return {
    id: "x429-checkout",
    name: "x429 Checkout",
    description:
      "Pay to skip the line at a rate-limited API. Every agent you pass is paid its posted price in USDC on Base (x402). Joining and claiming are free, gasless signatures.",
    type: "unofficial" as const,
    enabled: true,
    protocol_version: LATEST_PROTOCOL_VERSION,
    mcp_url: `${checkout.cfg.publicUrl}/mcp`,
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
    })),
  };
}

/** Handles one MCP HTTP request in stateless mode (a fresh server + transport per request). */
export async function handleMcp(
  checkout: Checkout,
  busyPath: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  client: string,
): Promise<void> {
  const server = buildMcpServer(checkout, busyPath, client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
