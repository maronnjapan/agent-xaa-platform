#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/shared/audit.tf
for expected in 'unique_writer_identity = true' 'google_bigquery_dataset_iam_binding' 'members    = [google_logging_project_sink.audit.writer_identity]'; do
  grep -qF "$expected" "$file" || { echo "one-way-sink: missing $expected" >&2; exit 1; }
done
[[ $(grep -cE 'google_bigquery_dataset_iam_binding' "$file") -eq 1 ]] || { echo 'one-way-sink: expected one authoritative writer binding' >&2; exit 1; }
if find infra -name '*.tf' -not -path '*/.terraform/*' -print0 | xargs -0 -r grep -lE 'google_project_iam_(member|binding)' | xargs -r grep -nE 'roles/bigquery\.(dataEditor|dataOwner|admin)'; then
  echo 'one-way-sink: project-level BigQuery write roles are forbidden' >&2
  exit 1
fi
