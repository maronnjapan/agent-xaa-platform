#!/usr/bin/env bash
set -uo pipefail

project_id=${PROJECT_ID:-}
region=${REGION:-asia-northeast1}
[[ -n "$project_id" ]] || { echo 'destroy-residue: PROJECT_ID is required' >&2; exit 2; }
status=0
check_empty() {
  local label=$1
  shift
  local output
  output=$("$@") || { echo "destroy-residue: failed to list $label" >&2; exit 2; }
  if [[ -n "$output" ]]; then
    printf 'destroy-residue / %s / %s\n' "$label" "$output" >&2
    status=1
  fi
}
check_empty services gcloud run services list --project="$project_id" --region="$region" --format='value(metadata.name)'
check_empty jobs gcloud run jobs list --project="$project_id" --region="$region" --format='value(metadata.name)'
check_empty buckets gcloud storage buckets list --project="$project_id" --filter='name~(jwks|platform-config)' --format='value(name)'
check_empty topics gcloud pubsub topics list --project="$project_id" --format='value(name)'
check_empty scheduler gcloud scheduler jobs list --project="$project_id" --location="$region" --format='value(name)'
exit "$status"
