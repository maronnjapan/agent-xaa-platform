#!/usr/bin/env bash
set -euo pipefail

if find infra apps packages \( -name '*.tf' -o -name '*.ts' -o -name '*.json' \) \
  -not -path 'infra/tests/*' -not -path '*/node_modules/*' -not -path '*/.terraform/*' -not -path '*/dist/*' -print0 \
  | xargs -0 -r grep -nE 'google_sql_|sqladmin\.googleapis\.com|cloudsql'; then
  echo 'no-cloudsql: Cloud SQL is forbidden; the platform uses the named Firestore database' >&2
  exit 1
fi
