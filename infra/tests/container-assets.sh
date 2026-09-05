#!/usr/bin/env bash
# The two directories that are read at module initialization but belong to the
# repository rather than to any package, so `pnpm deploy` does not carry them.
#
# They are asserted by the line that puts each one where its reader looks, not by the
# stage it comes from: security-rules has to exist while `pnpm build` runs, because
# security-detection imports the JSON, and it has to exist again at `/security-rules`
# in the final image, because that is where the emitted imports resolve. Both now come
# straight from the build context — routing runtime-only data through an earlier stage
# would put it upstream of the install and the compile, and every edit to a rule would
# invalidate both.
set -euo pipefail
cd "$(dirname "$0")/../.."

required=(
  # tsc compiles security-detection against the rules.
  'COPY security-rules ./security-rules'
  # The runtime image, where the emitted imports resolve them.
  'COPY security-rules /security-rules'
  # Automation App discovers the scenarios below its /app workdir.
  'COPY demo-scenarios ./demo-scenarios'
)
for line in "${required[@]}"; do
  grep -qF "$line" Dockerfile || {
    echo "container-assets: Dockerfile is missing \`$line\`" >&2
    exit 1
  }
done

echo 'ok: repository-level runtime assets are present in the container image'
