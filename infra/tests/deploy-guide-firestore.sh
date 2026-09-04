#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

guide=scripts/deploy-gcp-guide.sh

# perm:set executes checked-in build output. A mere existence check lets an old
# packages/gcp/dist keep an obsolete named-database default after a source change.
grep -Fq 'run "${pnpm_command[@]}" --filter '\''@xaa/authorization...'\'' build' "$guide" || {
  echo 'deploy-guide-firestore: perm:set dependencies are not rebuilt before execution' >&2
  exit 1
}
if grep -Fq '[[ -f apps/authorization/dist/perm-set-cli.js ]]' "$guide"; then
  echo 'deploy-guide-firestore: stale perm:set dist can still bypass the build' >&2
  exit 1
fi

# The demo uses a named Firestore database. Without this environment variable an
# older dist silently targets its old default and Firestore responds with NOT_FOUND.
grep -Fq 'run env GOOGLE_CLOUD_PROJECT="$PROJECT_ID" FIRESTORE_DATABASE=xaa-db STORE_MODE=gcp PUBSUB_MODE=gcp \' "$guide" || {
  echo 'deploy-guide-firestore: perm:set does not select the xaa-db database' >&2
  exit 1
}

echo 'ok: deploy guide rebuilds perm:set and selects the named Firestore database'
