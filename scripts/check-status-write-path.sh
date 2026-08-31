#!/usr/bin/env bash
# T-LIFE-02. An agent's status is written in one place, `status-writer.ts`, which reads
# the current value and applies the state machine inside a transaction. A write from
# anywhere else would be a transition nobody checked — and the state machine is what
# makes "an agent never comes back from QUARANTINED" true rather than merely intended.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
while IFS= read -r file; do
  case "$file" in
    */status-writer.ts) continue ;;
    */testing/*) continue ;;
  esac
  # code-grep exits 1 when it finds something, so a hit is the failure case.
  if ! node scripts/checks/code-grep.mjs "(update|set)\(['\"]agents['\"].*status:" "$file" >&2; then
    status=1
  fi
done < <(find apps/lifecycle-manager/src -type f -name '*.ts')

if [ "$status" -ne 0 ]; then
  echo "an agent status is written only by status-writer.ts" >&2
  exit 1
fi
echo "ok: one write path for the agent status"
