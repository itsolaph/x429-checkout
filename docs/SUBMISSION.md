# PayBox submission: x429 Checkout

> **429 is the new 402: agents pay to skip the line, and everyone they pass gets paid.**

## Project

**Name:** x429 Checkout

**Category:** Merchant tools

**Description (251 characters):**

> 429 is the new 402: agents pay to skip the line, and everyone they pass gets paid. A busy API's 429 quotes the price; one passkey approval pays USDC on Base, each passed agent gets its own price, and the paid response is the API answer plus a receipt.

**Bundle:** `plugin/dist/plugin.mjs`, built with `cd plugin && pnpm install --frozen-lockfile && pnpm test`
(Node 24.21.0, pnpm 11.11.0). Upload only that file: no source maps, no `.env`, no `node_modules`.
Bytes and SHA-256 of the tested build are in the build report; rebuild and retest after any source change.

## What the judge sees

1. **Position.** The agent calls the busy API (or `x429_status`, free): HTTP 429 with a small JSON
   offer: "You are #5 in line; skipping to the front costs $0.015, paid to the 4 agents you pass",
   the `/skip` URL and the `x429_skip` hint. The line is never empty: 3–5 labeled demo agents wait
   at fixed prices (0.002–0.006 USDC).
2. **Passkey.** `x429_skip {targetPosition: 1}` returns an x402 proposal (USDC on Base, at most the
   live ceiling). PayBox shows it; the user approves once.
3. **Jump.** PayBox pays and re-fetches `/skip`. The server settles (one Base transaction moves the
   USDC and the queue), serves the ticket at once, and answers in about 1.3 s on 2-second blocks.
4. **USDC lands + the answer.** The same paid response holds `result` (the API answer, a city
   forecast) and `receipt`: every passed ticket (short address, demo label, its own price), total
   paid to people waiting, operator fee, refund of the unused buffer, settlement tx + basescan link,
   wait saved, new position. The operator pushes each payout to its wallet right after; the
   dashboard shows them landing.

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

The console shows proposals as data and never pays; the token comes from a paid response made
through an agent.

| Tool | Input | Expected |
|---|---|---|
| `x429_status` | `{}` | free: line length, demo labels, posted prices, cost to reach each position, join fee, ETA |
| `x429_quote` | `{"targetPosition": 1}` | free: cost to the front, ceiling (cost + 20%), `quoteExpiresAt` |
| `x429_skip` | `{"targetPosition": 1, "city": "Lisbon"}` | x402 proposal: `POST https://<host>/skip` body `{"target":1,"city":"Lisbon"}`, `maxAmount` = live ceiling, expiry ≤ 4 min. **Validate transaction** sends the unpaid request and previews the 402 |
| `x429_join` | `{"skipPriceUsdc": "0.005"}` | x402 proposal: `POST https://<host>/join`, `maxAmount` = join fee (`1000` = 0.001 USDC) |
| `x429_use` | `{"token": "x429_…", "city": "Lisbon"}` | `waiting` with position and ETA, or `served` with the forecast |
| `x429_status` | `{"token": "x429_…"}` | the same line plus your ticket |
| `x429_earnings` | `{"address": "0x…"}` (a demo agent's address from `x429_status`) | earned, received, pending |

Validation of a proposal sends one unpaid POST, which only returns a 402: it creates nothing and
moves no money.

## Agent flow (what to tell the agent)

1. Busy API → 429 with the offer, or `x429_status` / `x429_quote` (both free).
2. Ask the user: "Pay up to $X to go first? The agents you pass get paid." → `x429_skip
   {targetPosition: 1, city}` → PayBox passkey.
3. The paid response is the answer (`result`) and the proof (`receipt`). Show both; nothing else
   to call. Only if the service slot was busy does it hold position, ETA and a token instead: then
   `x429_use {token}`.
4. Waiting instead: `x429_join` (0.001 USDC), later `x429_use {token}`; anyone who passes you pays
   you your posted price, sent to your wallet automatically.

## Demo video script (75 s, four beats)

| Time | Beat | Screen | Voice-over |
|---|---|---|---|
| 0–15 s | **Position** | Agent chat: "Get me today's Lisbon forecast." The API answers `429`: "You are #5 in line; skipping to the front costs $0.015, paid to the 4 agents you pass." Dashboard beside it: four labeled demo agents waiting at $0.002–$0.006. | "429 is the new 402. A busy API doesn't just say wait: it quotes a price to skip, and that price goes to the agents in line." |
| 15–35 s | **Passkey** | The agent says "Skipping costs $0.015 (at most $0.018, the rest is refunded). Approve?" and calls `x429_skip`; the PayBox window shows USDC on Base, max $0.018; the user approves with a passkey. | "One passkey approval. No ETH, no gas, no second signature: x402 is the only thing the user does." |
| 35–55 s | **Jump** | About a second later the agent shows the receipt: "#5 → #1, 4 agents paid $0.015, refunded $0.003, tx on basescan". Dashboard: "Skipped ~60s; 4 agents earned $0.015", the payout cards drop in one by one, the ticker counts up. | "The payment and the queue move in one transaction on Base. Every agent it passed got its own price, and the operator pushes the USDC straight to their wallets." |
| 55–75 s | **USDC lands + the answer** | The payout cards flip to "in wallet"; the agent reads the forecast from the same paid response: "Lisbon: 15 to 21 °C, take an umbrella after 15:00." Title card: x429 Checkout, 429 is the new 402. | "The answer came back with the receipt, in the same call. Agents pay to skip the line, and everyone they pass gets paid." |

Numbers in the script match four demo agents at 0.002/0.003/0.004/0.006 USDC, no operator fee (the deploy default) and a 15 s service interval;
`x429_quote` shows the live ones. The demo agents are the operator's own
(`agent-sim/demo-agents.ts`, addresses in `X429_DEMO_AGENTS`); the dashboard, `/queue`,
`x429_status` and the receipt label them as demo agents.

## Before the deadline (upload by Sun 18 Oct 2026, 00:00 UTC)

1. Host the server behind HTTPS (see REPORT Phase 3 "What is left").
2. Deploy the contract (`scripts/deploy-base.sh <env> --broadcast`), fund the operator with ETH and
   the demo wallets with a little USDC, start the server and the demo-agent service.
3. Upload `plugin.mjs`, set the network host and `X429_API_BASE`, run the hosted checks, test the
   tools, validate a skip proposal, accept the terms and **Submit for review**.
