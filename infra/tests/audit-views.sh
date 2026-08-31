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
done

count=$(ls infra/envs/shared/sql/*.sql | wc -l)
if [ "$count" -ne 4 ]; then
  echo "expected four saved detections, found $count" >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "ok: four saved detections, same six columns"
exit "$status"
