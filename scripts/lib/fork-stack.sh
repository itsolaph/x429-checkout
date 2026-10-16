# Shared setup for scripts/e2e-local.sh and scripts/mcp-smoke.sh (source it, do not run it).
#
#   anvil --fork-url <Base RPC> --fork-block-number <pinned> → keys from anvil's public mnemonic →
#   deploy X429Checkout (join fee 0.001 USDC) → fund the agents with forked USDC (minted through a minter
#   configured by USDC's real masterMinter) → build the dashboard → start the server against the fork.
#
# Nothing is sent to a public network: the public RPC is only read by anvil to build the fork.
#
# Caller sets: WORK (work dir), TAG (log prefix), FEE_BPS, SERVICE_INTERVAL_MS, MIN_QUEUE_MS, JOIN_FEE (units),
# AUTO_PAYOUT (1 = operator pushes compensation, default; 0 = owners claim), ANVIL_BLOCK_TIME (seconds;
# empty = mine on every transaction), SERVE_CONFIRM (1 = a paid skip waits for its serve receipt).
# Keys 111..114 are the demo-agent service's wallets (0.05 USDC each).
# Env: E2E_RPC_URL (fork source), E2E_FORK_BLOCK (pinned block, default 52621900), E2E_KEEP=1.
# Exports: RPC, API, CONTRACT, QUEUE_ID, DEPLOY_BLOCK, USDC, AGENT_KEYS[], WATCHER_KEY, PIDS[].

MNEMONIC="test test test test test test test test test test test junk"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
FORK_BLOCK="${E2E_FORK_BLOCK:-52621900}"

log() { printf '\033[1;36m[%s %s]\033[0m %s\n' "$TAG" "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[%s] %s\033[0m\n' "$TAG" "$*" >&2; exit 1; }

PIDS=()
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ "${E2E_KEEP:-0}" = "1" ] && [ "$code" -eq 0 ]; then
    log "E2E_KEEP=1: anvil ($RPC) and the server ($API) keep running; dashboard at $API/ (kill ${PIDS[*]} to stop)"
    exit 0
  fi
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  sleep 0.5
  for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [ "$code" -ne 0 ]; then
    for f in anvil server; do
      if [ -f "$WORK/$f.log" ]; then
        printf '\n----- last lines of %s/%s.log -----\n' "$(basename "$WORK")" "$f" >&2
        tail -n 30 "$WORK/$f.log" >&2 || true
      fi
    done
    printf '\n\033[1;31m[%s] FAILED (exit %s)\033[0m\n' "$TAG" "$code" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
derive() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1"; }

start_stack() {
  for bin in anvil forge cast node curl; do command -v "$bin" >/dev/null || die "$bin not found on PATH"; done
  rm -rf "$WORK"
  mkdir -p "$WORK"
  chmod 700 "$WORK"

  # 1. fork source
  SOURCE="${E2E_RPC_URL:-}"
  if [ -z "$SOURCE" ]; then
    for url in https://mainnet.base.org https://base.drpc.org https://base-rpc.publicnode.com; do
      if cast block-number --rpc-url "$url" >/dev/null 2>&1; then SOURCE="$url"; break; fi
    done
  fi
  [ -n "$SOURCE" ] || die "no Base RPC answered; set E2E_RPC_URL"

  # 2. anvil fork
  local rpc_port
  rpc_port="$(free_port)"
  RPC="http://127.0.0.1:$rpc_port"
  anvil --fork-url "$SOURCE" --fork-block-number "$FORK_BLOCK" --port "$rpc_port" --mnemonic "$MNEMONIC" \
    --silent >"$WORK/anvil.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 120); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 0.25
  done
  local chain_id
  chain_id="$(cast chain-id --rpc-url "$RPC")" || die "anvil did not start"
  [ "$chain_id" = "8453" ] || die "fork chain id is $chain_id, expected 8453"
  # move the fork clock to now, so wall-clock x402 authorization windows line up with block time
  cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp "$(date +%s)" >/dev/null
  cast rpc --rpc-url "$RPC" evm_mine >/dev/null
  DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC")"
  log "anvil fork of Base mainnet at block $FORK_BLOCK (source $SOURCE) on $RPC, chain $chain_id"

  # 3. keys (anvil's public test mnemonic; agents far from the funded indices)
  umask 077
  DEPLOYER_KEY="$(derive 0)"
  OPERATOR_KEY="$(derive 1)"
  WATCHER_KEY="$(derive 2)"
  printf '%s\n' "$OPERATOR_KEY" >"$WORK/operator.key"
  AGENT_KEYS=()
  for i in $(seq 100 114); do AGENT_KEYS+=("$(derive "$i")"); done
  WATCHER_KEY="$WATCHER_KEY" OUT="$WORK/keys.json" node -e '
    const k = process.argv.slice(1);
    const out = { rivals: k.slice(0, 6), skipper: k[6], late: k[7], cautious: k[8], rusher: k[9], victim: k[10], demo: k.slice(11, 15), watcher: process.env.WATCHER_KEY };
    require("fs").writeFileSync(process.env.OUT, JSON.stringify(out));
  ' "${AGENT_KEYS[@]}"
  umask 022
  DEPLOYER="$(addr "$DEPLOYER_KEY")"
  # the 6 rivals are the operator's demo agents, labeled as such by the server and the dashboard
  DEMO_AGENTS=""
  for i in 0 1 2 3 4 5 11 12 13 14; do DEMO_AGENTS="$DEMO_AGENTS${DEMO_AGENTS:+,}$(addr "${AGENT_KEYS[$i]}")"; done
  OPERATOR="$(addr "$OPERATOR_KEY")"
  # agents start with no ETH and no code (mainnet state of well-known test addresses is not ours)
  for k in "${AGENT_KEYS[@]}"; do
    local a
    a="$(addr "$k")"
    cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x0 >/dev/null
    cast rpc --rpc-url "$RPC" anvil_setCode "$a" 0x >/dev/null
  done
  for a in "$DEPLOYER" "$OPERATOR" "$(addr "$WATCHER_KEY")"; do
    cast rpc --rpc-url "$RPC" anvil_setCode "$a" 0x >/dev/null
    cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null # 100 ETH
  done
  log "keys derived into $(basename "$WORK")/ (operator $OPERATOR); ${#AGENT_KEYS[@]} agents with 0 ETH"

  # 4. deploy
  local out
  out="$(DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" OPERATOR_PRIVATE_KEY="$OPERATOR_KEY" USDC="$USDC" \
    QUEUE_FEE_BPS="$FEE_BPS" QUEUE_JOIN_FEE="${JOIN_FEE:-1000}" QUEUE_MAX_LENGTH=64 QUEUE_META='{"name":"x429 forecast API","path":"/v1/forecast"}' \
    forge script contracts/script/Deploy.s.sol:Deploy --root contracts --rpc-url "$RPC" --broadcast 2>&1)" \
    || { echo "$out"; die "deploy failed"; }
  CONTRACT="$(grep -oE 'X429_CONTRACT=0x[0-9a-fA-F]{40}' <<<"$out" | head -n1 | cut -d= -f2)"
  QUEUE_ID="$(grep -oE 'X429_QUEUE_ID=[0-9]+' <<<"$out" | head -n1 | cut -d= -f2)"
  [ -n "$CONTRACT" ] && [ -n "$QUEUE_ID" ] || { echo "$out"; die "could not parse the deploy output"; }
  log "deployed X429Checkout at $CONTRACT, queue $QUEUE_ID, fee ${FEE_BPS} bps, join fee ${JOIN_FEE:-1000} units, operator $OPERATOR"

  # 5. fund the paying agents (indices 6..10) with forked USDC
  local master
  master="$(cast call --rpc-url "$RPC" "$USDC" 'masterMinter()(address)')"
  cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$master" >/dev/null
  cast rpc --rpc-url "$RPC" anvil_setBalance "$master" 0xDE0B6B3A7640000 >/dev/null
  cast send --rpc-url "$RPC" --unlocked --from "$master" "$USDC" 'configureMinter(address,uint256)' "$DEPLOYER" 1000000000000 >/dev/null
  cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$master" >/dev/null
  for i in 6 7 8 9 10; do
    cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "${AGENT_KEYS[$i]}")" 5000000 >/dev/null
  done
  # the demo rivals get 0.1 USDC each for their paid join; rival-1 1 USDC more, to pay for a move
  for i in 0 1 2 3 4 5; do
    cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "${AGENT_KEYS[$i]}")" 100000 >/dev/null
  done
  cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "${AGENT_KEYS[0]}")" 1000000 >/dev/null
  for i in 11 12 13 14; do
    cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$USDC" 'mint(address,uint256)' "$(addr "${AGENT_KEYS[$i]}")" 50000 >/dev/null
  done
  log "minted forked USDC through a minter set by USDC's masterMinter ($master): 5 USDC to each of 5 paying agents, 0.1 USDC to each demo rival (+1 USDC to rival-1)"

  # 6. from here on, Base-like block times (setup ran with automine, which is faster)
  if [ -n "${ANVIL_BLOCK_TIME:-}" ]; then
    cast rpc --rpc-url "$RPC" evm_setAutomine false >/dev/null
    cast rpc --rpc-url "$RPC" evm_setIntervalMining "$ANVIL_BLOCK_TIME" >/dev/null
    log "anvil now mines a block every ${ANVIL_BLOCK_TIME} s"
  fi

  # 7. dashboard + server
  node web/build.mjs >"$WORK/web.log" 2>&1 || { cat "$WORK/web.log"; die "dashboard build failed"; }
  local port
  port="$(free_port)"
  API="http://127.0.0.1:$port"
  X429_RPC_URL="$RPC" X429_CHAIN_ID=8453 X429_CONTRACT="$CONTRACT" X429_QUEUE_ID="$QUEUE_ID" \
  X429_OPERATOR_KEY_FILE="$WORK/operator.key" X429_PORT="$port" X429_PUBLIC_URL="$API" \
  X429_SERVICE_INTERVAL_MS="$SERVICE_INTERVAL_MS" X429_MIN_QUEUE_MS="$MIN_QUEUE_MS" X429_POLL_MS=500 \
  X429_DEPLOY_BLOCK="$DEPLOY_BLOCK" X429_SITE_DIR="$ROOT/site" X429_DATA_DIR="$WORK/data" X429_PAYOUT_INTERVAL_MS=1000 X429_AUTO_PAYOUT="${AUTO_PAYOUT:-1}" \
  X429_SERVE_CONFIRM="${SERVE_CONFIRM:-0}" X429_FORECAST_SOURCE=demo \
  X429_DEMO_AGENTS="$DEMO_AGENTS" \
    node server/src/main.ts >"$WORK/server.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 80); do
    curl -fsS "$API/healthz" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -fsS "$API/healthz" >/dev/null || die "server not healthy"
  curl -fsS "$API/" | grep -q '<title>' || die "dashboard is not served"
  log "server on $API (1 request / ${SERVICE_INTERVAL_MS} ms, admission round ${MIN_QUEUE_MS} ms), dashboard at $API/"
}
