#!/usr/bin/env bash
# T-DOCS-06. The two-project layout is gone (DEC-SCOPE-01): one GCP Project holds both
# the running platform and the audit dataset, and the separation is IAM, not a project
# boundary. A document that still names `agent-security-prod` is describing a design
# nobody is building, and the reader has no way to tell which half is current.
#
# The old name may still appear where it is explicitly marked as the design that was
# dropped, which is what deviations.md and the change history record.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
while IFS=: read -r file line text; do
  [[ -n "$file" ]] || continue
  case "$file" in
    docs/deviations.md|docs/README.md) continue ;;
  esac
  # A mention that says outright it is the retired design is a record, not a claim.
  if [[ "$text" == *旧設計* || "$text" == *採らなかった* || "$text" == *不採用* ]]; then continue; fi
  printf '%s:%s names the retired project layout: %s\n' "$file" "$line" "${text# }" >&2
  status=1
done < <(grep -rn 'agent-security-prod\|agent-platform-prod' docs/ --include='*.md' || true)

[ "$status" -eq 0 ] && echo 'ok: no document names the retired two-project layout'
exit "$status"
