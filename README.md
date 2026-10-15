# x429 Checkout

HTTP 429 with a price.

An overloaded API normally answers `429 Too Many Requests` and the caller waits. With x429
Checkout the 429 says: *you are #7 in line; skipping to the front costs $0.0309 right now, paid to
the 6 agents you pass.* An AI agent's user approves that price once with a passkey in PayBox, the
payment settles in USDC on Base, every agent that was passed gets paid its own asking price, and the
paying agent is served next.

It is a tool for API operators: sell priority on scarce capacity, and compensate everyone who waits
instead of just bumping them.

- Payments are standard **x402** (`exact` scheme, EIP-3009 USDC on Base), v1 and v2. PayBox agents
  pay with `use_service` or `pay_x402`.
- Joining the line and claiming compensation are **gasless** EIP-712 signatures. Users never need ETH.
- The same actions are exposed as an **MCP server** (`/mcp`), so an agent can drive everything with tools.
- Money and queue move in **one transaction**. A price ceiling survives the passkey delay; the unused
  part is refunded in that same transaction.

This is v0.2, a rebuild of the x429 prototype (native USDC on Arc) for Base, x402 and PayBox.

## How it works

```
agent                        busy API + x429 server                    X429Checkout (Base)
  │ GET /v1/forecast  ───────────▶ 429 + descriptor (#7, $0.0309 to #1)
  │ POST /skip?target=1 ─────────▶ 402: x402 accepts (max $0.03708, payTo = contract)
  │ PayBox: passkey approval, EIP-3009 signature
  │ POST /skip + X-PAYMENT ──────▶ verify ─── skip(queue, 1, auth) ──▶ transferWithAuthorization → contract
  │                                                                   pay each passed ticket its price
  │                                                                   move payer to #1, refund the rest
  │ ◀──────────────────────────── 200 {position: 1, paid, refund, tx}
  │                               serve(queue) when the head's round is over
  │ GET /v1/forecast + X-429-Ticket/Signature ──▶ 200 (one request)
rivals: POST /claim (signed) ───▶ claimWithSig ──────────────────────▶ USDC to each rival
```

The full protocol is in [docs/SPEC.md](docs/SPEC.md). The agent flow with exact PayBox tool calls
is in [docs/PAYBOX.md](docs/PAYBOX.md).

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry project: `X429Checkout.sol`, unit/fuzz/invariant tests with a mock EIP-3009 USDC, fork tests against Base USDC, deploy script |
| `server/` | TypeScript (Node 26, runs `.ts` directly): busy API, x402 `/skip`, gasless `/join` and `/claim`, `/queue`, operator serve loop, event feed, MCP server |
| `agent-sim/` | PayBox-style test agents that sign with local test keys exactly what PayBox would sign, and the end-to-end scenario |
| `web/` | dashboard source (no framework); `npm run build:web` writes `site/` |
| `scripts/` | `e2e-local.sh`, `mcp-smoke.sh`, the shared fork setup, ABI export, dashboard render check |
| `docs/` | `SPEC.md` (protocol v0.2), `PAYBOX.md` (agent flow) |

## Requirements

- [Foundry](https://getfoundry.sh) (`forge`, `anvil`, `cast`)
- Node.js 26 (TypeScript type stripping) and npm
- Network access to a public Base RPC, only to *read* state for the local fork

```sh
git submodule update --init               # contracts/lib: forge-std, OpenZeppelin
npm ci
```

## Tests

```sh
forge test --root contracts                                   # unit + fuzz + invariant + Base fork tests
FOUNDRY_PROFILE=offline forge test --root contracts           # without the fork tests (no network)
npm run test:server                                           # x402 codec and quote math
npm run typecheck                                             # tsc over server, agent-sim, scripts, web
npm run e2e                                                   # full flow on an anvil fork of Base
npm run mcp:smoke                                             # MCP client against /mcp on the fork
```

`npm run e2e` starts `anvil --fork-url <Base RPC> --fork-block-number 52621900`, deploys the
contract with a 3% fee, mints forked USDC to test agents through a minter configured by USDC's real
masterMinter, starts the server, and runs `agent-sim/scenario.ts`: six rivals join gaslessly, a new
agent gets a 429, then a 402, signs EIP-3009, pays, moves to #1, is served next and redeems; the
rivals claim. It also checks a replayed payment, an expired authorization, an expired quote, a price
that moved above the signed ceiling, a front-run authorization and a claim replay, and asserts every
balance to the unit. Fork RPC: `E2E_RPC_URL` (default: the first of `mainnet.base.org`,
`base.drpc.org`, `base-rpc.publicnode.com` that answers).

## Look at the dashboard

```sh
E2E_KEEP=1 npm run e2e
```

When it passes, anvil and the server keep running and the script prints the dashboard URL
(`http://127.0.0.1:<port>/`). Open it in a browser on the same machine, or forward the port
(`ssh -L <port>:127.0.0.1:<port> <host>`). It shows the live line, the ledger (each row links to the
explorer; on a fork the links point at basescan but the transactions only exist locally) and who
got paid what. Stop it with the `kill` command the script prints.

The dashboard reads the server's `/feed`, which indexes the contract's events. To point a built
`site/` at another server: `index.html?api=https://api.example.com`.

## Run the server against your own deployment

```sh
cp .env.example .env.local        # fill in RPC, contract, queue id, operator key file
set -a; . ./.env.local; set +a
npm run build:web && npm run server
```

Deploy (not done by this repo; read before running against mainnet):

```sh
DEPLOYER_PRIVATE_KEY=… OPERATOR_PRIVATE_KEY=… QUEUE_FEE_BPS=0 QUEUE_MAX_LENGTH=64 \
  forge script contracts/script/Deploy.s.sol:Deploy --root contracts --rpc-url <base rpc> --broadcast
```

The operator wallet needs ETH on Base for gas and nothing else. Gas measured on the fork (real
USDC, from transaction receipts in `npm run e2e`; the 64-pass case from `forge test`):

| Operation | Gas |
|---|---|
| `joinWithSig` | 148k–160k |
| `skip`, existing ticket, 3 passes | 258k |
| `skip`, join + 1 pass | 313k |
| `skip`, join + 6 passes (owners already had a claimable balance) | 406k |
| `skip`, join + 6 passes (first credit for every owner) | 692k |
| `skip`, join + 64 passes, all cold (worst case) | ~4.0M |
| `serve` (1 ticket) | 59k |
| `claimWithSig` | 92k–109k |

Each pass adds roughly 20k gas when the passed owner already has a claimable balance, and up to
about 60k when everything it touches is cold and it is the owner's first credit.

## HTTP API

| Method | Path | |
|---|---|---|
| GET | `/v1/forecast?city=` | the busy API (429 + descriptor when saturated; redeem with `X-429-Ticket` / `X-429-Signature`) |
| GET | `/x429` | the descriptor |
| GET | `/queue/{id}[?owner=]` | positions, prices, a quote for every target position |
| POST | `/skip?queue=&target=[&skipPrice=][&owner=]` | x402: 402 without payment, 200 after settlement |
| GET, POST | `/join/typed-data`, `/join` | gasless join |
| GET, POST | `/claim/typed-data`, `/claim` | gasless claim |
| GET | `/feed`, `/stats` | dashboard data, gate counters and gas per operation |
| POST | `/mcp` | MCP (streamable HTTP, stateless) |
| GET | `/paybox-plugin.json` | the MCP tools in PayBox `PluginSummary` shape |

## Security notes

- The operator relays everything and pays gas. It cannot move a user's USDC beyond what the user
  signed, cannot pay a passed ticket less than its posted price, and has no admin function over user
  funds: it can create queues, serve, set a fee up to 10% and withdraw its own fees.
- One contract serves one operator, fixed at deploy. The EIP-3009 signature binds the payment to the
  contract but not to a queue or target position, so only that operator may create queues, relay
  joins and settle skips; otherwise anyone who saw a payment header could spend it on a queue of
  their own. See SPEC §10 for this and the front-run trust model.
- Joins are free for users and cost the operator gas, so they only go through the operator, which
  rate-limits them per client.
- Not audited. An internal review found and fixed two fund-safety issues before this version (see
  the commit history).

## Known limits

- The operator is trusted to apply the target position the payer asked for over HTTP (the payment
  signature cannot carry it, because PayBox chooses the EIP-3009 nonce).
- Spam joins from many IPs with throwaway keys can still fill a queue to `maxLength`. A refundable
  join bond would fix that.
- Admissions (served, not yet redeemed tickets) live in server memory; a restart drops them.
- Smart-contract wallets can join and claim (ERC-1271), but x402 payment uses the `v,r,s`
  `transferWithAuthorization`, so payers must sign as EOAs (EIP-7702-delegated EOAs work).

## Credits

- [x402](https://github.com/coinbase/x402) protocol specification (v1, v2, `exact` EVM scheme), Coinbase, Apache-2.0. Implemented here from the spec; no x402 library code is used.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and USDC's [FiatToken](https://github.com/circlefin/stablecoin-evm) (Circle, Apache-2.0): the mock in `contracts/test/mocks/` follows its behaviour.
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.4.0, MIT: ECDSA, EIP712, SignatureChecker, SafeERC20, ReentrancyGuard.
- [forge-std](https://github.com/foundry-rs/forge-std), MIT or Apache-2.0.
- [viem](https://github.com/wevm/viem), MIT.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT; [zod](https://github.com/colinhacks/zod), MIT.
- [esbuild](https://github.com/evanw/esbuild), MIT; [linkedom](https://github.com/WebReflection/linkedom), ISC (dashboard render check).
- PayBox (MoonPay) agent tools: names and shapes from the public `@paybox-sh/sdk` types.

## License

MIT, see [LICENSE](LICENSE).
