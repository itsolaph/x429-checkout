#!/usr/bin/env bash
# Starts the x429 server with its configuration from an env file (gitignored, see .env.example).
# Runs in the foreground (exec), so a process supervisor (systemd, see deploy/x429-checkout.service)
# owns it: logs go to stdout as JSON lines, SIGTERM stops it cleanly.
#
# Usage: bash scripts/start-server.sh <env-file>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf 'start-server: %s\n' "$*" >&2; exit 1; }

ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || die "usage: bash scripts/start-server.sh <env-file>"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -n "${X429_CONTRACT:-}" ] || die "X429_CONTRACT is not set"
if [ "${X429_CHAIN_ID:-8453}" = "8453" ] && [ "${X429_ALLOW_HTTP:-0}" != "1" ]; then
  # x402 resources and the PayBox plugin need the public https origin
  case "${X429_PUBLIC_URL:-}" in https://*) ;; *) die "X429_PUBLIC_URL must be the public https origin on Base mainnet" ;; esac
fi
if [ -n "${X429_OPERATOR_KEY_FILE:-}" ]; then
  [ -r "$X429_OPERATOR_KEY_FILE" ] || die "cannot read X429_OPERATOR_KEY_FILE"
  perms="$(stat -c '%a' "$X429_OPERATOR_KEY_FILE")"
  [ "${perms: -2}" = "00" ] || die "the operator key file is readable by others (mode $perms); chmod 600 it"
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || die "Node.js 24 or newer is required (found $(node -v))"

cd "$ROOT"
[ -d node_modules ] || die "run npm ci first"
exec node server/src/main.ts
