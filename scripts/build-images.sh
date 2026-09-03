#!/usr/bin/env bash
set -euo pipefail

: "${REGISTRY:?REGISTRY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
# Cloud Run runs linux/amd64 only. A build on an Apple Silicon or other arm64 machine
# produces an arm64 image by default, which Cloud Run accepts at push time and refuses
# at start time, so the platform is pinned here rather than left to the host.
platform=${DOCKER_PLATFORM:-linux/amd64}
apps=(human-idp automation-app authorization provisioner lifecycle-manager agent-op security-detection resource-docs-as resource-docs-api resource-finance-as resource-finance-api agent-runtime jwks-publish seed google-bridge stub-saas-op stub-saas-api)
total=${#apps[@]}
index=0
for app in "${apps[@]}"; do
  index=$((index + 1))
  printf '\n[build-images] [%d/%d] %s\n' "$index" "$total" "$app"
  commands=(
    "docker build --platform $platform --build-arg APP=$app -t $REGISTRY/$app:$IMAGE_TAG ."
    "docker push $REGISTRY/$app:$IMAGE_TAG"
  )
  for command in "${commands[@]}"; do
    if [[ "${DRY_RUN:-0}" == 1 ]]; then echo "$command"; else bash -c "$command"; fi
  done
done
