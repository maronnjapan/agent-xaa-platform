#!/usr/bin/env bash
# Answers, on stdout, whether the Log Sink's destination table exists yet: `true` or
# `false` and nothing else, so a caller can hand it straight to `terraform -var`.
#
# Cloud Logging creates `security_audit.run_googleapis_com_stdout` when it first routes a
# Cloud Run stdout entry, not when the sink is created. The five saved detections read
# that table, and BigQuery rejects a view over a missing one at creation rather than at
# query time, so they cannot be applied to a project that has never run a service. The
# deploy path asks this, and passes the answer to the shared state as audit_views_enabled.
#
# Asking GCP each time, instead of remembering a flag somewhere, is what makes a second
# deploy safe: once the table is there the answer is `true` for good, so a later apply
# cannot delete the detections an earlier one created.
#
# Usage: PROJECT_ID=... scripts/audit-log-table.sh [wait_seconds]
#   With no argument it looks once. With one it polls until the table appears or the
#   seconds run out, which is how the deploy path covers the export latency.
set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1
exec </dev/null

project_id=${PROJECT_ID:?PROJECT_ID is required}
dataset=${AUDIT_DATASET:-security_audit}
table=${AUDIT_LOG_TABLE:-run_googleapis_com_stdout}
wait_seconds=${1:-0}
[[ "$wait_seconds" =~ ^[0-9]+$ ]] || { echo "audit-log-table: wait_seconds must be a number, got $wait_seconds" >&2; exit 2; }

api="https://bigquery.googleapis.com/bigquery/v2/projects/$project_id/datasets/$dataset/tables/$table"

# Progress goes to stderr so that stdout stays the one word the caller substitutes.
progress() { ((wait_seconds > 0)) && printf '%s' "$1" >&2; return 0; }

# A diagnosis that holds for the whole wait would otherwise be printed once every five
# seconds for five minutes, so each distinct one is said once.
last_note=''
note() {
  [[ "$1" == "$last_note" ]] && return 0
  last_note=$1
  printf '\naudit-log-table: %s\n' "$1" >&2
}

# 0 the table is there, 1 not yet, 2 the question cannot be asked at all. 404 is the
# ordinary answer before the first log line, and so is the 403 a project returns while
# the dataset itself is missing: both are "not yet". Missing credentials are the third
# case, because no amount of waiting turns that into a table.
table_exists() {
  local token code
  if ! token=$(gcloud auth print-access-token 2>/dev/null); then
    note 'no access token; run `gcloud auth login` first'
    return 2
  fi
  if ! code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$api" 2>/dev/null); then
    note "could not reach $api"
    return 1
  fi
  case "$code" in
    200) return 0 ;;
    403 | 404) return 1 ;;
    *) note "BigQuery answered $code for $dataset.$table"; return 1 ;;
  esac
}

deadline=$((SECONDS + wait_seconds))
while true; do
  table_exists && { progress $' found\n'; echo true; exit 0; }
  (($? == 2)) && break
  ((SECONDS + 5 <= deadline)) || break
  progress '.'
  sleep 5
done
progress $' not found\n'
echo false
