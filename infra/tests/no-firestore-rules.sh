#!/usr/bin/env bash
set -euo pipefail

mapfile -t matches < <(find . -type f \( -name 'firestore.rules' -o -name '*.rules' \) -not -path './node_modules/*' -not -path '*/.terraform/*')
if ((${#matches[@]})); then
  printf 'no-firestore-rules: forbidden rules file %s\n' "${matches[@]}" >&2
  exit 1
fi
grep -qE 'firestore_database_id[[:space:]]*=[[:space:]]*"xaa-db"' infra/envs/demo/firestore.tf || { echo 'no-firestore-rules: named database xaa-db is missing' >&2; exit 1; }
