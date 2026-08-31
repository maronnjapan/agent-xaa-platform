#!/usr/bin/env bash
# T-APP-16 / RULE-13. An agent's permissions are settled when it is provisioned. A
# route that edited them would make "the agent could not do that" a thing to argue with
# rather than a fact, so no PUT or PATCH may name capabilities.
set -euo pipefail
cd "$(dirname "$0")/../.."

if grep -rnE "app\.(put|patch)\(['\"][^'\"]*(capabilit|effective)" apps/automation-app/src >/dev/null; then
  echo "automation-app must not expose a capability update route" >&2
  exit 1
fi
echo "ok: no capability update route exists"
