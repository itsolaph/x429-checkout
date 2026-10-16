#!/usr/bin/env bash
# MCP smoke test: starts the stack on a Base fork (scripts/lib/fork-stack.sh), then an MCP client
# lists the tools and calls x429_status, x429_quote, x429_join*, x429_skip, x429_claim* and x429_redeem.
#
# Usage: bash scripts/mcp-smoke.sh   (or npm run mcp:smoke)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$ROOT/.e2e-mcp"
TAG=mcp
FEE_BPS=300
SERVICE_INTERVAL_MS=4000
MIN_QUEUE_MS=60000
AUTO_PAYOUT=0 # this smoke test covers the legacy pull path (EIP-712 claim)
# shellcheck source=lib/fork-stack.sh
source "$ROOT/scripts/lib/fork-stack.sh"

start_stack
X429_URL="$API" E2E_KEYS="$WORK/keys.json" node scripts/mcp-smoke.ts
log "MCP smoke test passed against $API/mcp"
