#!/usr/bin/env bash
# Terraform owns the Secret Manager containers, never their values (T-IAC-13). Cloud Run
# mounts the Human IdP's client secrets as environment variables, so a container without
# an enabled version stops the revision from becoming ready and fails the demo apply. An
# unattended deploy therefore has to fill in what is missing, generating the value here
# and never printing it. An existing version is reused, because rotating one is a
# deliberate operation rather than a side effect of deploying.
#
# Which containers those are comes from Terraform's own list, read by
# scripts/human-idp-client-secrets.sh. A copy kept here would go stale the day a client is
# added, and it did: the Analysis Console's secret was declared and mounted while this
# script still named the two that came before it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

project_id=${PROJECT_ID:?PROJECT_ID is required}

# `while read` rather than `mapfile`, because macOS still ships the bash that has no
# `mapfile` and `make ensure-secrets` is run from there too.
while read -r secret; do
  # `</dev/null` so the loop keeps its own stdin: a gcloud that decided to read from it
  # would end the loop early, and the containers left behind would be the silent kind
  # this script exists to rule out.
  if [[ -n $(gcloud secrets versions list "$secret" --project="$project_id" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null </dev/null) ]]; then
    printf 'ensure-secret-versions: %s already has an enabled version\n' "$secret"
    continue
  fi
  printf 'ensure-secret-versions: adding a generated version to %s\n' "$secret"
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "$secret" --project="$project_id" --data-file=- >/dev/null
done < <(bash scripts/human-idp-client-secrets.sh)

# google-oauth-client-secret is deliberately absent. Its value comes from the Google Auth
# Platform console, so only a run that enables the Bridge can supply it, and that run
# goes through scripts/deploy-gcp-guide.sh where the operator can hand the file over.
