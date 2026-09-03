#!/usr/bin/env bash
# What the project may still hold after `make destroy-all`, measured against GCP rather
# than against Terraform state, because the point of the measurement is to catch what
# state does not know about.
#
# destroy-residue.sh answers a narrower question: whether one demo destroy left the
# runtime-owned resources behind. This one answers the whole question, so it also covers
# the shared state and the state bucket.
#
# KMS key rings and crypto keys are excluded because GCP never deletes them. Their key
# versions are only excluded when the teardown chose to keep them, which is the default:
# destroying version 1 is what makes a project permanently unable to run the platform
# again (DEC-IAC-04), so the choice is the caller's and this measures what was chosen.
set -uo pipefail

project_id=${PROJECT_ID:-}
region=${REGION:-asia-northeast1}
keep_state_bucket=${KEEP_STATE_BUCKET:-0}
keep_kms_key_versions=${KEEP_KMS_KEY_VERSIONS:-1}
[[ -n "$project_id" ]] || {
  echo 'destroy-all-residue: PROJECT_ID is required' >&2
  exit 2
}
status=0

report() {
  printf 'destroy-all-residue / %s / %s\n' "$1" "${2//$'\n'/ }" >&2
  status=1
}

# A listing that cannot run at all is not the same as an empty listing, so it fails the
# check rather than passing it quietly.
check_empty() {
  local label=$1 output
  shift
  output=$("$@" 2>/dev/null) || {
    echo "destroy-all-residue: failed to list $label" >&2
    status=2
    return
  }
  [[ -z "$output" ]] || report "$label" "$output"
}

# For APIs this platform never enables. Compute is only reachable when the issuer Load
# Balancer was reserved, so a failed listing there means there was nothing to reserve.
check_optional() {
  local label=$1 output
  shift
  output=$("$@" 2>/dev/null) || return 0
  [[ -z "$output" ]] || report "$label" "$output"
}

remaining_buckets() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$keep_state_bucket" == 1 && "$name" == "${project_id}-tfstate" ]] && continue
    printf '%s\n' "$name"
  done < <(gcloud storage buckets list --project="$project_id" --format='value(name)')
}

live_kms_key_versions() {
  local ring key
  while IFS= read -r ring; do
    [[ -n "$ring" ]] || continue
    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      gcloud kms keys versions list --key="$key" --keyring="$ring" --location="$region" --project="$project_id" \
        --filter='state=ENABLED OR state=DISABLED' --format='value(name)'
    done < <(gcloud kms keys list --keyring="$ring" --location="$region" --project="$project_id" --format='value(name.basename())')
  done < <(gcloud kms keyrings list --location="$region" --project="$project_id" --format='value(name.basename())')
}

remaining_datasets() {
  command -v bq >/dev/null 2>&1 || return 0
  bq --project_id="$project_id" --format=json ls --datasets 2>/dev/null | jq -r '.[]?.datasetReference.datasetId'
}

check_empty 'cloud run services' gcloud run services list --project="$project_id" --region="$region" --format='value(metadata.name)'
check_empty 'cloud run jobs' gcloud run jobs list --project="$project_id" --region="$region" --format='value(metadata.name)'
check_empty 'scheduler jobs' gcloud scheduler jobs list --project="$project_id" --location="$region" --format='value(name)'
check_empty 'pubsub topics' gcloud pubsub topics list --project="$project_id" --format='value(name)'
check_empty 'pubsub subscriptions' gcloud pubsub subscriptions list --project="$project_id" --format='value(name)'
check_empty 'firestore databases' gcloud firestore databases list --project="$project_id" --format='value(name)'
check_empty 'secrets' gcloud secrets list --project="$project_id" --format='value(name)'
check_empty 'artifact registry repositories' gcloud artifacts repositories list --project="$project_id" --location="$region" --format='value(name)'
check_empty 'logging sinks' gcloud logging sinks list --project="$project_id" --filter='name!=_Default AND name!=_Required' --format='value(name)'
check_empty 'custom roles' gcloud iam roles list --project="$project_id" --format='value(name)'
check_empty 'service accounts' gcloud iam service-accounts list --project="$project_id" --filter='email ~ ^sa-' --format='value(email)'
check_empty 'buckets' remaining_buckets
if [[ "$keep_kms_key_versions" == 1 ]]; then
  echo 'note: the shared KMS key versions were kept on purpose, so the project stays redeployable'
else
  check_empty 'kms key versions' live_kms_key_versions
fi
check_optional 'bigquery datasets' remaining_datasets
check_optional 'reserved global addresses' gcloud compute addresses list --project="$project_id" --global --format='value(name)'
check_optional 'managed ssl certificates' gcloud compute ssl-certificates list --project="$project_id" --format='value(name)'

if ((status == 0)); then
  echo 'ok: the project holds none of the resources this repository creates'
fi
exit "$status"
