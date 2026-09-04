#!/usr/bin/env bash
# T-SEC-09. The four saved detections must agree on their shape so they can be unioned,
# and none of them may use SELECT * — a view whose columns change when a table does is a
# detection that silently stops matching.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
required='occurred_at agent_id human_subject trace_id detection_code detail'

for file in infra/envs/shared/sql/*.sql; do
  if grep -qE 'SELECT \*' "$file"; then
    echo "$file uses SELECT *" >&2
    status=1
  fi
  for column in $required; do
    if ! grep -q "$column" "$file"; then
      echo "$file does not project $column" >&2
      status=1
    fi
  done
  # The sink infers jsonPayload as a STRUCT from the first logs it sees. Optional keys
  # must therefore be extracted as JSON; direct access makes view creation fail whenever
  # that event kind has not reached a fresh environment yet.
  if grep -qE 'jsonPayload\.[[:alpha:]_]' "$file"; then
    echo "$file directly accesses an optional jsonPayload member" >&2
    status=1
  fi
done

# The four of DEC-SEC-01 plus refresh_token_reuse (T-SEC-14).
count=$(ls infra/envs/shared/sql/*.sql | wc -l)
if [ "$count" -ne 5 ]; then
  echo "expected five saved detections, found $count" >&2
  status=1
fi
for view in delegation_mismatch signing_key_misuse cross_agent_access dpop_replay refresh_token_reuse; do
  if ! grep -q "\"$view\"" infra/envs/shared/audit-views.tf; then
    echo "$view is not declared as a view" >&2
    status=1
  fi
done

# The views read the table Cloud Logging creates from the first Cloud Run stdout line,
# which does not exist while a new project's shared state is first applied. BigQuery
# rejects such a view at creation, so the set has to be able to stay empty for one apply.
if ! grep -q 'var.audit_views_enabled ? toset(local.audit_views) : toset(\[\])' infra/envs/shared/audit-views.tf; then
  echo 'audit-views: the views must be held back until the sink has produced its table' >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "ok: five saved detections, same six columns"
exit "$status"
