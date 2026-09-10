#!/usr/bin/env bash
# T-APP-33 / DEV-13. The page polls on open and on refresh. A live channel would need
# the browser to hold a connection to something, and the only thing worth streaming
# from is the datastore — which the browser must never reach.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The bundle is build output and is not committed. Scanning a directory that has not
# been built would pass without having read the code this rule is about.
[ -f apps/automation-app/public/app.js ] || {
  echo 'apps/automation-app/public/app.js is missing; run pnpm build before this check' >&2
  exit 1
}

for target in apps/automation-app/public apps/automation-app/client/src; do
  [ -e "$target" ] || continue
  if ! node scripts/checks/code-grep.mjs 'new WebSocket|EventSource|onSnapshot|setInterval' "$target" >&2; then
    echo "the timeline must not hold a persistent connection" >&2
    exit 1
  fi
done
echo "ok: the timeline polls on open and on refresh only"
