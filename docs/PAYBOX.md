# x429 Checkout with PayBox: the agent flow

This is the exact sequence an agent follows when it hits a busy x429 API and its user has a PayBox
wallet. The agent never sees a key. Every money step pauses for the user's passkey in PayBox.

Tool and field names come from the PayBox MCP tool schemas and the `@paybox-sh/sdk` 2.2.0 types
(`dist/index.d.ts`: `RequestWalletSignArgs`, `X402Args`, `UseServiceArgs`, `AgentResponse`,
`CredentialOutput`, `PluginSummary`). The x429 side is the MCP server at `<api>/mcp` (tools
`x429_*`) or the same actions over plain HTTP (see `docs/SPEC.md`).

Amounts are USDC base units (6 decimals) unless a field says `Usd`.

The x429 JSON below is what the server returns (checked by `scripts/mcp-smoke.sh` and
`scripts/e2e-local.sh`). The PayBox responses follow the SDK types and PayBox's tool descriptions;
they were not captured from a live PayBox payment (nothing was sent to a public network), so field
values inside `output.value` are shown as documented, not as observed.

## 0. Once: find the wallet

```jsonc
// PayBox: list_credentials {}
// → pick a granted wallet credential on EVM. The same MPC address is used on every eip155 chain.
{
  "credentials": [{
    "credential": { "id": "cred_…", "credential_type": "wallet", "name": "main-evm", "metadata": { "address": "0xYou…" } },
    "grant": { "credential_id": "cred_…", "approval_mode": "paybox" }
  }],
  "ungranted": [],
  "agent_signer_recorded": true
}
```

Keep `credential_id` (an id, never the wallet name) and the wallet address.

## 1. The API says 429

```
GET https://api.example.com/v1/forecast?city=Lisbon
→ 429 Too Many Requests, Retry-After: 18
{ "error": "too_many_requests",
  "message": "Busy. You are #7 in line; skipping to the front costs $0.0309 right now, paid to the 6 agents you pass.",
  "x429": { "version": "0.2", "network": "eip155:8453", "skip": { "url": ".../skip?queue=1&target=1", "toFront": { "cost": "30900", "maxAmountRequired": "37080" } }, "mcp": ".../mcp", … } }
```

The agent now has two choices: wait for free (step 6) or pay to move ahead (steps 2 to 5). It tells
the user the price in one line, from `message`.

## 2. Price it (free, read-only)

```jsonc
// x429: x429_quote { "targetPosition": 1, "owner": "0xYou…" }
{
  "quote": {
    "fromPosition": 7, "targetPosition": 1, "passes": 6,
    "compensation": "30000", "fee": "900", "cost": "30900", "maxAmountRequired": "37080",
    "costUsd": "$0.0309", "maxUsd": "$0.03708",
    "passed": [{ "position": 1, "ticketId": "1", "owner": "0x…", "amount": "3000" }, …]
  },
  "all": [ /* one quote per target position */ ],
  "next": "Skipping to #1 costs $0.0309 now (authorize up to $0.03708). If the user agrees, call x429_skip."
}
```

## 3. Make sure there is USDC on Base

```jsonc
// PayBox: get_portfolio { "address": "0xYou…", "network_id": 8453, "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
// compare the raw `balance` (base units) with maxAmountRequired ("37080").
// If short, PayBox: get_buy_link { "credential_id": "cred_…", "destination_chain": "eip155:8453", "currency_code": "usdc_base", "amount_usd": 5 }
// → { "url": "https://…moonpay…", "currency_code": "usdc_base", "wallet_address": "0xYou…", "network": "eip155:8453" }
```

No ETH is needed, ever: the payment is a signature (EIP-3009) and the operator pays gas.

## 4. Pay to skip (x402, one passkey approval)

```jsonc
// x429: x429_skip { "targetPosition": 1, "owner": "0xYou…" }
{
  "resourceUrl": "https://api.example.com/skip?queue=1&target=1&owner=0xYou…",
  "method": "POST",
  "quote": { "cost": "30900", "maxAmountRequired": "37080", … },
  "x402Version": 1,
  "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "37080",
                "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "<queue contract>",
                "resource": "https://api.example.com/skip?queue=1&target=1&owner=0xYou…",
                "maxTimeoutSeconds": 120, "extra": { "name": "USD Coin", "version": "2", "x429": { … } } }],
  "next": "Call PayBox use_service with url=\"…/skip?queue=1&target=1&owner=0xYou…\" and method=\"POST\". …"
}
```

`x429_skip` moves no money. The payment happens in PayBox, in one of two ways.

### 4a. `use_service` (recommended: PayBox fetches, pays and re-fetches)

```jsonc
// PayBox: use_service { "credential_id": "cred_…", "url": "<resourceUrl>", "method": "POST" }
// → AgentResponse
{ "request_id": "req_…", "status": "pending_approval", "output": null, "approval_id": "apr_…", "error": null }
// the user approves the payment with their passkey (seconds to minutes). The authorized amount is the
// ceiling (quote + 20%), so ordinary price moves during the approval are absorbed; a bigger move fails
// with price_moved and charges nothing

// PayBox: get_request { "request_id": "req_…" }   — poll until success | denied | error
{
  "request_id": "req_…", "status": "success",
  "output": {
    "output_type": "payment_token", "credential_id": "cred_…", "one_time": true, …,
    "value": {
      "payment": { "status": "…", "ok": true },
      "resource": { "ok": true, "status": 200, "body": {
        "ok": true, "ticketId": "7", "fromPosition": 7, "position": 1, "passes": 6,
        "compensation": "30000", "fee": "900", "cost": "30900", "refund": "6180",
        "passed": [{ "ticketId": "1", "owner": "0x…", "amount": "3000" }, …],
        "txHash": "0x…", "explorerUrl": "https://basescan.org/tx/0x…",
        "message": "You are now #1. Paid 6 agent(s) 30000 units in total, fee 900, refunded 6180."
      } }
    }
  },
  "error": null
}
```

The paid result is `output.value.resource.body` (PayBox also mirrors it in `output.value.response.body`).
Tell the user: "You are #1. You paid $0.0309 to the 6 agents you passed; $0.00618 of the $0.03708
authorized came back in the same transaction."

### 4b. `pay_x402` (header mode: the agent posts the payment itself)

```jsonc
// PayBox: pay_x402 { "credential_id": "cred_…", "accepts": <accepts from x429_skip>, "resource_url": "<resourceUrl>" }
// for x402 v2 also pass "x402_version": 2 and the "resource" block from the PAYMENT-REQUIRED header
// → pending_approval → (passkey) → get_request → success
{ "status": "success", "output": { "value": { "x_payment": "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLC4uLn0=" } } }
```

```
POST <resourceUrl>
X-PAYMENT: <output.value.x_payment>
→ 200 { "ok": true, "position": 1, … }   + X-PAYMENT-RESPONSE: base64({success, transaction, network, payer})
```

`pay_x402` only proves PayBox signed a valid authorization; the 200 from `/skip` is the proof of
payment.

### When the payment fails

Nothing is charged on any failure; the server answers 402 with a reason and a fresh quote:

| `error` | What the agent does |
|---|---|
| `price_moved` | someone moved ahead in the meantime. Show the new `cost`, ask again, repeat step 4 |
| `quote_expired` (v2) / `invalid_exact_evm_payload_authorization_valid_before` | the approval took too long; repeat step 4 |
| `payment_already_settled` | this payment was already used (a retry); check `x429_status` |
| `insufficient_funds` | step 3 (`get_buy_link`) |
| `nothing_to_pass` (409) | already at or ahead of the target |

Never re-call `use_service` / `pay_x402` to finish a pending request: poll `get_request` with the
same `request_id`. A new call can mean a new payment.

## 5. Get served and use the ticket

```jsonc
// x429: x429_status { "owner": "0xYou…" }  → { "you": { "ticket": { "id": "7", "position": 1 } } }
// when served (the ticket disappears from the line), redeem it:
// x429: x429_redeem { "ticketId": "7" }
{ "ticketId": "7", "message": "x429:v2:8453:0x51ce…3e0e:7", "next": "Call PayBox request_wallet_sign with intent {op: \"message\", message}, …" }

// PayBox: request_wallet_sign { "credential_id": "cred_…", "intent": { "op": "message", "message": "x429:v2:8453:0x51ce…3e0e:7" } }
// → get_request until success; output.output_type = "signature", output.value carries the 65-byte signature

// x429: x429_redeem { "ticketId": "7", "signature": "0x…", "query": "city=Lisbon" }
{ "status": 200, "body": { "city": "Lisbon", "hours": [ … ], "admitted": { "via": "queue", "ticketId": "7", "waitedSeconds": 16 } } }
```

Signing the redeem message moves no money. Without MCP, the agent repeats its original request with
headers `X-429-Ticket: 7` and `X-429-Signature: 0x…`.

## 6. Wait for free instead (gasless join)

```jsonc
// x429: x429_join_typed_data { "owner": "0xYou…", "skipPrice": "5000" }
{
  "typedData": {
    "domain": { "name": "x429 Checkout", "version": "1", "chainId": 8453, "verifyingContract": "<queue contract>" },
    "types": { "EIP712Domain": [ … ], "Join": [ { "name": "owner", "type": "address" }, { "name": "queueId", "type": "uint32" },
               { "name": "skipPrice", "type": "uint128" }, { "name": "nonce", "type": "bytes32" }, { "name": "deadline", "type": "uint256" } ] },
    "primaryType": "Join",
    "message": { "owner": "0xYou…", "queueId": 1, "skipPrice": "5000", "nonce": "0x…", "deadline": "1792037665" }
  },
  "submit": { "owner": "0xYou…", "skipPrice": "5000", "nonce": "0x…", "deadline": "1792037665" }
}

// PayBox: request_wallet_sign { "credential_id": "cred_…", "intent": { "op": "typedData", "typedData": <typedData> } }
// x429: x429_join { …submit, "signature": "0x…" }   → { "ticketId": "12", "position": 8, "txHash": "0x…" }
```

`skipPrice` is what the user is paid each time another agent passes them ($0.005 here). Then poll
`x429_status` and redeem as in step 5.

## 7. Collect what you earned (gasless claim)

```jsonc
// x429: x429_claim_typed_data { "owner": "0xYou…" }
{ "claimable": "15000", "typedData": { "primaryType": "Claim", "message": { "owner": "0xYou…", "recipient": "0xYou…", "nonce": "0x…", "deadline": "…" }, … }, "submit": { … } }
// PayBox: request_wallet_sign { "credential_id": "cred_…", "intent": { "op": "typedData", "typedData": <typedData> } }
// x429: x429_claim { …submit, "signature": "0x…" }   → { "amount": "15000", "amountUsd": "$0.015", "txHash": "0x…" }
```

The operator pays the gas; the USDC goes to the signed recipient. A claim signature works once.

## What needs the user's passkey

| Step | PayBox tool | Moves money | Approval |
|---|---|---|---|
| quote, status | none | no | no |
| skip | `use_service` or `pay_x402` | yes: at most `maxAmountRequired` USDC, usually less | **always** |
| join, claim | `request_wallet_sign` (typedData) | no (claim sends *to* the user) | per the wallet grant's `approval_mode` |
| redeem | `request_wallet_sign` (message) | no | per the wallet grant's `approval_mode` |

## As a PayBox plugin

The third-party plugin format is not published yet. The SDK types show `PluginSummary`
`{id, name, description, type: "official" | "unofficial", enabled, protocol_version, tools: PluginToolSummary[]}`
with `PluginToolSummary {name, title?, description?, inputSchema, outputSchema?, annotations?}`,
which is what an MCP `tools/list` returns. The server publishes that shape at
`GET /paybox-plugin.json`, generated from the live MCP tool list:

```jsonc
{
  "id": "x429-checkout", "name": "x429 Checkout", "type": "unofficial", "enabled": true,
  "protocol_version": "2025-11-25", "mcp_url": "https://api.example.com/mcp",
  "tools": [{ "name": "x429_skip", "title": "Skip ahead (paid, x402)", "description": "…", "inputSchema": { "type": "object", … }, "annotations": null }, …]
}
```

Once listed, an agent would call the same tools through `use_plugin { plugin_id: "x429-checkout",
tool_id: "x429_skip", input: { targetPosition: 1 } }`. The payment itself still goes through
`use_service` / `pay_x402`, so it keeps PayBox's passkey approval.
