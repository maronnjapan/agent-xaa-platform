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
dry_run=0
[[ "${DRY_RUN:-0}" == 1 ]] && dry_run=1

# The 17 images differ only in which app `pnpm deploy` cuts out of the workspace; the
# install and the `pnpm build` above it are one stage they all share. Building that stage
# by itself first makes it a cache hit for every image that follows, so the workspace is
# compiled once instead of 17 times, and a compile error is reported here as a single
# readable failure instead of as the first of 17 identical ones.
warm_shared_stage() {
  printf '\n[build-images] compiling the shared stage once, before the %d images\n' "$total"
  # A fixed local tag keeps this at one named image instead of a new dangling one per run.
  local command="docker build --platform $platform --target build -t xaa-build-stage:current ."
  if ((dry_run)); then echo "$command"; else bash -c "$command"; fi
}

# What is left per app is `pnpm deploy`, which is disk-bound, and `docker push`, which is
# network-bound. They do not contend for the same resource, so overlapping a few apps is
# most of the remaining wall clock. BUILD_JOBS=1 restores the strictly sequential order.
resolve_jobs() {
  if [[ -n ${BUILD_JOBS:-} ]]; then
    [[ "$BUILD_JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "BUILD_JOBS must be a positive integer" >&2; exit 2; }
    echo "$BUILD_JOBS"
    return
  fi
  local cpus
  cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
  [[ "$cpus" =~ ^[1-9][0-9]*$ ]] || cpus=2
  echo $((cpus < 4 ? cpus : 4))
}

# Parallel builds interleave their output, so each app writes to its own file and reports
# a single line when it is done. A failing app prints its log, because the reason a build
# failed is the only thing worth reading out of 17 of them.
build_and_push_app() {
  local app=$1
  # `local x=$1 y=$x` cannot work: the shell expands every word before the builtin
  # assigns any of them, so $x is still unset there and `set -u` aborts the job.
  local log=$log_dir/$app.log
  local started elapsed finished
  started=$(date +%s)
  local commands=(
    "docker build --platform $platform --build-arg APP=$app -t $REGISTRY/$app:$IMAGE_TAG ."
    "docker push $REGISTRY/$app:$IMAGE_TAG"
  )
  local command
  for command in "${commands[@]}"; do
    if ((dry_run)); then
      echo "$command"
    elif ! bash -c "$command" >>"$log" 2>&1; then
      printf '\n[build-images] FAILED %s: %s\n' "$app" "$command" >&2
      tail -n 100 "$log" >&2
      return 1
    fi
  done
  elapsed=$(($(date +%s) - started))
  : >"$done_dir/$app"
  finished=$(find "$done_dir" -type f | wc -l | tr -d ' ')
  printf '[build-images] [%s/%d] %s (%ds)\n' "$finished" "$total" "$app" "$elapsed"
}

log_dir=$(mktemp -d)
done_dir=$log_dir/done
mkdir -p "$done_dir"
failed=()
cleanup() { ((${#failed[@]})) || rm -rf "$log_dir"; }
trap cleanup EXIT

jobs=$(resolve_jobs)
# Dry run exists to show the commands, so it keeps them in the declared order.
((dry_run)) && jobs=1

warm_shared_stage

printf '\n[build-images] building and pushing %d images, %d at a time\n' "$total" "$jobs"

index=0
while ((index < total)) && ((${#failed[@]} == 0)); do
  pids=()
  names=()
  for ((slot = 0; slot < jobs && index < total; slot++, index++)); do
    build_and_push_app "${apps[index]}" &
    pids+=("$!")
    names+=("${apps[index]}")
  done
  for ((slot = 0; slot < ${#pids[@]}; slot++)); do
    wait "${pids[slot]}" || failed+=("${names[slot]}")
  done
done

if ((${#failed[@]})); then
  printf '\n[build-images] stopped after %d failed: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  printf '[build-images] full logs: %s\n' "$log_dir" >&2
  exit 1
fi
printf '\n[build-images] all %d images built and pushed at tag %s\n' "$total" "$IMAGE_TAG"
