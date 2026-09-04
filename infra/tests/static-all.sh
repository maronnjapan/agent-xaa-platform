#!/usr/bin/env bash
set -uo pipefail

checks=(single-project cloud-run-defaults container-assets deploy-guide-firestore deploy-guide-oidc-client endpoints-shape service-inventory job-env service-env-contract signing-key-storage no-cloudsql no-firestore-rules public-surface runtime-mutation-scope no-kms-key-version kms-iam no-dedicated-op-in-tf dedicated-iam-shape issuer-profile jwks-bucket secret-iam activity-topic one-way-sink audit-iam vertex-scope no-secret-fields no-firestore-sdk-in-frontend no-runtime-service runtime-sa-roles agent-op-roles automation-app-roles bridge-disabled-plan audit-views security-detection-inbound variable-defaults)
status=0
for check in "${checks[@]}"; do
  echo "[infra-static] $check"
  if ! bash "infra/tests/$check.sh"; then status=1; fi
done
exit "$status"
