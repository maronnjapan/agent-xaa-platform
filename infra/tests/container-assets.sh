#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

for directory in security-rules demo-scenarios; do
  grep -qF "COPY $directory ./$directory" Dockerfile || {
    echo "container-assets: build image is missing $directory" >&2
    exit 1
  }
done

grep -qF 'COPY --from=build /workspace/security-rules /security-rules' Dockerfile || {
  echo 'container-assets: runtime image is missing /security-rules' >&2
  exit 1
}
grep -qF 'COPY --from=build /workspace/demo-scenarios ./demo-scenarios' Dockerfile || {
  echo 'container-assets: runtime image is missing /app/demo-scenarios' >&2
  exit 1
}

echo 'ok: repository-level runtime assets are present in the container image'
