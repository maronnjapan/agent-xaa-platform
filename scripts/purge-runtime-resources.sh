#!/usr/bin/env bash
set -euo pipefail

project_id=${PROJECT_ID:?PROJECT_ID is required}
region=${REGION:-asia-northeast1}
label='xaa-managed=runtime'

while IFS= read -r service; do
  [[ -n "$service" ]] && gcloud run services delete "$service" --project="$project_id" --region="$region" --quiet
done < <(gcloud run services list --project="$project_id" --region="$region" --filter="metadata.labels.${label}" --format='value(metadata.name)')
while IFS= read -r job; do
  [[ -n "$job" ]] && gcloud run jobs delete "$job" --project="$project_id" --region="$region" --quiet
done < <(gcloud run jobs list --project="$project_id" --region="$region" --filter="metadata.labels.${label}" --format='value(metadata.name)')
while IFS= read -r email; do
  [[ -n "$email" ]] && gcloud iam service-accounts delete "$email" --project="$project_id" --quiet
done < <(gcloud iam service-accounts list --project="$project_id" --filter='description:xaa-managed=runtime' --format='value(email)')

for ring in idjag-signing idp-connection-encryption; do
  while IFS= read -r key; do
    [[ "$key" == idjag-* || "$key" == idpconn-* ]] || continue
    while IFS= read -r version; do
      [[ -n "$version" ]] && gcloud kms keys versions destroy "$version" --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --quiet || true
    done < <(gcloud kms keys versions list --key="$key" --keyring="$ring" --location="$region" --project="$project_id" --filter='state=ENABLED' --format='value(name.basename())')
  done < <(gcloud kms keys list --keyring="$ring" --location="$region" --project="$project_id" --format='value(name.basename())')
done
