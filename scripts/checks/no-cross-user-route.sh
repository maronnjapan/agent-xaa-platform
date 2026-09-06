#!/usr/bin/env bash
# T-APP-25 / RULE-56. Everyone sees their own activity and their own findings, and
# nobody else's. There is no administrator view in either screen, and no route takes the
# subject as a parameter — it comes from the session, always.
#
# Both apps are read, not just the Automation App. The Analysis Console is the screen a
# platform-wide view would most plausibly be bolted onto, since it already reads a
# collection that holds every person's findings; docs 11 §8 leaves that for a permission
# model this platform does not have yet, and this is what keeps it from arriving early.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
screens=(apps/automation-app/src apps/analysis-console/src)
for screen in "${screens[@]}"; do
  app=$(basename "$(dirname "$screen")")
  if grep -rnE "app\.(get|post|put|patch|delete)\(['\"][^'\"]*(admin|all-users|tenant)" "$screen" >/dev/null; then
    echo "$app must not expose a cross-user route" >&2
    status=1
  fi
  if grep -rnE "req\.(param|query)\(['\"]human_subject" "$screen" >/dev/null; then
    echo "$app: human_subject must come from the session, never from a parameter" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "ok: neither screen has a cross-user route or a subject parameter"
exit "$status"
