#!/usr/bin/env bash
# Starts the demo-agent service (agent-sim/demo-agents.ts) with its own env file, in the foreground,
# for systemd (deploy/x429-demo-agents.service). The env file and the keys file stay outside the repo.
#
# Usage: bash scripts/start-demo-agents.sh <env-file>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf 'start-demo-agents: %s\n' "$*" >&2; exit 1; }

ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || die "usage: bash scripts/start-demo-agents.sh <env-file>"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${DEMO_KEYS_FILE:-}" ] && [ -r "$DEMO_KEYS_FILE" ] || die "DEMO_KEYS_FILE is not set or not readable"
perms="$(stat -c '%a' "$DEMO_KEYS_FILE")"
[ "${perms: -2}" = "00" ] || die "the demo keys file is readable by others (mode $perms); chmod 600 it"
case "$(realpath "$DEMO_KEYS_FILE")" in "$ROOT"/*) die "keep the demo keys file outside the repository" ;; esac

cd "$ROOT"
exec node agent-sim/demo-agents.ts
