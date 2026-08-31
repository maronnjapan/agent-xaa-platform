#!/usr/bin/env bash
set -uo pipefail

command -v gcloud >/dev/null && command -v jq >/dev/null || { echo 'forbidden-roles: gcloud and jq are required' >&2; exit 2; }
project_id=${PROJECT_ID:-}
region=${REGION:-asia-northeast1}
[[ -n "$project_id" ]] || { echo 'forbidden-roles: PROJECT_ID is required' >&2; exit 2; }
jq -e '.exceptions | all(.member != "" and .role != "" and .resource != "" and .reason != "")' infra/tests/forbidden-roles.json >/dev/null || {
  echo 'forbidden-roles: every exception needs member, role, resource, and reason' >&2
  exit 1
}

forbidden=$(jq -r '.roles[]' infra/tests/forbidden-roles.json)
status=0
check_policy() {
  local resource=$1 policy=$2
  while IFS=$'\t' read -r role member; do
    [[ "$member" == serviceAccount:sa-* ]] || continue
    if grep -Fxq "$role" <<<"$forbidden"; then
      short=${member#serviceAccount:}; short=${short%%@*}
      if ! jq -e --arg m "$short" --arg r "$role" --arg resource "$resource" '.exceptions[] | select(.member==$m and .role==$r and ($resource|contains(.resource)))' infra/tests/forbidden-roles.json >/dev/null; then
        printf 'forbidden-role / %s / %s / %s\n' "$short" "$role" "$resource" >&2
        status=1
      fi
    fi
  done < <(jq -r '.bindings[]? as $b | $b.members[]? | [$b.role, .] | @tsv' <<<"$policy")
}

project_policy=$(gcloud projects get-iam-policy "$project_id" --format=json) || exit 2
check_policy "projects/$project_id" "$project_policy"
dataset_policy=$(bq --project_id="$project_id" show --format=prettyjson "$project_id:security_audit" 2>/dev/null || printf '{"access":[]}')
while IFS=$'\t' read -r role member; do
  check_policy "datasets/security_audit" "$(jq -nc --arg r "$role" --arg m "$member" '{bindings:[{role:$r,members:[$m]}]}')"
done < <(jq -r '.access[]? | select(.userByEmail) | [.role, ("serviceAccount:"+.userByEmail)] | @tsv' <<<"$dataset_policy")
while IFS= read -r ring; do
  while IFS= read -r key; do
    policy=$(gcloud kms keys get-iam-policy "$key" --keyring="$ring" --location="$region" --project="$project_id" --format=json) || exit 2
    check_policy "keyRings/$ring/cryptoKeys/$key" "$policy"
  done < <(gcloud kms keys list --keyring="$ring" --location="$region" --project="$project_id" --format='value(name.basename())')
done < <(gcloud kms keyrings list --location="$region" --project="$project_id" --format='value(name.basename())')
exit "$status"
