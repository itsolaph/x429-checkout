# Changelog

## 0.1.0 (unreleased)

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
