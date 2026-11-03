# x429

x429 is middleware that turns your API's `429 Too Many Requests` into a paid priority lane: a caller
over capacity gets a 429 that says where it is in line and what skipping to the front costs right
now, and every caller it passes is paid its own asking price in USDC. Payments are
[x402](https://x402.org) (`exact`, EIP-3009 USDC) and settle in your own X429Checkout contract, which
you deploy with this package's CLI.

It is the engine of [x429.lol](https://x429.lol), extracted for any API owner.

## Install

```sh
npm install x429            # Node.js 20 or newer; depends only on viem
npm install hono            # or express, for the adapters
```

## Quick start

```ts
import { x429 } from "x429";
import { x429Hono } from "x429/hono";      // also "x429/express", "x429/node"
const lane = await x429({ contract, queueId, rpcUrl, operatorKey, publicUrl, capacity: { perIntervalMs: 15000 } });
app.use("/x429/*", x429Hono(lane));        // join, skip, use, ticket, quote, queue, feed
app.use("/forecast/*", x429Hono(lane));    // 429 + skip offer when over capacity
```

`x429()` checks the chain, the queue and that the key is the contract's operator, then starts the
operator loop (it serves the head of the line), automatic payouts and the event feed. Requests that
are admitted reach your handler; the lane's decision is in `c.get("x429")` (Hono) or `req.x429`
(Express), with `admission` set when a ticket from the line is being served.

Runnable versions: [`examples/`](https://github.com/itsolaph/x429-checkout/tree/main/examples)
(Express and Hono, with the exact commands for a local anvil fork of Base).

## Deploy your contract

`createQueue` is operator-only, and one contract has one operator fixed at deploy, so each API owner
deploys their own X429Checkout. The creation bytecode ships in the package; you do not need Foundry.

```sh
npx x429 init                                   # writes .env.x429 (no secrets)
npx x429 deploy --rpc <url> --key-file <path> --dry-run
npx x429 deploy --rpc <url> --key-file <path> --yes          # prints X429_CONTRACT, X429_DEPLOY_BLOCK
npx x429 queue create --rpc <url> --key-file <path> --contract <address> \
  --max-length 64 --fee-bps 300 --join-fee 0.001 --meta '{"name":"my api"}' --yes   # prints X429_QUEUE_ID
npx x429 status --rpc <url> --contract <address> [--queue 1] [--json]
```

- The key's address becomes the operator. It needs ETH for gas on the chain and never holds users'
  USDC. Pass it with `--key-file` (a file holding the 32-byte hex key, `chmod 600`) or the env
  `X429_OPERATOR_KEY`; `--key` is refused, and the key is never printed.
- `--usdc` defaults to native USDC on Base (8453); other chains need it. The token must implement
  EIP-3009 with USDC's EIP-712 domain (name `USD Coin`, version `2`), which the lane signs and checks
  payments against; `deploy` refuses a token with another domain.
- On a mainnet chain id (Base, Ethereum, Optimism, Arbitrum, Polygon) the CLI sends nothing without
  `--yes`. `--dry-run` simulates (gas estimate, the address it would create) and sends nothing.
- The bytecode is solc 0.8.30, optimizer 200 runs, evm cancun, from `contracts/src/X429Checkout.sol`.

## Options

| Option | Default | |
|---|---|---|
| `contract` | required | your X429Checkout address |
| `rpcUrl` | required | JSON-RPC URL (only its host is ever logged) |
| `publicUrl` | required | your API's public origin, no path; x402 resource URLs and the descriptor use it |
| `capacity` | required | `{ perIntervalMs, admissionRoundMs? }` or `{ concurrency, estimateMs?, admissionRoundMs? }` |
| `queueId` | `1` | |
| `operatorKey` / `operatorKeyFile` | none | without one the lane is read-only: 429s, quotes and 402 offers, no settlement |
| `chainId` | `8453` | checked against the RPC at startup |
| `usdc` | Base USDC | an EIP-3009 token with USDC's EIP-712 domain (`USD Coin`, `2`) |
| `prefix` | `"/x429"` | where the routes are; `""` mounts them at the root |
| `serve` | none | `(admission, params) => answer`: lets x429 answer a served ticket itself (see below) |
| `validate` | none | `(params, { route }) => void`: refuses bad params before a paid skip settles or an answer is built (see below) |
| `suggestedSkipPrice` | `"0.005"` | USDC; the skip price of a new ticket that posts none |
| `maxSkipPrice` | `"0.1"` | USDC; the highest skip price a ticket may post |
| `slippageBps` | `2000` | the 402 asks for the quoted cost + 20%; the unused part is refunded in the same transaction |
| `quoteTtlS` / `paymentTimeoutS` | `600` / `120` | how long a quote's ceiling holds; x402 `maxTimeoutSeconds` |
| `admissionTtlMs` | `300000` | how long a served ticket may take to use its request |
| `autoPayout` / `payoutIntervalMs` | `true` / `3000` | push compensation to passed agents (`payoutBatch`) |
| `serveConfirm` | `true` | a paid skip to #1 waits for its serve receipt before answering |
| `dataDir` | none | keeps hashed redeem tokens, admissions, paid responses and feed progress across restarts |
| `deployBlock` | `0` | first block the event feed indexes (0: the last 5,000 blocks) |
| `logsRpcUrls` | `[rpcUrl]` | RPCs for `eth_getLogs`, rotated with backoff on errors |
| `explorer` | `https://basescan.org` | transaction links in receipts |
| `pollMs` | `1000` | how often the queue is read |
| `bazaar` | off | x402 Bazaar discovery, see below |
| `demoAgents` / `holdDemoOnly` | `[]` / `true` | your own filler agents: labeled `demo`, not served while only they wait |
| `legacyJoin` / `joinsPerMinute` | `false` / `30` | the v0.2 gasless join relay (the operator pays its gas) |
| `descriptorExtras` | `{}` | fields appended to the descriptor |
| `logger` | none | receives every log entry |
| `autoStart` | `true` | start the operator loop, payouts and feed in `x429()`; else call `lane.start()` |

Unknown options and bad values fail with an `OptionsError` that names the option. The operator key
is kept out of the lane's configuration and never appears in an error, a log entry or an event.

## Adapters

Each adapter only converts requests and responses; the core builds every status, header and byte,
so all three answer the same.

- **Hono** (`x429/hono`): `app.use("/x429/*", x429Hono(lane))` for the routes (it also matches the
  bare `/x429`, the descriptor) and on each protected path. The decision is `c.get("x429")`.
- **Express** (`x429/express`): `app.use("/x429", x429Express(lane))` and
  `app.use("/forecast", x429Express(lane))` or per route. The decision is `req.x429`. Works with or
  without `express.json()` before it. Express 4 and 5.
- **node:http** (`x429/node`): `http.createServer(x429Node(lane, handler, { protect }))`. Routes under
  the prefix are answered, `protect(req)` picks the gated requests (default all), `handler(req, res,
  decision)` gets the rest. `toLaneRequest` and `send` are exported for custom routers.

Anything else can call the core directly: `lane.routes.handle(req)` answers a lane route (or returns
undefined), and `lane.handle(req)` decides a protected request, with
`req = { method, url, headers, ip?, body?: () => Promise<unknown> }`. A decision is either
`{ action: "respond", status, headers, body }` or `{ action: "next", via, admission?, done }`; call
`done()` when your response has finished (the concurrency model counts it).

### Routes

Relative to the prefix (`/x429` by default):

| Method | Path | |
|---|---|---|
| GET | `` (the prefix itself; `/x429` when the prefix is `""`) | the descriptor: contract, queue, prices, every route |
| POST | `/join` `{skipPrice?}` | x402: 402 with the join fee; paid: a ticket and its redeem token |
| POST, GET | `/skip` `{target, owner?, skipPrice?, ...}` | x402: 402 at the live price; paid: the receipt, and the answer when served at once |
| POST | `/use` `{token, ...}` | your position while waiting (429), the answer once served |
| POST | `/ticket` `{token}` | where your ticket stands |
| GET, POST | `/quote` | price to each position, with the ceiling and expiry |
| GET | `/queue`, `/queue/{id}` | the line, prices and the descriptor (the status) |
| GET | `/earnings/{address}` | what an address earned and received |
| GET | `/feed`, `/stats` | indexed events and totals; gate, payout and gas counters |
| GET, POST | `/join/typed-data`, `/join/signed`, `/claim/typed-data`, `/claim` | the v0.2 gasless join and claim |

The [PayBox plugin](https://github.com/itsolaph/x429-checkout/tree/main/plugin) calls `/join`,
`/skip`, `/use`, `/ticket`, `/quote`, `/queue` and `/earnings` at the origin, so use `prefix: ""`
to serve it.

### Events

`lane.on(name, listener)`: `rejected` (a 429 was built), `admitted`, `joined`, `skipped`, `served`,
`paid_out`, `payout_error`, `serve_error`, `bazaar_verify`, `bazaar_verify_error`,
`internal_error`, and `log` for every entry. Each event carries the log entry (`{ evt, ... }`).

## Capacity models

- **Interval** `{ perIntervalMs }`: one request per interval. A request without a ticket goes
  through only when nobody waits and the interval is over; otherwise 429. The operator serves the
  head of the line once per interval. This is what x429.lol runs.
- **Concurrency** `{ concurrency: N, estimateMs? }`: requests go through while fewer than N are in
  flight (from admission until your response finishes). When the line is not empty, the operator
  serves as many heads as there are free slots in one transaction; a served ticket holds its slot
  until it uses its request or its admission expires. ETAs use an estimate of request time,
  starting at `estimateMs` (1000) and following observed latency.

`admissionRoundMs` (interval model: the interval; concurrency: 0) is how long a new head waits before
it is served, so it can still be outbid. A ticket that paid its way to #1 skips the round.

## The serve hook

With `serve: (admission, params) => answer`, x429 answers a served ticket itself: a paid skip that
reaches #1 while there is room returns the answer in the same response as its receipt (one paid
call), `POST /use` returns it, and so does a protected request carrying `X-429-Token`. The answer is
built once, outside the transaction lock, and kept for the admission window: asking again returns
the same answer. `params` are the request's other fields (the body and query of `/skip`, the body of
`/use`, the query of the protected request).

Without the hook, a served ticket's request goes through to your handler once, with `X-429-Token`
(`decision.via === "token"`); a second use gets 410.

With `validate: (params, { route }) => void`, the lane checks the same `params` first: before the
402 skip offer and before a paid `/skip` settles (`route: "skip"`), before `/use` builds an answer
(`"use"`), and before a protected request with `X-429-Token` does (`"token"`). Throw to refuse: a
`CheckoutError(status, reason, message)` is answered with that status, any other error with 400
`invalid_request` and its message. A paid skip whose params are refused is not settled, so the payer
is not charged for a request your API would not answer; a refused `/use` leaves the ticket usable.

## How pricing and payouts work

- Each ticket posts a skip price when it joins: what anyone who passes it must pay it.
- Moving from position *p* to *t* passes the tickets at *t* … *p*-1 and costs the sum of their
  posted prices plus the queue's fee (`--fee-bps`, at most 10%) for the operator. The 429 and the
  402 quote it live; the payer authorizes cost + slippage, and the contract refunds the unused part
  in the same transaction. If the price moved above the authorized amount, nothing is charged.
- Joining is a small x402 payment too (the queue's join fee, at most 1 USDC, to the operator), so
  the payer's address is its identity and the paid response carries its redeem token.
- After each skip the operator sends every passed owner exactly its price (`payoutBatch`); nobody
  claims, signs or holds ETH. Owners whose transfer USDC refuses keep a claimable balance.
- The operator pays gas for every settlement, serve and payout, and withdraws its fees from the
  contract.

## x402 Bazaar

```ts
bazaar: { facilitatorUrl: "https://facilitator.example", serviceName: "Forecasts", tags: ["weather"],
          iconUrl: "https://api.example.com/icon.png", input: { example: { target: 1 } }, output: { example: {...} } }
```

The v2 `PAYMENT-REQUIRED` object of the 402 skip offer then carries `extensions.bazaar` (an HTTP
POST JSON-body declaration in the shape `declareDiscoveryExtension` of `@x402/extensions` builds) and
`serviceName`, `tags` and `iconUrl` in `resource`. After a v2 payment passes the local checks, the
lane POSTs `{ x402Version, paymentPayload, paymentRequirements }` to `${facilitatorUrl}/verify`,
adding the declaration if the client did not echo it. That request is never awaited: a slow,
failing or unreachable facilitator only produces a `bazaar_verify_error` log entry. `/verify` moves
no funds; your contract settles. Off by default.

## Security notes

- The operator key settles payments, serves the line and pays gas. Keep it in a file outside your
  repository (`chmod 600`). It cannot move a user's USDC beyond what the user signed, cannot pay a
  passed ticket less than its posted price, and `payout` only sends an owner's own balance to that
  owner.
- One contract serves one operator, fixed at deploy. The EIP-3009 signature binds a payment to the
  contract but not to a queue, target or join, so only that operator settles payments.
- Redeem tokens are 256-bit random, returned once in the paid response and stored only as SHA-256
  (in `dataDir`, mode 600). They are bearer tokens for one ticket's request.
- A retried paid request (same EIP-3009 nonce) gets the identical response and is never charged
  twice; a retry from another client address gets the receipt without the token or the answer.
- With `bazaar`, the signed authorization is sent to the facilitator. It can only pay your contract;
  if someone submits it straight to USDC first, the lane detects that and applies or refunds it.
  Configure only a facilitator you trust.
- Behind a proxy, have the proxy overwrite `X-Forwarded-For`: it is the client address used for
  replays of paid responses and the legacy relay's rate limit.
- The contract is not audited.

## Limits

- x402 `exact` with EIP-3009 USDC only; payers sign as EOAs (EIP-7702-delegated EOAs work).
- One lane process per contract and operator key: the lane sends the operator's transactions one at
  a time, and two processes would race for nonces. The concurrency model counts requests in that one
  process.
- The operator is trusted to apply the target position the payer asked for over HTTP (the payment
  signature cannot carry it).
- A newcomer's price can rise between a quote and the payment if someone joins in between; the
  payment then fails with `price_moved` and nothing is charged.
- At most 256 tickets in a queue and 64 passed in one skip.
- Without `dataDir`, tokens, admissions and paid responses live in memory and a restart drops them.
- Bazaar forwarding applies to v2 payments only; whether a resource is listed is up to the
  facilitator.

## Credits and licences

- MIT, see [LICENSE](LICENSE).
- [viem](https://github.com/wevm/viem), MIT (the only dependency).
- The bundled contract bytecode is compiled from X429Checkout and includes
  [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) 5.4.0 (MIT; its
  notice is in LICENSE).
- [x402](https://github.com/coinbase/x402) (Coinbase, Apache-2.0): the v1/v2 protocol and the
  `exact` EVM scheme are implemented from the specification; the Bazaar declaration follows
  `@x402/extensions` 2.29 and the `/verify` request `@x402/core` 2.29. No x402 code is included.
- Adapters for [Hono](https://hono.dev) and [Express](https://expressjs.com) (both MIT), optional peer
  dependencies, not bundled.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and USDC's FiatToken (Circle) behaviour.
