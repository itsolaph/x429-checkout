#!/usr/bin/env bash
# x429 Checkout local end-to-end test on a Base mainnet fork.
#
#   anvil --fork-url <Base RPC> --fork-block-number <pinned> → deploy X429Checkout (fee 3%) → fund
#   test agents with forked USDC (minted through a minter configured by the real masterMinter) →
#   server against the fork → agent-sim scenario (join, 429, 402, pay, skip, serve, redeem, claim and
#   the failure cases) → gas summary.
#
# Nothing is sent to a public network: the public RPC is only read by anvil to build the fork.
# Keys are derived at runtime from anvil's public test mnemonic into .e2e/ (gitignored).
#
# Usage: bash scripts/e2e-local.sh
#   E2E_RPC_URL=<url>      fork source (default: first that answers of mainnet.base.org, base.drpc.org, base-rpc.publicnode.com)
#   E2E_FORK_BLOCK=<n>     pinned fork block (default 52621900)
#   E2E_KEEP=1             keep anvil and the server running after the test (to look at the dashboard)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
E2E="$ROOT/.e2e"
MNEMONIC="test test test test test test test test test test test junk"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
FORK_BLOCK="${E2E_FORK_BLOCK:-52621900}"
FEE_BPS=300
SERVICE_INTERVAL_MS=4000
MIN_QUEUE_MS=15000

log() { printf '\033[1;36m[e2e %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[e2e] %s\033[0m\n' "$*" >&2; exit 1; }

PIDS=()
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ "${E2E_KEEP:-0}" = "1" ] && [ "$code" -eq 0 ]; then
    log "E2E_KEEP=1: anvil ($RPC) and the server ($API) keep running; dashboard at $API/  (kill ${PIDS[*]} to stop)"
    exit 0
  fi
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  sleep 0.5
  for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [ "$code" -ne 0 ]; then
    for f in anvil server; do
      if [ -f "$E2E/$f.log" ]; then
        printf '\n----- last lines of .e2e/%s.log -----\n' "$f" >&2
        tail -n 30 "$E2E/$f.log" >&2 || true
      fi
    done
    printf '\n\033[1;31m[e2e] FAILED (exit %s)\033[0m\n' "$code" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for bin in anvil forge cast node; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

rm -rf "$E2E"
mkdir -p "$E2E"
chmod 700 "$E2E"

# ---------------------------------------------------------------- 1. fork source
SOURCE="${E2E_RPC_URL:-}"
if [ -z "$SOURCE" ]; then
  for url in https://mainnet.base.org https://base.drpc.org https://base-rpc.publicnode.com; do
    if cast block-number --rpc-url "$url" >/dev/null 2>&1; then SOURCE="$url"; break; fi
  done
fi
[ -n "$SOURCE" ] || die "no Base RPC answered; set E2E_RPC_URL"

# ---------------------------------------------------------------- 2. anvil fork
RPC_PORT="$(free_port)"
RPC="http://127.0.0.1:$RPC_PORT"
anvil --fork-url "$SOURCE" --fork-block-number "$FORK_BLOCK" --port "$RPC_PORT" --mnemonic "$MNEMONIC" \
  --silent >"$E2E/anvil.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.25
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")" || die "anvil did not start"
[ "$CHAIN_ID" = "8453" ] || die "fork chain id is $CHAIN_ID, expected 8453"
# move the fork clock to now, so wall-clock x402 authorization windows line up with block time
cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$(date +%s)" >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC")"
log "anvil fork of Base mainnet at block $FORK_BLOCK (source $SOURCE) on $RPC, chain $CHAIN_ID"

# ---------------------------------------------------------------- 3. keys (public test mnemonic)
derive() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1"; }
umask 077
DEPLOYER_KEY="$(derive 0)"
OPERATOR_KEY="$(derive 1)"
WATCHER_KEY="$(derive 2)"
printf '%s\n' "$OPERATOR_KEY" >"$E2E/operator.key"
AGENT_KEYS=()
for i in $(seq 100 110); do AGENT_KEYS+=("$(derive "$i")"); done
WATCHER_KEY="$WATCHER_KEY" OUT="$E2E/keys.json" node -e '
  const k = process.argv.slice(1);
  const out = { rivals: k.slice(0, 6), skipper: k[6], late: k[7], cautious: k[8], rusher: k[9], victim: k[10], watcher: process.env.WATCHER_KEY };
  require("fs").writeFileSync(process.env.OUT, JSON.stringify(out));
' "${AGENT_KEYS[@]}"
umask 022
DEPLOYER="$(addr "$DEPLOYER_KEY")"
OPERATOR="$(addr "$OPERATOR_KEY")"

# agents start with no ETH and no code (mainnet state of well-known test addresses is not ours)
for i in "${!AGENT_KEYS[@]}"; do
  a="$(addr "${AGENT_KEYS[$i]}")"
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x0 >/dev/null
  cast rpc --rpc-url "$RPC" anvil_setCode "$a" 0x >/dev/null
done
for a in "$DEPLOYER" "$OPERATOR" "$(addr "$WATCHER_KEY")"; do
  cast rpc --rpc-url "$RPC" anvil_setCode "$a" 0x >/dev/null
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH
done
log "keys derived into .e2e/ (operator $OPERATOR); 11 agents with 0 ETH"

# ---------------------------------------------------------------- 4. deploy
DEPLOY_OUT="$(DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" OPERATOR_PRIVATE_KEY="$OPERATOR_KEY" USDC="$USDC" \
  QUEUE_FEE_BPS="$FEE_BPS" QUEUE_MAX_LENGTH=64 QUEUE_META='{"name":"x429 forecast API","path":"/v1/forecast"}' \
  forge script contracts/script/Deploy.s.sol:Deploy --root contracts --rpc-url "$RPC" --broadcast 2>&1)" \
  || { echo "$DEPLOY_OUT"; die "deploy failed"; }
CONTRACT="$(grep -oE 'X429_CONTRACT=0x[0-9a-fA-F]{40}' <<<"$DEPLOY_OUT" | head -n1 | cut -d= -f2)"
QUEUE_ID="$(grep -oE 'X429_QUEUE_ID=[0-9]+' <<<"$DEPLOY_OUT" | head -n1 | cut -d= -f2)"
[ -n "$CONTRACT" ] && [ -n "$QUEUE_ID" ] || { echo "$DEPLOY_OUT"; die "could not parse the deploy output"; }
log "deployed X429Checkout at $CONTRACT, queue $QUEUE_ID, fee ${FEE_BPS} bps, operator $OPERATOR"

# ---------------------------------------------------------------- 5. fund agents with forked USDC
MASTER="$(cast call --rpc-url "$RPC" "$USDC" 'masterMinter()(address)')"
cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$MASTER" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setBalance "$MASTER" 0xDE0B6B3A7640000 >/dev/null
cast send --rpc-url "$RPC" --unlocked --from "$MASTER" "$USDC" 'configureMinter(address,uint256)' "$DEPLOYER" 1000000000000 >/dev/null
cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$MASTER" >/dev/null
for i in 6 7 8 9 10; do
  cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "${AGENT_KEYS[$i]}")" 5000000 >/dev/null
done
log "minted 5 USDC to each of the 5 paying agents through a minter set by USDC's masterMinter ($MASTER)"

# ---------------------------------------------------------------- 6. dashboard + server
node web/build.mjs >"$E2E/web.log" 2>&1 || { cat "$E2E/web.log"; die "dashboard build failed"; }
PORT="$(free_port)"
API="http://127.0.0.1:$PORT"
X429_RPC_URL="$RPC" X429_CHAIN_ID=8453 X429_CONTRACT="$CONTRACT" X429_QUEUE_ID="$QUEUE_ID" \
X429_OPERATOR_KEY_FILE="$E2E/operator.key" X429_PORT="$PORT" X429_PUBLIC_URL="$API" \
X429_SERVICE_INTERVAL_MS="$SERVICE_INTERVAL_MS" X429_MIN_QUEUE_MS="$MIN_QUEUE_MS" X429_POLL_MS=500 \
X429_DEPLOY_BLOCK="$DEPLOY_BLOCK" X429_SITE_DIR="$ROOT/site" \
  node server/src/main.ts >"$E2E/server.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 80); do
  curl -fsS "$API/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$API/healthz" >/dev/null || die "server not healthy"
curl -fsS "$API/" | grep -q '<title>' || die "dashboard is not served"
log "server on $API (1 request / ${SERVICE_INTERVAL_MS} ms, admission round ${MIN_QUEUE_MS} ms), dashboard at $API/"

# ---------------------------------------------------------------- 7. agents
X429_URL="$API" X429_RPC_URL="$RPC" X429_CHAIN_ID=8453 X429_CONTRACT="$CONTRACT" X429_USDC="$USDC" \
X429_DEPLOY_BLOCK="$DEPLOY_BLOCK" E2E_KEYS="$E2E/keys.json" E2E_SUMMARY="$E2E/summary.json" E2E_FEE_BPS="$FEE_BPS" \
  node agent-sim/scenario.ts | tee "$E2E/agents.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || die "scenario failed"

# ---------------------------------------------------------------- 8. gas summary
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log("gas used on the fork (all paid by the operator):");
  for (const g of s.gas) console.log(`  ${g.fn.padEnd(13)} ${String(g.gasUsed).padStart(8)}  ${g.note ?? ""}`);
' "$E2E/summary.json"
log "PASSED: $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.results.length+" steps, paid to people waiting "+(Number(s.paidToWaiting)/1e6)+" USDC, fees "+(Number(s.fees)/1e6)+" USDC")' "$E2E/summary.json")"
