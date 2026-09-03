#!/usr/bin/env bash
# T-SEC-07 / RULE-42. Audit data is written by the sink and read by the detector, and
# nobody on the platform side may delete it.
#
# "Delete-capable" is the property, not a role name: dataOwner and admin can drop a
# table, and a dataset-level dataEditor can truncate one. So the writer binding is
# authoritative and names only the sink, the detector's write access is granted per
# table, and the two dangerous roles appear nowhere in either environment.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
shared=infra/envs/shared/audit.tf
tables=infra/envs/shared/audit-tables.tf
# The detector's per-table write access lives with sa-security, in the demo state: a
# setIamPolicy naming a service account that does not exist yet is rejected, and the
# shared state is applied before that account is created.
writer=infra/envs/demo/iam-audit.tf

for expected in 'unique_writer_identity = true' 'roles/bigquery.dataEditor' 'delete_contents_on_destroy  = true'; do
  grep -qF "$expected" "$shared" || { echo "audit-iam: missing $expected" >&2; status=1; }
done

# platform SAs hold no delete-capable role on security_audit.
if find infra/envs -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -nE 'roles/bigquery\.(dataOwner|admin)'; then
  echo 'audit-iam: application service accounts may not administer audit data' >&2
  status=1
fi

# The one dataset-wide writer is the sink, and it is the only member of that binding.
if ! grep -qF 'members    = [google_logging_project_sink.audit.writer_identity]' "$shared"; then
  echo 'audit-iam: the dataset-wide writer must be the sink identity alone' >&2
  status=1
fi
if grep -qE 'google_bigquery_dataset_iam_(member|binding)' "$tables"; then
  echo 'audit-iam: the detector gets table bindings, never a dataset-wide one' >&2
  status=1
fi
if grep -qE 'google_bigquery_dataset_iam_binding' "$writer"; then
  echo 'audit-iam: the detector keeps per-table write access wherever the binding lives' >&2
  status=1
fi
# The shared state may not name a service account it does not create; that is what made
# the audit tables fail to apply on a project that had never run a deploy.
if grep -qE 'serviceAccount:sa-' infra/envs/shared/*.tf; then
  echo 'audit-iam: the shared state may not name a demo service account as a literal' >&2
  status=1
fi
# Read plus per-table write, and the ledger is not among the tables it may write: the
# Agent OP writes that one and a detector that could edit it could erase its own alibi.
if ! grep -qF 'toset(["normalized_events", "findings", "rule_hits"])' "$writer"; then
  echo 'audit-iam: the detector may write exactly the three tables it produces' >&2
  status=1
fi
if grep -nE 'google_bigquery_table_iam_binding' "$writer" | grep -q 'id_jag_ledger'; then
  echo 'audit-iam: the detector may not write the issuance ledger' >&2
  status=1
fi

schema_count=$(jq 'length' infra/schema/agent-lifecycle-audit.json)
[[ "$schema_count" -eq 10 ]] || { echo "audit-iam: lifecycle schema must have 10 fields, found $schema_count" >&2; status=1; }
grep -qE 'google_bigquery_table_iam_member' infra/envs/demo/iam-audit.tf || { echo 'audit-iam: Lifecycle access is not table-scoped' >&2; status=1; }

[ "$status" -eq 0 ] && echo "ok: no platform SA can delete audit data"
exit "$status"
