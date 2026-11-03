# render.x429.lol

Send a URL, get the page back after a real Chromium has run its JavaScript: clean markdown (default)
or a PNG. The box renders two pages at a time. When both are busy, callers get the
[x429](../../packages/x429) `429` with its skip offer: wait in line for free with a ticket, or pay a
cent or two in USDC on Base ([x402](https://x402.org)) to go first, and every agent passed is paid
its own asking price. No API keys, no accounts.

This app uses only the `x429` package's public API: `x429()` with `capacity: { concurrency: 2 }`,
`lane.routes.handle()` and `lane.handle()` from the core, `toLaneRequest`/`send`/`onFinished` from
`x429/node`, and the `serve` and `validate` hooks.

## API

```
GET /v1/render?url=<http(s) URL>&format=markdown|png&wait=<0..5000 ms, default 800>&full=0|1
```

- `format=markdown` (default) answers JSON:
  `{ format, url, finalUrl, title, status, markdown, bytes, truncated, renderedMs }`. `status` is the
  page's own HTTP status; `bytes` is the size of `markdown` in UTF-8.
- `format=png` answers `image/png`, 1280×800, or the full page up to 1280×8000 with `full=1`
  (headers `X-Render-Final-Url`, `X-Render-Ms`, `X-Render-Status`).
- `wait` is extra time after the `load` event, for pages that keep drawing.
- Errors are JSON `{ error, message }`: `400 invalid_request`, `403 blocked_target`,
  `403 robots_disallowed`, `413 too_large`, `415 unsupported_content_type`, `429 rate_limited`
  (the free bucket), `429 too_many_requests` (x429: both slots busy), `502 navigation_failed` or
  `fetch_failed`, `504 render_timeout`, `508 too_many_redirects`.

Other routes: `GET /` (the landing page), `GET /healthz` (`{ ok, browser, slots: { total, busy,
waiting }, operator }`), `GET /robots.txt`, and the x429 lane under `/x429`: the descriptor
(`GET /x429`), `POST /x429/join`, `POST /x429/skip`, `POST /x429/use`, `POST /x429/ticket`,
`/x429/quote`, `/x429/queue`, `/x429/earnings/{address}`, `/x429/feed`, `/x429/stats`.

### When both slots are busy

```
GET  /v1/render?url=…                        429  #2 in line, skip to #1 for $0.0103 (X-429-Skip-Cost: 10300)
POST /x429/skip {"target":1,"url":"…"}       402  x402 payment requirements (USDC on Base)
POST /x429/skip + X-PAYMENT or PAYMENT-SIGNATURE   200  the render in `result`, and a receipt
```

The render parameters (`url`, `format`, `wait`, `full`) go in the skip's body. If a slot is free the
paid response carries the render; if not, the skipper is #1 and is served as soon as a slot frees:
`POST /x429/use {"token":"…","url":"…"}` answers 429 with its position until then, and the render
after. Waiting for free is the same without the skip: `POST /x429/join` (the queue's join fee is 0,
so the payer signs a 1-unit authorization that is refunded in the same transaction), then `/x429/use`.
A served ticket can also call `GET /v1/render?…` with `X-429-Token: <token>` (a PNG then comes back
as an image). Through the lane, a PNG travels as base64 in `result.png`.

A skip whose `url` the service would refuse (private address, robots.txt, bad params) is refused
before the 402 and before settlement, so nobody pays for a render that cannot happen. A served
ticket whose render fails (a site that is down, a timeout) keeps its ticket: it can call `/use`
again until its admission expires (`X429_ADMISSION_TTL_MS`, 2 minutes).

## Limits and safety

- **SSRF.** Only `http` and `https` on ports 80 and 443. The host must resolve to public addresses
  only: no loopback, RFC 1918, CGNAT, link-local (cloud metadata), ULA, multicast, documentation or
  reserved ranges, and no IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4). This is
  enforced on every request the browser makes: `context.route('**')` sends each one to Node, which
  resolves the host, checks every address, and connects to the address it checked (no window for DNS
  rebinding), then hands the response back with `route.fulfill`. Chromium is launched with a dead
  proxy, so anything `route` does not see (a preconnect, a WebSocket) cannot leave the box;
  WebSockets are closed, service workers blocked, popups closed.
- **Redirects.** Chromium follows a fulfilled 3xx without asking `route` again, so a 3xx is never
  handed to it. A redirect of the page itself aborts that navigation and the renderer navigates to
  the new location, checked again (robots.txt included), at most twice. A subresource's redirects are
  followed in Node, each hop checked.
- **robots.txt** for the token `x429-render` (RFC 9309: our group, else `*`; the longest rule wins),
  cached per origin for 10 minutes. A robots.txt that cannot be fetched allows.
- **Per render:** 20 s hard timeout; 5 MB total response budget shared by all of the page's requests
  (decoded bytes; requests past it are aborted); 300 requests; video, audio and fonts blocked; only
  GET and HEAD leave the page (`RENDER_ALLOW_POST=1` allows POST); a fresh browser context (no
  cookies, no storage, downloads off, 1280×800); a user agent that ends in
  `x429-render/0.1.0 (+https://render.x429.lol)`.
- **Per address:** 30 free renders an hour (a token bucket, `RENDER_FREE_PER_HOUR`). A refused
  request or a busy 429 does not use one. Renders through the line, waited for or paid, are exempt.
- **Output:** markdown cut at 200 KB with `truncated: true`; PNG at most 1280×8000.
- **Logs:** JSON lines on stdout, with the host and path of a target, never a query string (also
  scrubbed from the lane's log entries). The lane logs RPC URLs by host only.

Chromium runs without its own sandbox by default (`RENDER_CHROMIUM_SANDBOX=0`): on hosts that
restrict unprivileged user namespaces it does not start with it. The network policy above does not
depend on it.

## Run

```sh
npm ci && npm run build:x429
cp apps/render/.env.example /tmp/render.env     # fill in the X429_* values
RENDER_ENV_FILE=/tmp/render.env npm run render  # or: node --env-file=/tmp/render.env apps/render/src/main.ts
```

Node 24 or newer (TypeScript runs directly). Chromium: the build `playwright-core` 1.64.1 expects,
`chromium-1248` (`npx playwright-core install chromium`), path in `RENDER_CHROMIUM_PATH`. All settings
are in [`.env.example`](.env.example); deployment in [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Tests

```sh
npm run test:render        # builds the package, then node --test apps/render/test/*.test.ts
bash scripts/render-e2e.sh # the whole flow on an anvil fork of Base, with the real Chromium
```

- `guard.test.ts`: the address matrix, the URL policy (scheme, port, credentials, every spelling of a
  private literal), names resolving to loopback, metadata, ULA or one private address among public
  ones, redirects into private space, the body budget (declared, streamed, a gzip bomb).
- `robots.test.ts`: parsing and matching, the 10-minute cache, allow on 4xx, 5xx, timeouts.
- `browser.test.ts` (real Chromium, a local fixture site): markdown shape, body fallback,
  truncation, PNG sizes, SSRF on the first URL, on redirects and on every subresource (images,
  scripts, iframes, fetch, redirects of subresources, WebSockets, beacons), the redirect limit,
  robots.txt, the timeout (a hanging subresource renders, a spinning page is cut), the response
  budget, blocked media, fonts, POST and PDFs, a fresh context per render.
- `server.test.ts` (a real lane on a local anvil, MockUSDC, a stub renderer that sleeps): refusals
  before any capacity is used, x429's 429 and skip offer when both slots are busy, a paid skip served
  and rendered first while the waiter it passed is paid on-chain, a burst of 12 that never runs more
  than 2, the per-address bucket, the PNG on the ticket path, logs without query strings.
- `config.test.ts`: env defaults and errors, the bucket's arithmetic.

`scripts/render-e2e.sh` forks Base with anvil, deploys X429Checkout with `x429 deploy` and opens a
queue with `x429 queue create` (join fee 0, 3% fee), mints forked USDC to a waiter and a skipper,
starts this server with the production guard and renders a public page (`RENDER_E2E_TARGET`, default
`https://example.com/`): two slow renders fill both slots, a third caller gets 429, the waiter joins
for free, the skipper pays $0.0103 and is rendered first, the waiter receives its 0.01 USDC on-chain,
and the slots never show more than 2 busy.

## Credits and licences

- This app: MIT, see the repository's [LICENSE](../../LICENSE).
- [x429](../../packages/x429) (MIT) and, through it, [viem](https://github.com/wevm/viem) (MIT).
- [Playwright](https://github.com/microsoft/playwright) `playwright-core` (Apache-2.0), driving
  [Chromium](https://www.chromium.org) (BSD-3-Clause and the licences listed in its
  `ABOUT`/credits; Chrome for Testing builds are downloaded by Playwright, not bundled here).
- [@mozilla/readability](https://github.com/mozilla/readability) (Apache-2.0): picks the article.
- [linkedom](https://github.com/WebReflection/linkedom) (ISC): the DOM Readability runs on.
- [Turndown](https://github.com/mixmark-io/turndown) (MIT): HTML to markdown.
- Fonts on the landing page: [Archivo](https://fonts.google.com/specimen/Archivo) and
  [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) (both SIL Open Font License 1.1),
  served by Google Fonts.
