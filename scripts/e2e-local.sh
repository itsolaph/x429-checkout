#!/usr/bin/env bash
# x429 Checkout local end-to-end test on a Base mainnet fork.
#
#   fork + deploy (fee 3%) + fund + server (scripts/lib/fork-stack.sh) → agent-sim scenario:
#   6 rivals join → a new agent hits the busy API → 429 + descriptor → POST /skip → 402 → signs
#   EIP-3009 → pays → moves to #1 → is served next → rivals claim gaslessly; plus replayed payment,
#   expired authorization, expired quote, price moved above the ceiling, front-run authorization and
#   claim replay. Balances are asserted to the unit. Ends with the gas used per operation.
#
# Usage: bash scripts/e2e-local.sh   (or npm run e2e)
#   E2E_RPC_URL=<url>   fork source (default: first that answers of mainnet.base.org, base.drpc.org, base-rpc.publicnode.com)
#   E2E_FORK_BLOCK=<n>  pinned fork block (default 52621900)
#   E2E_KEEP=1          keep anvil and the server running afterwards (to look at the dashboard)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$ROOT/.e2e"
TAG=e2e
FEE_BPS=300
SERVICE_INTERVAL_MS=4000
MIN_QUEUE_MS=15000
# shellcheck source=lib/fork-stack.sh
source "$ROOT/scripts/lib/fork-stack.sh"

start_stack

X429_URL="$API" X429_RPC_URL="$RPC" X429_CHAIN_ID=8453 X429_CONTRACT="$CONTRACT" X429_USDC="$USDC" \
X429_DEPLOY_BLOCK="$DEPLOY_BLOCK" E2E_KEYS="$WORK/keys.json" E2E_SUMMARY="$WORK/summary.json" E2E_FEE_BPS="$FEE_BPS" \
  node agent-sim/scenario.ts | tee "$WORK/agents.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || die "scenario failed"

node scripts/render-check.mjs "$API" || die "dashboard render check failed"

node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log("gas used on the fork (all paid by the operator):");
  for (const g of s.gas) console.log(`  ${g.fn.padEnd(13)} ${String(g.gasUsed).padStart(8)}  ${g.note ?? ""}`);
' "$WORK/summary.json"
log "PASSED: $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.results.length+" steps, paid to people waiting "+(Number(s.paidToWaiting)/1e6)+" USDC, fees "+(Number(s.fees)/1e6)+" USDC")' "$WORK/summary.json")"
