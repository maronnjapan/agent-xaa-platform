#!/usr/bin/env bash
# DEV-13: the browser never talks to Firestore directly. The control is that no
# Firebase or Firestore SDK reaches the bundle, so the browser sources and the
# esbuild output are scanned for it. Comments are stripped first — a file may explain
# why the SDK is absent without that explanation counting as the SDK being present.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Every directory that ends up in the browser. `src/client` is the esbuild entry point
# and `client/src` the modules it pulls in; scanning only one of them leaves the other
# free to import the SDK this control exists to keep out (T-IAC-44).
roots=(apps/automation-app/src/client apps/automation-app/client/src apps/automation-app/public)
for root in "${roots[@]}"; do
  [[ -d "$root" ]] || { echo "missing scan root: $root" >&2; exit 1; }
done

if ! node scripts/checks/code-grep.mjs 'firebase|@firebase|firestore\.googleapis\.com|onSnapshot' "${roots[@]}" >&2; then
  echo 'Firestore SDK is forbidden in browser assets' >&2
  exit 1
fi
echo "ok: no datastore SDK reaches the browser"
