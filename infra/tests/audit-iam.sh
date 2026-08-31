#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/shared/audit.tf
for expected in 'unique_writer_identity = true' 'roles/bigquery.dataEditor' 'delete_contents_on_destroy  = true'; do
  grep -qF "$expected" "$file" || { echo "audit-iam: missing $expected" >&2; exit 1; }
done
if find infra/envs/demo -name '*.tf' -print0 | xargs -0 -r grep -nE 'roles/bigquery\.(dataOwner|admin)'; then
  echo 'audit-iam: application service accounts may not administer audit data' >&2
  exit 1
fi
schema_count=$(jq 'length' infra/schema/agent-lifecycle-audit.json)
[[ "$schema_count" -eq 10 ]] || { echo "audit-iam: lifecycle schema must have 10 fields, found $schema_count" >&2; exit 1; }
grep -qE 'google_bigquery_table_iam_member' infra/envs/demo/iam-audit.tf || { echo 'audit-iam: Lifecycle access is not table-scoped' >&2; exit 1; }
