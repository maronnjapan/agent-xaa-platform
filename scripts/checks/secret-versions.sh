#!/usr/bin/env bash
# Every Secret Manager container Cloud Run mounts has to be given a first version before
# the apply that mounts it, or the revision never becomes ready and the deploy fails on a
# service that looks broken and is not. This is what the deploy failed on for five commits
# after the Analysis Console arrived: Terraform declared and mounted its client secret,
# and the unattended path still named the two that came before it.
#
# So the invariant checked here is the one that broke — every Human IdP client secret
# services.tf mounts is one the two paths that create versions actually reach — not that
# three particular names appear somewhere. Naming them here would make this check the
# fourth copy of the list.
set -euo pipefail
cd "$(dirname "$0")/../.."

services=infra/envs/demo/services.tf
secrets=infra/envs/shared/secrets.tf
status=0

filled=$(bash scripts/human-idp-client-secrets.sh) || {
  echo 'secret-versions: the secret ids can no longer be read from Terraform' >&2
  exit 1
}

# What Cloud Run mounts, by the key each `secret_env` entry names.
mounted=$(grep -oE 'human_idp_client_secret_ids\.[a-z_]+' "$services" | cut -d. -f2 | sort -u)
[[ -n $mounted ]] || {
  echo "secret-versions: no Human IdP client secret is mounted in $services" >&2
  exit 1
}

for key in $mounted; do
  # The container id Terraform gives that key.
  id=$(awk -v key="$key" '
    /human_idp_client_secrets[[:space:]]*=[[:space:]]*\{/ { inside = 1; next }
    inside && /^[[:space:]]*\}/ { inside = 0 }
    inside && $1 == key && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2) }
  ' "$secrets")
  if [[ -z $id ]]; then
    echo "secret-versions: $services mounts $key, which $secrets does not declare" >&2
    status=1
  elif ! grep -Fxq "$id" <<<"$filled"; then
    echo "secret-versions: $id is mounted but no deploy path gives it a version" >&2
    status=1
  fi
done

# Both paths have to read that list rather than hold a copy of it, which is the only
# reason the loop above can trust one answer for both. The invocation is what is looked
# for, not the path: both scripts also name it in a comment, and a comment is what would
# be left behind by the change this is here to catch.
for path in scripts/ensure-secret-versions.sh scripts/deploy-gcp-guide.sh; do
  grep -Fq 'bash scripts/human-idp-client-secrets.sh' "$path" || {
    echo "secret-versions: $path no longer reads the declared secret ids" >&2
    status=1
  }
done

[ "$status" -eq 0 ] && echo 'ok: every mounted Human IdP client secret is given a version before it is mounted'
exit "$status"
