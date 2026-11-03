#!/usr/bin/env bash
# render.x429.lol end to end on a local anvil fork of Base. Nothing is sent to Base: the public RPC is
# only read by anvil to build the fork.
#
#   fork Base → deploy X429Checkout with the package CLI (`x429 deploy`, `x429 queue create`, join fee 0,
#   skip fee 3%) → fund a waiter and a skipper with forked USDC → start apps/render against the fork with
#   the real Chromium and the production SSRF guard → scripts/render-e2e.ts: saturate both slots with
#   slow renders of a public page, a third caller gets 429, a waiter joins for free, the 429 now prices
#   a skip, the skipper pays it (x402) and is served and rendered first, and the waiter it passed is
#   paid its price on-chain.
#
# Usage: bash scripts/render-e2e.sh
#   E2E_RPC_URL=<url>        fork source (default: first that answers of mainnet.base.org, base.drpc.org, base-rpc.publicnode.com)
#   E2E_FORK_BLOCK=<n>       pinned fork block (default 52621900)
#   RENDER_CHROMIUM_PATH=<p> Chromium (default ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome)
#   RENDER_E2E_TARGET=<url>  the public page to render (default https://example.com/)
#   RENDER_E2E_BLOCK_TIME=<s> anvil block time (default: mine on every transaction)
#   E2E_KEEP=1               keep anvil and the server running afterwards
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$ROOT/.e2e-render"
TAG=render-e2e
# shellcheck source=lib/fork-stack.sh
source "$ROOT/scripts/lib/fork-stack.sh"   # log, die, the cleanup trap, keys, USDC, FORK_BLOCK

CHROMIUM="${RENDER_CHROMIUM_PATH:-$HOME/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome}"
TARGET="${RENDER_E2E_TARGET:-https://example.com/}"
X429="node $ROOT/packages/x429/bin/x429.js"

for bin in anvil cast node curl; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done
[ -x "$CHROMIUM" ] || die "no Chromium at $CHROMIUM (set RENDER_CHROMIUM_PATH)"
[ -f "$ROOT/packages/x429/dist/index.js" ] || die "build the package first: npm run build:x429"
curl -fsS -o /dev/null --max-time 10 "$TARGET" || die "$TARGET is not reachable from here (set RENDER_E2E_TARGET)"
rm -rf "$WORK"
mkdir -p "$WORK"
chmod 700 "$WORK"

# 1. the fork (as scripts/lib/fork-stack.sh does)
SOURCE="${E2E_RPC_URL:-}"
if [ -z "$SOURCE" ]; then
  for url in https://mainnet.base.org https://base.drpc.org https://base-rpc.publicnode.com; do
    if cast block-number --rpc-url "$url" >/dev/null 2>&1; then SOURCE="$url"; break; fi
  done
fi
[ -n "$SOURCE" ] || die "no Base RPC answered; set E2E_RPC_URL"
RPC_PORT="$(free_port)"
RPC="http://127.0.0.1:$RPC_PORT"
anvil --fork-url "$SOURCE" --fork-block-number "$FORK_BLOCK" --port "$RPC_PORT" --mnemonic "$MNEMONIC" --silent >"$WORK/anvil.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.25
done
[ "$(cast chain-id --rpc-url "$RPC")" = "8453" ] || die "the fork is not chain 8453"
cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$(date +%s)" >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
log "anvil fork of Base at block $FORK_BLOCK (source $SOURCE) on $RPC"

# 2. keys from anvil's public test mnemonic: deployer (funding), operator, waiter, skipper
umask 077
DEPLOYER_KEY="$(derive 0)"
OPERATOR_KEY="$(derive 1)"
WAITER_KEY="$(derive 120)"
SKIPPER_KEY="$(derive 121)"
printf '%s\n' "$OPERATOR_KEY" >"$WORK/operator.key"
printf '{"waiter":"%s","skipper":"%s"}\n' "$WAITER_KEY" "$SKIPPER_KEY" >"$WORK/keys.json"
umask 022
DEPLOYER="$(addr "$DEPLOYER_KEY")"
OPERATOR="$(addr "$OPERATOR_KEY")"
for a in "$DEPLOYER" "$OPERATOR"; do
  cast rpc --rpc-url "$RPC" anvil_setCode "$a" 0x >/dev/null
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH on the fork
done
for k in "$WAITER_KEY" "$SKIPPER_KEY"; do
  cast rpc --rpc-url "$RPC" anvil_setCode "$(addr "$k")" 0x >/dev/null
  cast rpc --rpc-url "$RPC" anvil_setBalance "$(addr "$k")" 0x0 >/dev/null # agents hold no ETH
done

# 3. deploy with the package CLI (chain id 8453: it wants --yes even on a fork)
$X429 deploy --rpc "$RPC" --key-file "$WORK/operator.key" --yes >"$WORK/deploy.log" 2>&1 || { cat "$WORK/deploy.log"; die "x429 deploy failed"; }
CONTRACT="$(grep -oE 'X429_CONTRACT=0x[0-9a-fA-F]{40}' "$WORK/deploy.log" | cut -d= -f2)"
DEPLOY_BLOCK="$(grep -oE 'X429_DEPLOY_BLOCK=[0-9]+' "$WORK/deploy.log" | cut -d= -f2)"
$X429 queue create --rpc "$RPC" --key-file "$WORK/operator.key" --contract "$CONTRACT" --max-length 64 --fee-bps 300 \
  --join-fee 0 --meta '{"name":"render.x429.lol (e2e)","path":"/v1/render"}' --yes >"$WORK/queue.log" 2>&1 || { cat "$WORK/queue.log"; die "x429 queue create failed"; }
QUEUE_ID="$(grep -oE 'X429_QUEUE_ID=[0-9]+' "$WORK/queue.log" | cut -d= -f2)"
log "x429 deploy: X429Checkout $CONTRACT (block $DEPLOY_BLOCK), queue $QUEUE_ID (fee 3%, join fee 0), operator $OPERATOR"

# 4. forked USDC through a minter set by USDC's real masterMinter
master="$(cast call --rpc-url "$RPC" "$USDC" 'masterMinter()(address)')"
cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$master" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setBalance "$master" 0xDE0B6B3A7640000 >/dev/null
cast send --rpc-url "$RPC" --unlocked --from "$master" "$USDC" 'configureMinter(address,uint256)' "$DEPLOYER" 100000000 >/dev/null
cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$master" >/dev/null
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "$WAITER_KEY")" 10000 >/dev/null   # 0.01: a free join still signs 1 unit (refunded)
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "$SKIPPER_KEY")" 1000000 >/dev/null # 1 USDC
log "minted forked USDC: waiter 0.01, skipper 1.00"
if [ -n "${RENDER_E2E_BLOCK_TIME:-}" ]; then
  cast rpc --rpc-url "$RPC" evm_setAutomine false >/dev/null
  cast rpc --rpc-url "$RPC" evm_setIntervalMining "$RENDER_E2E_BLOCK_TIME" >/dev/null
  log "anvil now mines a block every $RENDER_E2E_BLOCK_TIME s"
fi

# 5. the render server, configured from env the way production is (apps/render/.env.example)
PORT="$(free_port)"
API="http://127.0.0.1:$PORT"
RENDER_PORT="$PORT" RENDER_HOST=127.0.0.1 RENDER_CHROMIUM_PATH="$CHROMIUM" RENDER_FREE_PER_HOUR=30 \
X429_PUBLIC_URL="$API" X429_RPC_URL="$RPC" X429_CHAIN_ID=8453 X429_CONTRACT="$CONTRACT" X429_QUEUE_ID="$QUEUE_ID" \
X429_OPERATOR_KEY_FILE="$WORK/operator.key" X429_DEPLOY_BLOCK="$DEPLOY_BLOCK" X429_DATA_DIR="$WORK/data" \
X429_POLL_MS=250 X429_PAYOUT_INTERVAL_MS=1000 \
  node apps/render/src/main.ts >"$WORK/server.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 120); do
  curl -fsS "$API/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$API/healthz" >/dev/null || die "the render server did not start"
log "render server on $API (2 slots, Chromium $("$CHROMIUM" --version 2>/dev/null | grep -oE '[0-9.]+' | head -n1))"

# 6. the scenario
RENDER_API="$API" RENDER_RPC="$RPC" RENDER_USDC="$USDC" RENDER_KEYS="$WORK/keys.json" RENDER_TARGET="$TARGET" \
RENDER_SUMMARY="$WORK/summary.json" RENDER_OPERATOR="$OPERATOR" \
  node scripts/render-e2e.ts | tee "$WORK/scenario.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || die "scenario failed"
if grep -E 'SECRET-E2E|api_key=' "$WORK/server.log" >/dev/null; then die "a query string reached the server log"; fi
log "PASSED: $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.steps+" steps; skipper charged "+s.charged/1e6+" USDC, waiter paid "+s.waiterPaid/1e6+" USDC on-chain, peak "+s.peakBusy+" of 2 slots")' "$WORK/summary.json")"
