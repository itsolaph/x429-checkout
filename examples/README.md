# x429 examples

Two copies of the same small API, `GET /forecast?city=`, behind an x429 lane: one with Express
(`express-basic/`), one with Hono on Node (`hono-basic/`). The API admits one request every 15 s.
A caller over capacity gets a 429 that prices a skip to the front; the x429 routes (`/x429/join`,
`/x429/skip`, `/x429/use`, ...) are mounted next to it.

Everything below runs on a local anvil fork of Base. The fork reads mainnet state (USDC's real
contract) and sends nothing to Base.

## Run one

From the repository root (Node.js 20 or newer, [Foundry](https://getfoundry.sh) for `anvil`):

```sh
npm ci && npm run build:x429

# 1. A local fork of Base, in its own terminal
anvil --fork-url https://mainnet.base.org --fork-block-number 52621900 --port 8545

# 2. An operator key for the fork: anvil's first test account. It is public: use it on a local fork only.
printf '%s\n' 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 > /tmp/x429-operator.key
chmod 600 /tmp/x429-operator.key

# 3. Deploy your own X429Checkout and open a queue. The fork has Base's chain id (8453), so the CLI
#    asks for --yes as it would on mainnet. Note X429_CONTRACT and X429_QUEUE_ID from the output.
npx x429 deploy --rpc http://127.0.0.1:8545 --key-file /tmp/x429-operator.key --yes
npx x429 queue create --rpc http://127.0.0.1:8545 --key-file /tmp/x429-operator.key \
  --contract <X429_CONTRACT> --fee-bps 300 --join-fee 0.001 --meta '{"name":"forecast example"}' --yes
npx x429 status --rpc http://127.0.0.1:8545 --contract <X429_CONTRACT>

# 4. Start the example (or hono-basic)
cd examples/express-basic
X429_RPC_URL=http://127.0.0.1:8545 X429_CONTRACT=<X429_CONTRACT> X429_QUEUE_ID=1 \
X429_OPERATOR_KEY_FILE=/tmp/x429-operator.key npm start
```

Then, in another terminal:

```sh
curl -s 'http://127.0.0.1:3000/forecast?city=Paris'       # 200: the API was idle
curl -si 'http://127.0.0.1:3000/forecast?city=Paris'      # 429 with the x429 offer and Retry-After
curl -s http://127.0.0.1:3000/x429                        # the descriptor: contract, queue, prices, routes
curl -si -X POST http://127.0.0.1:3000/x429/join          # 402: what a paid join costs (x402)
```

The skip offer appears in the 429 (and `POST /x429/skip` answers 402 with its price) once someone
waits in line. Joining and skipping are x402 payments in USDC; an x402 client (for example PayBox, or
the signer in `packages/x429/test/helpers.ts`) pays them. Funding a test wallet with forked USDC
takes the impersonation steps in `examples/smoke.test.ts` or `scripts/lib/fork-stack.sh`.

Settings (env): `X429_RPC_URL`, `X429_CONTRACT`, `X429_QUEUE_ID` (1), `X429_OPERATOR_KEY_FILE`,
`X429_CHAIN_ID` (8453), `X429_PUBLIC_URL` (`http://127.0.0.1:<port>`), `X429_PER_INTERVAL_MS`
(15000), `X429_DEPLOY_BLOCK` (0), `PORT` (3000).

## Smoke test

```sh
npm run build:x429 && npm run test:examples
```

It starts an anvil fork (`E2E_RPC_URL`, else the first of mainnet.base.org, base.drpc.org,
base-rpc.publicnode.com that answers; `E2E_FORK_BLOCK`, default 52621900), deploys with the CLI,
funds two payers with forked USDC, and for each example: an idle request is admitted, the next one
gets 429 with the descriptor URL and no skip offer, a paid join puts someone in line, and then the
429 prices a skip to #1 (body and `X-429-*` headers), `GET /x429` describes the queue, and
`POST /x429/skip` answers 402 with the v1 `accepts` and the v2 `PAYMENT-REQUIRED` header.

## Outside this repository

Copy `server.mjs` and install the published package and your framework:

```sh
npm install x429 express                     # or: npm install x429 hono @hono/node-server
```
