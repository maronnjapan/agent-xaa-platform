#!/usr/bin/env bash
set -euo pipefail

grep -qE 'secret_id = "google-oauth-client-secret"' infra/envs/shared/secrets.tf || { echo 'secret-iam: OAuth secret is missing' >&2; exit 1; }
[[ $(find infra -name '*.tf' -not -path '*/.terraform/*' -print0 | xargs -0 -r grep -lE 'roles/secretmanager\.secretAccessor' | wc -l) -eq 1 ]] || {
  echo 'secret-iam: secretAccessor must be granted in one scoped resource only' >&2
  exit 1
}
grep -qE 'module.service_accounts\["google_bridge"\].member' infra/envs/demo/iam-secrets.tf || {
  echo 'secret-iam: only the bridge may read the OAuth secret' >&2
  exit 1
}
