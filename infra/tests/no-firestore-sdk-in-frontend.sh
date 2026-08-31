#!/usr/bin/env bash
# DEV-13: the browser never talks to Firestore directly. The control is that no
# Firebase or Firestore SDK reaches the bundle, so the browser sources and the
# esbuild output are scanned for it.
set -euo pipefail

roots=(apps/automation-app/src/client apps/automation-app/public)
for root in "${roots[@]}"; do
  [[ -d "$root" ]] || { echo "missing scan root: $root" >&2; exit 1; }
done

files=()
while IFS= read -r file; do files+=("$file"); done < <(find "${roots[@]}" -type f | sort)
if ((${#files[@]} == 0)); then
  echo 'no browser assets found to inspect' >&2
  exit 1
fi

if grep -niE 'firebase|@firebase|firestore' "${files[@]}"; then
  echo 'Firestore SDK is forbidden in browser assets' >&2
  exit 1
fi
