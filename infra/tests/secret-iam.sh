#!/usr/bin/env bash
# T-IAC-23. The external OAuth client secret is the Bridge's alone.
#
# The rule is about that one secret, not about the word secretAccessor: the Human IdP's
# own client secrets are read by the Human IdP, the Automation App and the Agent OP,
# which is what makes those clients confidential in the first place. So the check reads
# the grants and asks who may reach which secret, rather than counting occurrences.
set -euo pipefail

secrets=infra/envs/shared/secrets.tf
grants=infra/envs/demo/iam-secrets.tf

grep -qE 'secret_id = "google-oauth-client-secret"' "$secrets" || { echo 'secret-iam: OAuth secret is missing' >&2; exit 1; }

# Every grant of the role lives in one file, so there is one place to read the answer.
elsewhere=$(find infra -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -lE '^resource "google_secret_manager_secret_iam_member"' | grep -v "^$grants$" || true)
[[ -z "$elsewhere" ]] || {
  echo "secret-iam: secret IAM members belong in $grants, found in: $elsewhere" >&2
  exit 1
}

# The OAuth secret's grants, by member. Exactly one, and it is the Bridge.
oauth_members=$(awk '
  /^resource "google_secret_manager_secret_iam_member"/ { block = ""; }
  { block = block $0 "\n"; }
  /^}/ {
    if (block ~ /google_oauth_client_secret/ && block ~ /secretmanager\.secretAccessor/) print block;
    block = "";
  }
' "$grants" | grep -oE 'module\.service_accounts\["[a-z_]+"\]' | sort -u)

[[ "$oauth_members" == 'module.service_accounts["google_bridge"]' ]] || {
  echo "secret-iam: only the bridge may read the OAuth secret, found: ${oauth_members:-none}" >&2
  exit 1
}

echo 'ok: the OAuth client secret is readable by the bridge alone'
