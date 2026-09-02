#!/usr/bin/env bash
# T-LIFE-02. An agent's status is written in one place, `status-writer.ts`, which reads
# the current value and applies the state machine inside a transaction. A write from
# anywhere else would be a transition nobody checked — and the state machine is what
# makes "an agent never comes back from QUARANTINED" true rather than merely intended.
set -euo pipefail
cd "$(dirname "$0")/.."

# One pass over the directory rather than one Node process per file: the check is run
# from a unit test with a five-second budget, and twenty process starts spend most of
# it. code-grep walks directories itself and strips comments, so the property checked
# is unchanged — the prose explaining the rule is still not a violation of it.
hits=$(node scripts/checks/code-grep.mjs "(update|set)\(['\"]agents['\"].*status:" apps/lifecycle-manager/src || true)
hits=$(printf '%s' "$hits" | grep -v '/status-writer\.ts:' | grep -v '/testing/' || true)

if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "an agent status is written only by status-writer.ts" >&2
  exit 1
fi
echo "ok: one write path for the agent status"
