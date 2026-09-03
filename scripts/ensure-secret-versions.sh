#!/usr/bin/env bash
# Terraform owns the Secret Manager containers, never their values (T-IAC-13). Cloud Run
# mounts two of them as environment variables, so a container without an enabled version
# stops the revision from becoming ready and fails the demo apply. An unattended deploy
# therefore has to fill in what is missing, generating the value here and never printing
# it. An existing version is reused, because rotating one is a deliberate operation
# rather than a side effect of deploying.
set -euo pipefail

project_id=${PROJECT_ID:?PROJECT_ID is required}
secrets=(human-idp-automation-client-secret human-idp-agent-platform-client-secret)

for secret in "${secrets[@]}"; do
  if [[ -n $(gcloud secrets versions list "$secret" --project="$project_id" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null) ]]; then
    printf 'ensure-secret-versions: %s already has an enabled version\n' "$secret"
    continue
  fi
  printf 'ensure-secret-versions: adding a generated version to %s\n' "$secret"
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "$secret" --project="$project_id" --data-file=- >/dev/null
done

# google-oauth-client-secret is deliberately absent. Its value comes from the Google Auth
# Platform console, so only a run that enables the Bridge can supply it, and that run
# goes through scripts/deploy-gcp-guide.sh where the operator can hand the file over.
