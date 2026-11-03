# Deploying render.x429.lol

One Linux box, one user (below `ubuntu`), Caddy in front for TLS. The service runs as a systemd user
unit from a checkout at `~/x429-checkout`; its env file and operator key live in `~/.x429-render`.
Steps 3 and 9 send transactions on Base mainnet; everything else is local.

## 1. Node and Chromium

```sh
node --version                          # 24 or newer, first on PATH (the unit puts ~/.local/bin first)
cd ~/x429-checkout                      # git clone https://github.com/itsolaph/x429-checkout ~/x429-checkout
npm ci && npm run build:x429
npx playwright-core install chromium    # chromium-1248 into ~/.cache/ms-playwright (matches playwright-core 1.64.1)
sudo npx playwright-core install-deps chromium   # the shared libraries Chromium needs, once per box
sudo apt-get install -y fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji   # so pages in any script render
ls ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
```

## 2. The operator key

The render lane needs its own X429Checkout contract: one contract has one operator, fixed at deploy,
and one lane process per contract and key (two processes would race for nonces). Do not reuse
x429.lol's contract or key.

```sh
install -d -m 700 ~/.x429-render
# put a fresh 32-byte hex key in ~/.x429-render/operator.key (one line), then:
chmod 600 ~/.x429-render/operator.key
```

Fund its address with a little ETH on Base for gas (it pays for every settlement, serve and payout). It
never holds users' USDC.

## 3. Deploy the contract and open the queue (Base mainnet)

```sh
X=~/x429-checkout/packages/x429/bin/x429.js
node $X deploy --rpc https://mainnet.base.org --key-file ~/.x429-render/operator.key --dry-run
node $X deploy --rpc https://mainnet.base.org --key-file ~/.x429-render/operator.key --yes
#   → X429_CONTRACT=0x...  X429_DEPLOY_BLOCK=...
node $X queue create --rpc https://mainnet.base.org --key-file ~/.x429-render/operator.key \
  --contract <X429_CONTRACT> --max-length 64 --fee-bps 300 --join-fee 0 \
  --meta '{"name":"render.x429.lol","path":"/v1/render"}' --dry-run
node $X queue create ... --yes          # the same command with --yes → X429_QUEUE_ID=1
node $X status --rpc https://mainnet.base.org --contract <X429_CONTRACT>
```

`--join-fee 0` makes waiting in line free: a joining agent signs a 1-unit authorization that is
refunded in the same transaction, and the operator pays the gas of each join. If free joins are
abused, raise it (for example `--join-fee 0.001`) with `setJoinFee`; nothing else changes.
`--fee-bps 300` is the operator's 3% on top of each skip.

## 4. The env file

```sh
cp ~/x429-checkout/apps/render/.env.example ~/.x429-render/render.env
chmod 600 ~/.x429-render/render.env
```

Set at least `X429_CONTRACT`, `X429_QUEUE_ID`, `X429_DEPLOY_BLOCK` from step 3, and check
`X429_OPERATOR_KEY_FILE`, `X429_DATA_DIR` and `RENDER_CHROMIUM_PATH` point into this user's home. Keep
`RENDER_HOST=127.0.0.1`, `RENDER_PORT=8440`, `RENDER_TRUST_PROXY=1` and
`X429_PUBLIC_URL=https://render.x429.lol`. A dedicated RPC (with its key in the URL) is fine for
`X429_RPC_URL`: logs show RPC hosts only.

Try it in the foreground first:

```sh
cd ~/x429-checkout && node --env-file=$HOME/.x429-render/render.env apps/render/src/main.ts
# another terminal:
curl -s http://127.0.0.1:8440/healthz
curl -s 'http://127.0.0.1:8440/v1/render?url=https://example.com' | head -c 400
```

It refuses to start, with the variable's name, when something is missing or the key is not the
contract's operator. Stop it with Ctrl-C.

## 5. The systemd user unit

```sh
mkdir -p ~/.config/systemd/user
cp ~/x429-checkout/apps/render/deploy/x429-render.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now x429-render
sudo loginctl enable-linger "$USER"
systemctl --user status x429-render
systemctl --user show x429-render -p MemoryMax          # 1572864000
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers   # must list memory
journalctl --user -u x429-render -f
```

If `memory` is not in the user's delegated controllers, `MemoryMax` is ignored: add
`Delegate=cpu cpuset io memory pids` to a drop-in for `user@.service` and reboot, or run the unit as a
system unit with `User=`.

## 6. DNS and Caddy

Point `render.x429.lol` (A, and AAAA if the box has IPv6) at the box. Then add
`apps/render/deploy/Caddyfile.render` to `/etc/caddy/Caddyfile`:

```sh
sudo sh -c 'cat ~ubuntu/x429-checkout/apps/render/deploy/Caddyfile.render >> /etc/caddy/Caddyfile'
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Do not add a `log` directive to that site: Caddy's access log would keep the query strings.

## 7. Check it from outside

```sh
curl -s https://render.x429.lol/healthz
curl -s https://render.x429.lol/x429 | head -c 600          # contract, queue, concurrency 2, prices
curl -s 'https://render.x429.lol/v1/render?url=https://example.com'
curl -s -o page.png 'https://render.x429.lol/v1/render?url=https://example.com&format=png' && file page.png
curl -si 'https://render.x429.lol/v1/render?url=http://169.254.169.254/' | head -1   # 403
```

## 8. Updates and rollback

```sh
cd ~/x429-checkout && git pull && npm ci && npm run build:x429
systemctl --user restart x429-render
# rollback: git checkout <previous commit> && npm ci && npm run build:x429 && systemctl --user restart x429-render
```

Tokens, admissions, paid responses and feed progress survive restarts in `X429_DATA_DIR`.

## 9. Operator chores (Base mainnet)

- Keep ETH on the operator address; check `node $X status ...` for the fees accrued in the contract
  and withdraw them with the contract's `withdrawFees` from the operator key when you want them.
- Change the join fee or the skip fee with the contract's `setJoinFee` / `setFee` (operator only).

## Environment the service needs

| Variable | Value |
|---|---|
| `X429_CONTRACT`, `X429_QUEUE_ID`, `X429_DEPLOY_BLOCK` | from step 3 |
| `X429_OPERATOR_KEY_FILE` | `~/.x429-render/operator.key` (absolute path) |
| `X429_RPC_URL`, `X429_CHAIN_ID` | a Base RPC, `8453` |
| `X429_PUBLIC_URL` | `https://render.x429.lol` |
| `X429_DATA_DIR` | `~/.x429-render/data` (absolute path) |
| `X429_LOGS_RPC_URLS` | getLogs-friendly Base RPCs, comma separated |
| `RENDER_CHROMIUM_PATH` | `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` (absolute path) |
| `RENDER_HOST`, `RENDER_PORT`, `RENDER_TRUST_PROXY` | `127.0.0.1`, `8440`, `1` |

Everything else has a default; `.env.example` lists them all.
