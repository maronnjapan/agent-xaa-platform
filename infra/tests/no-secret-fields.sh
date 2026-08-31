#!/usr/bin/env bash
set -euo pipefail

roots=(infra/schema packages/xaa-contracts/schema)
for root in "${roots[@]}"; do [[ -d "$root" ]] || { echo "no-secret-fields: missing $root" >&2; exit 1; }; done
mapfile -t files < <(find "${roots[@]}" -type f \( -name '*.json' -o -name '*.md' \))
((${#files[@]} > 0)) || { echo 'no-secret-fields: no schemas found' >&2; exit 1; }
if grep -niE 'access_token|private_key|client_secret|id_token' "${files[@]}"; then
  echo 'no-secret-fields: raw secret field is present in a persistence schema' >&2
  exit 1
fi
if grep -niE 'refresh_token' "${files[@]}" | grep -vE 'refresh_token_(ciphertext|key_version)'; then
  echo 'no-secret-fields: refresh tokens must only appear as ciphertext plus key version' >&2
  exit 1
fi
