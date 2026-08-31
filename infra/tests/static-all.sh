#!/usr/bin/env bash
set -uo pipefail

checks=(single-project cloud-run-defaults endpoints-shape service-inventory job-env no-cloudsql no-firestore-rules public-surface runtime-mutation-scope no-kms-key-version kms-iam no-dedicated-op-in-tf dedicated-iam-shape jwks-bucket secret-iam activity-topic one-way-sink audit-iam vertex-scope no-secret-fields no-firestore-sdk-in-frontend)
status=0
for check in "${checks[@]}"; do
  echo "[infra-static] $check"
  if ! bash "infra/tests/$check.sh"; then status=1; fi
done
exit "$status"
