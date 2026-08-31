#!/usr/bin/env bash
# T-APP-12. Reaching an agent's data must go through the ownership check. Any module
# that builds an `agents/...` path for itself has found a way around it.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
while IFS= read -r file; do
  case "$file" in
    apps/automation-app/src/agents/*) continue ;;
  esac
  if grep -nE "'agents'|\"agents\"|agents/\\\$\{" "$file" >/dev/null; then
    grep -nE "'agents'|\"agents\"|agents/\\\$\{" "$file" | sed "s|^|$file:|" >&2
    status=1
  fi
done < <(find apps/automation-app/src -type f \( -name '*.ts' -o -name '*.tsx' \))

if [ "$status" -ne 0 ]; then
  echo "agent paths must be built inside apps/automation-app/src/agents" >&2
  exit 1
fi
echo "ok: agent state is reached only through the ownership check"
