#!/usr/bin/env bash
# T-SEC-08 / T-SEC-34. Security Detection asks the Lifecycle Manager to act and reaches
# nothing else. A detector that could call the Agent OP or a Resource AS directly would
# be a second authority over an agent's credentials, and two authorities eventually
# disagree about whether an agent is still allowed to work.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
while IFS= read -r file; do
  case "$file" in
    apps/security-detection/src/server.ts) continue ;;
    apps/security-detection/src/testing/*) continue ;;
  esac
  if ! node scripts/checks/code-grep.mjs 'globalThis\.fetch|httpClient\(' "$file" >&2; then
    status=1
  fi
done < <(find apps/security-detection/src -type f -name '*.ts')

# The one place a request leaves this service, and the one destination it may name.
if ! grep -q 'LIFECYCLE_MANAGER_URL' apps/security-detection/src/server.ts; then
  echo "the lifecycle manager is the only outbound destination and must be named" >&2
  status=1
fi
for forbidden in AGENT_OP RESOURCE_DOCS_AS RESOURCE_FINANCE_AS BRIDGE; do
  if grep -q "${forbidden}_URL" apps/security-detection/src/server.ts; then
    echo "security-detection must not address ${forbidden}" >&2
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "ok: one outbound destination, the Lifecycle Manager"
exit "$status"
