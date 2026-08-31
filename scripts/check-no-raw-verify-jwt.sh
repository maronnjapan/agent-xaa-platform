#!/usr/bin/env bash
# REQ-01-016 / DEC-ID-18: routes and middleware call one of the three typed
# verifiers, never a general-purpose verifyJwt, so the `typ` check cannot be skipped.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

targets=()
while IFS= read -r file; do targets+=("$file"); done < <(
  find apps -type d \( -name routes -o -name middleware \) -not -path '*/node_modules/*' -print0 \
    | xargs -0 -r -I{} find {} -name '*.ts' | sort
)
if ((${#targets[@]} == 0)); then
  echo 'check-no-raw-verify-jwt: no route or middleware sources found' >&2
  exit 1
fi

if grep -nE '\bverifyJwt(Internal)?\s*\(' "${targets[@]}"; then
  echo 'check-no-raw-verify-jwt: use verifyHumanAccessToken / verifyIdJag / verifyGoogleServiceIdentity' >&2
  exit 1
fi
