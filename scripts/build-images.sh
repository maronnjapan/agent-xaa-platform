#!/usr/bin/env bash
set -euo pipefail

: "${REGISTRY:?REGISTRY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
apps=(human-idp automation-app authorization provisioner lifecycle-manager agent-op security-detection resource-docs-as resource-docs-api resource-finance-as resource-finance-api agent-runtime jwks-publish seed google-bridge stub-saas-op stub-saas-api)
for app in "${apps[@]}"; do
  commands=(
    "docker build --build-arg APP=$app -t $REGISTRY/$app:$IMAGE_TAG ."
    "docker push $REGISTRY/$app:$IMAGE_TAG"
  )
  for command in "${commands[@]}"; do
    if [[ "${DRY_RUN:-0}" == 1 ]]; then echo "$command"; else bash -c "$command"; fi
  done
done
