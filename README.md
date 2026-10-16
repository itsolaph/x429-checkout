# x429 Checkout

**429 is the new 402: agents pay to skip the line, and everyone they pass gets paid.**

An overloaded API normally answers `429 Too Many Requests` and the caller waits. With x429
Checkout the 429 says: *you are #7 in line; skipping to the front costs $0.0309 right now, paid to
the 6 agents you pass.* An AI agent's user approves that price once with a passkey in PayBox, the
payment settles in USDC on Base, and **the paid response is the API answer plus a receipt**: every
agent that was passed got its own asking price (pushed to its wallet), the unused buffer came back,
and the request was served in the same call, in about 1.3 s on 2-second blocks.

Category: **Merchant tools**. For API operators: sell priority on scarce capacity, and compensate
everyone who waits instead of just bumping them.

- **PayBox plugin** (`plugin/`): six MCP tools over stdio, bundled into one `plugin.mjs` from the
  PayBox starter 1.0.2. The agent reads the queue, gets quotes, and receives x402 payment proposals
  that PayBox pays after a passkey approval.
- **x402 is the only user action.** Joining is a tiny paid call (0.001 USDC), skipping is a paid call
  at the live price. The payer's address (the EIP-3009 `from`) is its identity; the paid response
  carries a **redeem token** that proves ticket ownership later. Users never sign anything else and
  never need ETH.
- **Compensation is pushed automatically**: after each skip the operator sends every passed owner
  exactly its posted price (`payoutBatch`); nobody has to claim.
- **One paid call = answer + receipt.** A paid skip to #1 is served inside its own request when the
  service slot is free; a retried paid request (same EIP-3009 nonce) gets the identical response and
  is never charged twice.
- **The 429 carries the offer**: position, ETA, the live price to #1, the `/skip` URL and the
  `x429_skip` hint, in a small JSON body plus `Retry-After`, `X-429-*` and `Link` headers.
- **Never an empty line**: a demo-agent service keeps 3–5 labeled demo tickets waiting, within hard
  join and spend caps.
- Money and queue move in **one transaction**. A price ceiling survives the passkey delay; the unused
  part is refunded in that same transaction.

This is v0.3. v0.2 (gasless EIP-712 joins and claims, EIP-191 redeem, a remote MCP server) is still in
the contract and the server as a legacy path; the plugin does not depend on it.

## How it works

```
agent (PayBox + x429 plugin)     x429 server                              X429Checkout (Base)
  x429_status / x429_quote ───▶ GET /queue, POST /quote
  x429_join ──▶ x402 proposal {POST /join, max 0.001 USDC}
  PayBox: GET 402, passkey, EIP-3009 ─▶ POST /join + payment ── joinPaid ─▶ ticket for authorization.from
  ◀─────────────────────────── 200 {ticketId, position, token}            (fee to operator, rest refunded)
  x429_skip ──▶ x402 proposal {POST /skip {target: 1, city}, max = live ceiling}
  PayBox: GET 402, passkey, EIP-3009 ─▶ POST /skip + payment ── skip ────▶ pay each passed ticket its price
                                 #1 and the slot is free: serve(queue) ─▶ move payer, refund the rest
  ◀─────────────────────────── 200 {result: API answer, receipt, token}   (one block, ~1.3 s)
                                 payoutBatch(passed owners) ────────────▶ USDC to each passed owner
  (slot busy: 200 {position, ETA, token} → x429_use {token} → POST /use → the answer once served)
```

The protocol is in [docs/SPEC.md](docs/SPEC.md) (v0.3 changes in its first section), the submission
details (portal hosts, variables, test inputs, demo script) in [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Layout

| Path | What |
|---|---|
| `plugin/` | the PayBox plugin: starter 1.0.2 tooling unchanged, tools in `src/plugin.ts`, `pnpm test` = type-check + two identical builds + conformance |
| `contracts/` | Foundry project: `X429Checkout.sol`, unit/fuzz/invariant tests with a mock EIP-3009 USDC, fork tests against Base USDC, deploy script |
| `server/` | TypeScript (runs `.ts` directly): busy API, x402 `/join` and `/skip`, `/use`, `/quote`, `/ticket`, `/earnings`, payouts, operator serve loop, event feed, legacy MCP server |
| `agent-sim/` | test agents that sign with local test keys what a PayBox wallet signs, a PayBox x402 simulator, a stdio client for the plugin, the end-to-end scenario, and a demo-agent runner |
| `web/` | dashboard source (no framework); `npm run build:web` writes `site/` |
| `scripts/` | `e2e-local.sh`, `mcp-smoke.sh`, the shared fork setup, `deploy-base.sh`, `start-server.sh`, ABI export, dashboard render check |
| `deploy/` | systemd unit |
| `docs/` | `SPEC.md` (protocol), `SUBMISSION.md` (PayBox portal), `PAYBOX.md` (v0.2 agent flow, legacy) |

## Requirements

- [Foundry](https://getfoundry.sh) (`forge`, `anvil`, `cast`)
- Server and tests: Node.js 26 (runs TypeScript directly) and npm
- Plugin: Node.js 24.21.0 and pnpm 11.11.0 (the PayBox reference toolchain)
- Network access to a public Base RPC, only to *read* state for the local fork

```sh
git submodule update --init               # contracts/lib: forge-std, OpenZeppelin
npm ci
(cd plugin && pnpm install --frozen-lockfile)
```

## Tests

```sh
(cd plugin && pnpm test)                                      # plugin: type-check, 2 identical builds, conformance
forge test --root contracts                                   # unit + fuzz + invariant + Base fork tests
FOUNDRY_PROFILE=offline forge test --root contracts           # without the fork tests (no network)
npm run test:server                                           # x402 codec and quote math
npm run typecheck                                             # tsc over server, agent-sim, scripts, web
npm run e2e                                                   # full x402 flow + the plugin over stdio, on an anvil fork of Base
npm run mcp:smoke                                             # legacy remote MCP server on the fork
```

`npm run e2e` (needs `plugin/dist/plugin.mjs`; `E2E_PLUGIN_NODE=<node 24 binary>` to run the plugin
on Node 24) starts `anvil --fork-url <Base RPC> --fork-block-number 52621900`, deploys the contract
with a 3% skip fee and a 0.001 USDC join fee, mints forked USDC to test agents through a minter
configured by USDC's real masterMinter, starts the server, and runs `agent-sim/scenario.ts`:

1. six **demo rivals** join with a paid `POST /join` (each charged exactly the join fee);
2. a new agent drives the **plugin bundle over stdio** (a fresh process per call, like the PayBox
   sandbox): `x429_status`, `x429_quote`, `x429_join` → proposal → a PayBox simulator fetches the
   live 402, checks asset and amount against the proposal, pays, and gets the token; `x429_skip` →
   proposal at the live ceiling → paid → #1;
3. the rivals it passed are **paid automatically** (balances asserted to the unit, no claim, no ETH),
   and `x429_earnings` shows it;
4. the paid skip response already holds the API result and a receipt (checked field by field) and
   comes back in under 5 s (measured, see below); retrying the same payment returns the identical
   response; `x429_use` with the token returns the same answer;
5. the demo-agent service keeps at least 3 labeled demo tickets waiting while the line is served,
   and served demo agents rejoin.

The 429 body and headers are checked too. Anvil mines a block every 2 s (like Base) once setup is
done (`E2E_BLOCK_TIME=` for instant mining). It also checks an expired authorization, an expired quote, a price that moved
above the signed ceiling, front-run and cancelled authorizations and a double join, and at the end
that every agent's USDC equals start − join fees − skip costs + compensation. Fork RPC:
`E2E_RPC_URL` (default: the first of `mainnet.base.org`, `base.drpc.org`, `base-rpc.publicnode.com`
that answers).

### Latency (fork, 2 s blocks)

Time from receiving the paid request to sending the response, measured by the server
(`Server-Timing`) and the client, over the e2e's paid calls:

| Paid request | answer served in the request, serve confirmed in the background (default) | serve receipt awaited too (`X429_SERVE_CONFIRM=1`) |
|---|---|---|
| skip to #1 (settle + serve + answer) | 1.3 s, 1.9 s | 3.3 s, 3.8 s |
| skip to another position | 0.7–1.1 s | 0.3–1.0 s |
| paid join | 2.0–2.6 s | 2.0–2.5 s |

The payer's transfer is always included (1 confirmation) before anything is answered; only the
operator's own serve transaction may confirm after the answer.

## Demo agents

`agent-sim/demo-agents.ts` (`scripts/start-demo-agents.sh <env>`, `deploy/x429-demo-agents.service`)
keeps 3–5 demo tickets waiting at fixed posted prices, rejoining after a short delay when one is
served. Caps: `DEMO_MAX_JOINS_PER_HOUR`, `DEMO_MAX_USDC_PER_DAY`; a wallet below `DEMO_MIN_USDC`
stops (logged), and the service exits when all have. The server labels them (`X429_DEMO_AGENTS`)
and does not serve while only demo agents wait (`X429_HOLD_DEMO_ONLY=1`), so an idle demo costs
nothing; skippers pay the demo wallets, so they are mostly self-funding. Daily cost in REPORT.

## The plugin

| Tool | What it does |
|---|---|
| `x429_status {token?}` | free price discovery: queue length, demo labels, each position's posted skip price, cost to reach it, ETA, join fee; your ticket with a token. Without `X429_API_BASE` it answers "not configured" (the conformance sample call) |
| `x429_quote {targetPosition, token?\|owner?}` | free price discovery: cost to reach a position now, the ceiling (cost + 20%), expiry |
| `x429_join {skipPriceUsdc?}` | x402 proposal for `POST {BASE}/join`, `maxAmount` = join fee |
| `x429_skip {targetPosition, token?\|owner?, skipPriceUsdc?, city?}` | x402 proposal for `POST {BASE}/skip {target, owner?, city?}`, `maxAmount` = live ceiling, expiry = min(4 min, quote expiry); the paid response holds the API answer and a receipt |
| `x429_use {token, city?}` | the busy API with your token: position and ETA while waiting, the result once served |
| `x429_earnings {address}` | what an address earned for being passed and what reached its wallet |

Configuration: one portal variable, `X429_API_BASE` (the https origin of the server), and that host
in the network allowlist. No secrets. The token never goes into an x402 request body or URL.

```sh
cd plugin && pnpm install --frozen-lockfile && pnpm test     # → dist/plugin.mjs, upload only that file
```

## Look at the dashboard

```sh
E2E_KEEP=1 npm run e2e
```

When it passes, anvil and the server keep running and the script prints the dashboard URL
(`http://127.0.0.1:<port>/`). Open it in a browser on the same machine, or forward the port. It
shows the live paid-to-waiting ticker, the last skip ("skipped ~Ns; K agents earned $X") with each
payout landing, the live line (demo agents are labeled), the ledger (each row links to the explorer; on a fork
the transactions only exist locally) and who got paid what. Stop it with the printed `kill` command.

## Run it for real (not done by this repo)

```sh
bash scripts/deploy-base.sh /secure/deploy.env               # simulation against Base mainnet
bash scripts/deploy-base.sh /secure/deploy.env --broadcast   # sends; prints X429_CONTRACT, X429_QUEUE_ID, X429_DEPLOY_BLOCK
bash scripts/start-server.sh /etc/x429/server.env            # or the systemd unit in deploy/
bash scripts/start-demo-agents.sh /etc/x429/demo-agents.env  # or deploy/x429-demo-agents.service
```

The env files stay outside the repo (`chmod 600`); `.env.example` lists every variable. The
operator wallet needs ETH on Base for gas and nothing else. Gas measured on the fork (real USDC,
transaction receipts from `npm run e2e`; the 64-pass case from `forge test`):

| Operation | Gas |
|---|---|
| deploy + `createQueue` + `setJoinFee` | 4.26M |
| `joinPaid` | 229k (292k first ever) |
| `skip`, existing ticket, 3 passes | 327k |
| `skip`, 6 passes (owners already paid out) | 526k–572k |
| `skip`, join + 9 passes, front-run settle | 612k |
| `payoutBatch`, 3 / 6 / 9 owners | 83k / 128k / 172k |
| `serve` (1 ticket) | 59k |
| `skip`, join + 64 passes, all cold (worst case) | ~4.0M |

Automatic payouts zero each owner's claimable, so every later pass writes a fresh storage slot
(about 20k gas more per pass than with pull claims) plus about 15k per owner in the payout batch.

## HTTP API

| Method | Path | |
|---|---|---|
| GET | `/v1/forecast?city=` | the busy API: 429 with the offer when saturated; with `X-429-Token` it answers for your ticket |
| POST | `/join` `{skipPrice?}` | x402: 402 without payment; 200 `{ticketId, position, token}` after settlement |
| POST | `/skip` `{target, owner?, skipPrice?, city?}` (or query) | x402: 402 without payment; 200 `{status, result, receipt, position, token}` (`result` when served in the request) |
| POST | `/use` `{token, city?}` | 429 `{position, etaSeconds}` while waiting, 200 `{result}` once served, 410 when expired |
| POST | `/ticket` `{token}` | where your ticket stands, without using it |
| GET, POST | `/quote?target=&owner=` / `{target?, owner?, token?}` | quote with ceiling and expiry (all targets without `target`) |
| GET | `/earnings/{address}` | earned, received, pending |
| GET | `/queue[?owner=]`, `/x429` | positions, prices, a quote for every target; the descriptor |
| GET | `/feed`, `/stats` | dashboard data; gate, payout counters and gas per operation |
| POST, GET | `/join/signed`, `/join/typed-data`, `/claim`, `/claim/typed-data`, `/mcp`, `/paybox-plugin.json` | legacy v0.2 paths |

## Security notes

- The operator settles everything and pays gas. It cannot move a user's USDC beyond what the user
  signed, cannot pay a passed ticket less than its posted price, and `payout` can only send an
  owner's own claimable to that owner. It can create queues, serve, set a skip fee up to 10% and a
  join fee up to 1 USDC, and withdraw its own fees.
- One contract serves one operator, fixed at deploy. The EIP-3009 signature binds the payment to the
  contract but not to a queue, a target or a join, so only that operator may settle payments;
  otherwise anyone who saw a payment header could spend it on a queue of their own (SPEC §10).
- Redeem tokens are 256-bit random, returned once in the paid response, stored only as SHA-256. They
  are bearer tokens: whoever holds one can use that ticket's request. They never appear in x402
  bodies or URLs (PayBox forbids secrets there; the skip body carries the public payer address).
- Not audited.

## Known limits

- The operator is trusted to apply the target position the payer asked for over HTTP (the payment
  signature cannot carry it, because PayBox chooses the EIP-3009 nonce).
- A newcomer's skip price can rise between the plugin's quote and PayBox's live 402 if someone joins
  in between; PayBox then refuses (amount above the proposal) and the agent asks for a fresh proposal.
- Admissions (served, not yet used tickets) live in server memory; a restart drops them. Tokens and
  payment records persist in `X429_DATA_DIR`.
- x402 payers must sign as EOAs (EIP-7702-delegated EOAs work); settlement uses `v,r,s`.

## Credits

- [PayBox](https://developer.paybox.sh) plugin starter release 1.0.2 (MoonPay): `plugin/src/paybox.ts`,
  `plugin/scripts/*`, `plugin/tsconfig.json`, `plugin/pnpm-lock.yaml`, `plugin/pnpm-workspace.yaml`,
  `plugin/starter-version.json`, `plugin/.gitignore` and the base of `plugin/package.json` are copied
  verbatim (checksums match the release `manifest.json`, kept in `plugin/`). The starter files carry
  no license header or license file; the developer guide says to copy them into your plugin, and
  submissions fall under the MoonPay Hackathon Terms & Conditions accepted in the portal.
- [x402](https://github.com/coinbase/x402) protocol specification (v1, v2, `exact` EVM scheme), Coinbase, Apache-2.0. Implemented here from the spec; no x402 library code is used.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and USDC's [FiatToken](https://github.com/circlefin/stablecoin-evm) (Circle, Apache-2.0): the mock in `contracts/test/mocks/` follows its behaviour.
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.4.0, MIT: ECDSA, EIP712, SignatureChecker, SafeERC20, ReentrancyGuard.
- [forge-std](https://github.com/foundry-rs/forge-std), MIT or Apache-2.0.
- [viem](https://github.com/wevm/viem), MIT.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT (server SDK 2.0.0 in the plugin, SDK 1.32.1 in the legacy server); [zod](https://github.com/colinhacks/zod), MIT.
- Weather data: [Open-Meteo](https://open-meteo.com), free API, data CC BY 4.0 (cached server-side; demo fallback when unavailable).
- [esbuild](https://github.com/evanw/esbuild), MIT; [linkedom](https://github.com/WebReflection/linkedom), ISC (dashboard render check).

## License

MIT for this project's own code, see [LICENSE](LICENSE). The PayBox starter files keep their
original terms (see Credits).
