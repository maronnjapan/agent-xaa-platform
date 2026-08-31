#!/usr/bin/env bash
# T-APP-01 / DEC-ID-13. The Automation App is a screen, not a delegate. A refresh token
# or `offline_access` here would let it keep acting as the person after they close it,
# which is the job an agent's own delegation exists to do.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! node scripts/checks/code-grep.mjs 'offline_access|refresh_token' apps/automation-app/src >&2; then
  echo "automation-app must not name offline_access or refresh_token" >&2
  exit 1
fi
echo "ok: automation-app asks for no offline access"
