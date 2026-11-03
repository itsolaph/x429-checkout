# Changelog

## 0.2.0 (2026-11-03)

- New option `validate(params, { route })`: checks a request's params before anything is charged or
  answered, that is before the 402 skip offer and before a paid `/skip` settles, before `/use` builds
  an answer, and before a protected request with `X-429-Token` does. Throw a `CheckoutError` to refuse
  with its status, or any error for a 400 `invalid_request`. A refused paid skip is not settled.
  The `ValidateHook` type is exported. Without the option nothing changes.
- `x429 queue create` prints `X429_QUEUE_ID` as soon as the queue exists, skips `setJoinFee` when the
  join fee is 0 (the contract's default), and retries the `setJoinFee` simulation while a
  load-balanced public RPC has not seen the new queue yet (it reverted with `UnknownQueue`).

## 0.1.0 (2026-11-03)

First release: the engine of x429.lol as middleware.

- `x429(options)` returns a Lane for your own X429Checkout contract: the gate (`handle`), the routes
  (`/join`, `/skip`, `/use`, `/ticket`, `/quote`, `/queue`, `/earnings`, `/feed`, `/stats`, the
  descriptor and the legacy gasless join/claim) under a prefix (default `/x429`), the operator loop,
  automatic payouts and the event feed (`start()` / `stop()`), and events.
- Capacity models: a fixed service interval, and a concurrency limit.
- A `serve` hook to answer a served ticket inside its paid skip; without it the ticket's request
  goes through to the handler once.
- Adapters: `x429/hono`, `x429/express`, `x429/node`.
- Optional x402 Bazaar declaration on the 402 skip offer, and a fire-and-forget POST of verified v2
  payments to a facilitator's `/verify`.
- CLI: `x429 deploy` (bundled bytecode), `x429 queue create`, `x429 status`, `x429 init`.
- Protocol: x429 v0.3 (the same 429, 402, descriptor and paid responses as x429.lol).
