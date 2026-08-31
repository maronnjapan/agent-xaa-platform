#!/usr/bin/env bash
# DEV-13: the browser never talks to Firestore directly. The control is that no
# Firebase or Firestore SDK reaches the bundle, so the browser sources and the
# esbuild output are scanned for it. Comments are stripped first — a file may explain
# why the SDK is absent without that explanation counting as the SDK being present.
set -euo pipefail
cd "$(dirname "$0")/../.."

roots=(apps/automation-app/client/src apps/automation-app/public)
for root in "${roots[@]}"; do
  [[ -d "$root" ]] || { echo "missing scan root: $root" >&2; exit 1; }
done

if ! node scripts/checks/code-grep.mjs 'firebase|@firebase|firestore\.googleapis\.com|onSnapshot' "${roots[@]}" >&2; then
  echo 'Firestore SDK is forbidden in browser assets' >&2
  exit 1
fi
echo "ok: no datastore SDK reaches the browser"
