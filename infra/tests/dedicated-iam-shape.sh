#!/usr/bin/env bash
set -euo pipefail

tf=infra/envs/demo/locals-dedicated-iam.tf
ts=packages/xaa-contracts/src/dedicated-iam.ts
for file in "$tf" "$ts"; do [[ -f "$file" ]] || { echo "dedicated-iam-shape: missing $file" >&2; exit 1; }; done

extract_tf() {
  local start=$1
  sed -n "/$start = \[/,/^  \]/p" "$tf" | grep -oE '"roles/[^"]+"' | tr -d '"'
}
extract_ts() {
  local start=$1
  sed -n "/$start = \[/,/^\] as const/p" "$ts" | grep -oE "'roles/[^']+'" | tr -d "'"
}

diff -u <(extract_tf dedicated_op_sa_roles) <(extract_ts DEDICATED_OP_SA_ROLES) >/dev/null || {
  echo 'dedicated-iam-shape: Dedicated OP roles differ between Terraform and TypeScript' >&2
  exit 1
}
diff -u <(extract_tf dedicated_agent_sa_roles) <(extract_ts DEDICATED_AGENT_SA_ROLES) >/dev/null || {
  echo 'dedicated-iam-shape: Dedicated Agent roles differ between Terraform and TypeScript' >&2
  exit 1
}
# Six, not the five of the original list: a Dedicated OP serves /xaa/subject-token, which
# redeems a refresh token at the Human IdP as the confidential client `agent-platform`
# (DEC-ID-19), so it must be able to read that one client secret.
[[ $(extract_tf dedicated_op_sa_roles | wc -l) -eq 6 ]] || { echo 'dedicated-iam-shape: OP role count must be 6' >&2; exit 1; }
[[ $(extract_tf dedicated_agent_sa_roles | wc -l) -eq 6 ]] || { echo 'dedicated-iam-shape: Agent role count must be 6' >&2; exit 1; }
echo 'dedicated-iam-shape: Terraform and TypeScript role lists match'
