#!/usr/bin/env bash
set -euo pipefail

: "${REGISTRY:?REGISTRY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
# Cloud Run runs linux/amd64 only. A build on an Apple Silicon or other arm64 machine
# produces an arm64 image by default, which Cloud Run accepts at push time and refuses
# at start time, so the platform is pinned here rather than left to the host.
platform=${DOCKER_PLATFORM:-linux/amd64}
# The Dockerfile uses `COPY --parents` and `RUN --mount`, neither of which the classic
# builder understands. BuildKit has been the default since Docker 23; setting it here
# means a daemon that has it turned off still reads the file the way it was written.
export DOCKER_BUILDKIT=1
# How many images to build and push at once. Everything the images share is already a
# cache hit by the time the loop starts, so what runs in parallel is one `pnpm deploy`
# and one push per app — both of which wait on I/O rather than on the CPU.
jobs=${BUILD_JOBS:-4}
apps=(human-idp automation-app authorization provisioner lifecycle-manager agent-op security-detection resource-docs-as resource-docs-api resource-finance-as resource-finance-api agent-runtime jwks-publish seed google-bridge stub-saas-op stub-saas-api)
total=${#apps[@]}

# Every image is the same install and the same workspace compile with one `pnpm deploy`
# on top. Building that shared prefix once, under a tag of its own, is what keeps the
# per-app builds below down to their own layers: without it the images either recompile
# the workspace each time or race each other to produce the identical layers.
warmup=(docker build --platform "$platform" --target build -t xaa-workspace-build .)

build_and_push() {
  local app=$1
  docker build --platform "$platform" --build-arg "APP=$app" -t "$REGISTRY/$app:$IMAGE_TAG" .
  docker push "$REGISTRY/$app:$IMAGE_TAG"
}

if [[ "${DRY_RUN:-0}" == 1 ]]; then
  printf '\n[build-images] [0/%d] shared workspace build\n' "$total"
  echo "${warmup[*]}"
  index=0
  while (( index < total )); do
    app=${apps[index]}
    index=$((index + 1))
    printf '\n[build-images] [%d/%d] %s\n' "$index" "$total" "$app"
    echo "docker build --platform $platform --build-arg APP=$app -t $REGISTRY/$app:$IMAGE_TAG ."
    echo "docker push $REGISTRY/$app:$IMAGE_TAG"
  done
  exit 0
fi

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

printf '\n[build-images] [0/%d] shared workspace build\n' "$total"
"${warmup[@]}"

# The apps run `jobs` at a time. Each one's output goes to a file and is printed when its
# batch finishes, because the alternative — four builds writing to the same terminal — is
# unreadable exactly when a failure needs reading.
index=0
while (( index < total )); do
  batch_start=$index
  count=0
  pids=""
  while (( count < jobs && index < total )); do
    app=${apps[index]}
    index=$((index + 1))
    count=$((count + 1))
    printf '\n[build-images] [%d/%d] %s\n' "$index" "$total" "$app"
    build_and_push "$app" >"$logs/$app.log" 2>&1 &
    pids="$pids $!"
  done
  status=0
  for pid in $pids; do
    if ! wait "$pid"; then status=1; fi
  done
  cursor=$batch_start
  while (( cursor < index )); do
    app=${apps[cursor]}
    cursor=$((cursor + 1))
    printf '\n[build-images] --- %s ---\n' "$app"
    cat "$logs/$app.log"
  done
  if (( status != 0 )); then
    echo '[build-images] a build or push failed; its output is above' >&2
    exit 1
  fi
done
