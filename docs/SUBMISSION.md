# PayBox submission: x429 Checkout

## Project

**Name:** x429 Checkout

**Description (248 characters):**

> Paid priority for busy APIs. When an API is saturated, an agent pays the agents waiting ahead of it in USDC on Base (x402) to move up, and everyone it passes is paid automatically. Join for $0.001, quote, skip with one passkey approval, get served.

**Bundle:** `plugin/dist/plugin.mjs`, built with `cd plugin && pnpm install --frozen-lockfile && pnpm test`
(Node 24.21.0, pnpm 11.11.0). Upload only that file: no source maps, no `.env`, no `node_modules`.
Bytes and SHA-256 of the tested build are in the build report; rebuild and retest after any source change.

## Portal configuration

| Setting | Value |
|---|---|
| Network host | the hostname of the x429 server, e.g. `x429.example.com` (exactly one host; no wildcard) |
| Environment variable | `X429_API_BASE` = `https://x429.example.com` (bare https origin, no path) |
| Secrets / brokered headers | none |

The same host serves the reads (plain HTTPS from the plugin) and the two x402 resources
(`POST /join`, `POST /skip`) that PayBox fetches and pays. No network call happens at startup or
during tool discovery. Every tool call makes at most two requests with a 4-second timeout each.

Without `X429_API_BASE`, `x429_status` answers `configured: false` with an explanation (this is the
sample call in `paybox-plugin.json`, so local conformance passes offline); the other tools return a
tool error saying the variable is missing.

## Test console inputs

Run them in this order; the token comes from the paid response of a join or skip made through an
agent (the console shows proposals as data and never pays).

| Tool | Input | Expected |
|---|---|---|
| `x429_status` | `{}` | queue length, posted prices, cost to reach each position, join fee, ETA |
| `x429_quote` | `{"targetPosition": 1}` | cost to the front, ceiling (cost + 20%), `quoteExpiresAt` |
| `x429_join` | `{"skipPriceUsdc": "0.005"}` | x402 proposal: `POST https://<host>/join`, `maxAmount` = join fee (`1000` = 0.001 USDC). **Validate transaction** sends the unpaid request and previews the 402 |
| `x429_skip` | `{"targetPosition": 1}` | x402 proposal: `POST https://<host>/skip` body `{"target":1}`, `maxAmount` = live ceiling, expiry ≤ 4 min |
| `x429_use` | `{"token": "x429_…", "city": "Lisbon"}` | `waiting` with position and ETA, or `served` with the forecast |
| `x429_status` | `{"token": "x429_…"}` | the same queue plus your ticket |
| `x429_earnings` | `{"address": "0x…"}` (a demo agent's address from `x429_status`) | earned, received, pending |

Validation of a join or skip proposal sends one unpaid POST, which only returns a 402: it creates
nothing and moves no money.

## Agent flow (what to tell the agent)

1. `x429_status` (or the API's 429) shows the line and the price to the front.
2. `x429_join` → PayBox asks the user to approve 0.001 USDC → the paid response has `token`.
   Or straight `x429_skip` to join and move up in one payment.
3. `x429_quote {targetPosition}` → `x429_skip {targetPosition, token}` → PayBox shows the payment
   (at most the ceiling; the unused part comes back in the same transaction) → passkey → the paid
   response has the new position and a fresh token. The agents passed are paid automatically.
4. `x429_use {token}` until `status: "served"`; the result is the API's answer.

## Demo video script (75 s)

| Time | Screen | Voice-over |
|---|---|---|
| 0–8 s | Agent chat: "Get me today's Lisbon forecast." The agent calls the forecast API and gets `429 Too Many Requests`: "You are #7 in line; skipping to the front costs $0.0309, paid to the 6 agents you pass." | "Busy APIs say 429 and make agents wait. x429 puts a price on the line." |
| 8–20 s | The agent calls `x429_status`: 6 agents waiting (labeled demo agents), their posted prices, the cost to reach each position. Dashboard on the side shows the same line. | "Every waiting agent posts what it wants to be paid for being passed." |
| 20–30 s | `x429_quote {targetPosition: 1}`: cost $0.0309, ceiling $0.0371, expires in 10 min. The agent asks the user: "Pay up to $0.037 to go first?" | "The quote is live; a 20% buffer covers price moves, and the rest is refunded." |
| 30–45 s | `x429_skip` returns the x402 proposal; PayBox opens the payment window (USDC on Base, max $0.0371); the user approves with a passkey. | "One passkey approval. No ETH, no gas, no extra signatures: x402 is the only user action." |
| 45–58 s | Paid response: "You are now #1. Paid 6 agents $0.03, refunded $0.0062." Dashboard ledger: six "received … automatically" rows appear, one per passed agent, each with its own price. `x429_earnings` for one of them. | "In the same transaction every agent it passed earned its price, and the operator pushes the USDC straight to their wallets." |
| 58–72 s | `x429_use` → `waiting, #1, 3 s` → `served`: "Lisbon: 8 to 20 °C, take an umbrella at 09:00." | "When its turn comes, the agent uses its redeem token and gets the answer." |
| 72–75 s | Title card: x429 Checkout, HTTP 429 with a price. | "Sell priority, pay the people who wait." |

The six rivals in the demo are the operator's demo agents (`agent-sim/demo-rivals.ts`, addresses in
`X429_DEMO_AGENTS`); the dashboard and `x429_status` label them as such.

## Before the deadline (Sat 17 Oct 2026, 20:00 New York)

1. Host the server behind HTTPS (see REPORT Phase 2 "What is left").
2. Deploy the contract (`scripts/deploy-base.sh <env> --broadcast`), fund the operator with ETH and
   the demo agents with a little USDC, start the server and `demo-rivals.ts`.
3. Upload `plugin.mjs`, set the network host and `X429_API_BASE`, run the hosted checks, test the
   tools, validate a join proposal, accept the terms and **Submit for review**.
