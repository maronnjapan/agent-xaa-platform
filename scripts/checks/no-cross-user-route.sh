#!/usr/bin/env bash
# T-APP-25 / RULE-56. Everyone sees their own activity and nobody else's. There is no
# administrator view, and no route takes the subject as a parameter — the subject comes
# from the verified token, always.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
if grep -rnE "app\.(get|post|put|patch|delete)\(['\"][^'\"]*(admin|all-users|tenant)" apps/automation-app/src >/dev/null; then
  echo "automation-app must not expose a cross-user route" >&2
  status=1
fi
if grep -rnE "req\.(param|query)\(['\"]human_subject" apps/automation-app/src >/dev/null; then
  echo "human_subject must come from the token, never from a parameter" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "ok: no cross-user route and no subject parameter"
exit "$status"
