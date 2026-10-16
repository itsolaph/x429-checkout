#!/usr/bin/env bash
# Deploys X429Checkout to Base mainnet (chain 8453) and opens queue 1 with its join fee.
#
# Usage: bash scripts/deploy-base.sh <env-file> [--broadcast]
#   Without --broadcast forge only simulates against the RPC: nothing is signed or sent.
#   With --broadcast it sends the transactions one at a time (--slow) and prints the server settings.
#
# The env file lives outside the repo (chmod 600) and sets:
#   OPERATOR_PRIVATE_KEY=0x…   the operator: creates the queue, relays, serves, pays out (needs ETH)
#   DEPLOYER_PRIVATE_KEY=0x…   optional; defaults to the operator key
#   BASE_RPC_URL=https://…     a Base mainnet RPC
#   QUEUE_FEE_BPS=0            optional, operator fee on skips (max 1000)
#   QUEUE_JOIN_FEE=1000        optional, USDC units a paid join costs (1000 = 0.001 USDC)
#   QUEUE_MAX_LENGTH=64        optional
#   QUEUE_META='{"name":"…"}'  optional
#   BASESCAN_API_KEY=…         optional; verifies the source on basescan
#
# Keys reach forge only through the environment (never on a command line) and are never printed.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf '\033[1;31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }
log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }

ENV_FILE="${1:-}"
MODE="${2:-}"
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || die "usage: bash scripts/deploy-base.sh <env-file> [--broadcast]"
[ -z "$MODE" ] || [ "$MODE" = "--broadcast" ] || die "unknown option $MODE"
case "$(realpath "$ENV_FILE")" in "$ROOT"/*) die "keep the env file outside the repository" ;; esac
perms="$(stat -c '%a' "$ENV_FILE")"
[ "${perms: -2}" = "00" ] || die "$ENV_FILE is readable by others (mode $perms); chmod 600 it"
for bin in forge cast node; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${OPERATOR_PRIVATE_KEY:-}" ] || die "OPERATOR_PRIVATE_KEY is not set in $ENV_FILE"
[ -n "${BASE_RPC_URL:-}" ] || die "BASE_RPC_URL is not set in $ENV_FILE"
export DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-$OPERATOR_PRIVATE_KEY}"
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export QUEUE_JOIN_FEE="${QUEUE_JOIN_FEE:-1000}"

chain="$(cast chain-id --rpc-url "$BASE_RPC_URL")" || die "the RPC did not answer"
[ "$chain" = "8453" ] || die "BASE_RPC_URL is chain $chain, expected Base mainnet (8453)"
[ "$(cast call --rpc-url "$BASE_RPC_URL" "$USDC" 'decimals()(uint8)')" = "6" ] || die "USDC not found at $USDC"

args=(script contracts/script/Deploy.s.sol:Deploy --root "$ROOT/contracts" --rpc-url "$BASE_RPC_URL" --chain 8453 --slow)
if [ "$MODE" = "--broadcast" ]; then
  args+=(--broadcast)
  if [ -n "${BASESCAN_API_KEY:-}" ]; then args+=(--verify --etherscan-api-key "$BASESCAN_API_KEY"); fi
  log "broadcasting to Base mainnet (chain 8453)"
else
  log "simulation only (add --broadcast to send)"
fi

out="$(forge "${args[@]}" 2>&1)" || { printf '%s\n' "$out" | grep -viE 'private|key=' >&2; die "forge script failed"; }
printf '%s\n' "$out" | grep -E 'X429_|Estimated|gas|ETH|Script ran|ONCHAIN|Transaction|Hash|Block' | grep -viE 'private|key=' || true

contract="$(grep -oE 'X429_CONTRACT=0x[0-9a-fA-F]{40}' <<<"$out" | head -n1 | cut -d= -f2)"
queue="$(grep -oE 'X429_QUEUE_ID=[0-9]+' <<<"$out" | head -n1 | cut -d= -f2)"
[ -n "$contract" ] && [ -n "$queue" ] || die "could not read the deployed address from the forge output"
if [ "$MODE" = "--broadcast" ]; then
  run="$ROOT/contracts/broadcast/Deploy.s.sol/8453/run-latest.json"
  block="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Math.min(...r.receipts.map(x=>Number(x.blockNumber))))' "$run")"
  [ "$(cast call --rpc-url "$BASE_RPC_URL" "$contract" 'joinFee(uint32)(uint128)' "$queue")" = "$QUEUE_JOIN_FEE" ] || die "join fee not set"
  log "deployed. Put these into the server env file:"
  printf 'X429_CONTRACT=%s\nX429_QUEUE_ID=%s\nX429_DEPLOY_BLOCK=%s\n' "$contract" "$queue" "$block"
else
  log "simulated: the contract would be $contract, queue $queue"
fi
