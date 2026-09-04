#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

services=infra/envs/demo/services.tf
shared=infra/envs/shared/outputs.tf

require_key() {
  local key=$1
  grep -qE "^[[:space:]]+$key[[:space:]]*=" "$services" || {
    echo "service-env-contract: Terraform does not inject $key" >&2
    return 1
  }
}

# Required by the production loadConfig/loadEnv paths. Cloud Run supplies PORT.
required=(
  PROJECT_ID GOOGLE_CLOUD_PROJECT REGION PLATFORM_ENDPOINTS_URI STORE_MODE PUBSUB_MODE
  SIGNER_MODE VERTEX_MODE VERTEX_MODEL VERTEX_LOCATION FIRESTORE_DATABASE ISSUER
  ISSUER_PROFILE JWKS_PUBLIC_BASE_URL KEY_BUCKET KMS_SSO_KEY_NAME DPOP_REQUIRED
  AUTOMATION_APP_REDIRECT_URI AGENT_OP_CALLBACK_URI ACCESS_TOKEN_EXPIRES_IN
  CLIENT_SECRET_AUTOMATION_APP CLIENT_SECRET_AGENT_PLATFORM MODE XAA_CLIENT_ID
  JWKS_BUCKET JWKS_OBJECT KMS_IDJAG_KEY KMS_IDP_CONNECTION_KEY
  HUMAN_IDP_AUTHORIZE_URL HUMAN_IDP_TOKEN_URL HUMAN_IDP_REVOKE_URL
  ID_JAG_LIFETIME_SECONDS PUBLIC_BASE_URL AUTHORIZATION_PLATFORM_URL
  AGENT_PROVISIONER_URL LIFECYCLE_MANAGER_URL DOCS_API_URL ACTIVITY_TOPIC JWKS_URL
  AUTHZ_AUDIENCE TAXONOMY_VERSION AGENT_MAX_LIFETIME_SECONDS PROVISIONER_AUDIENCE
  SHARED_AGENT_OP_URL STANDARD_JOB_NAME MAX_FULL_ISOLATION_AGENTS IDJAG_KEY_RING
  IDP_CONNECTION_KEY_RING AGENT_OP_IMAGE AGENT_RUNTIME_IMAGE DEDICATED_OP_ENV
  PLATFORM_ENDPOINTS_JSON AS_KIND RESOURCE TRUSTED_IDP_ISSUER TRUSTED_IDP_JWKS_URI
  REGISTERED_SCOPES SIGNING_KEY_BUCKET SIGNING_KEY_OBJECT SIGNING_KEY_KMS_KEY JWKS_KEY_PREFIX
  AS_ISSUER LIFECYCLE_SA_EMAIL FINANCE_ABSOLUTE_MAX_AMOUNT REQUIRE_ISOLATION_LEVEL
  SECURITY_EVENTS_SUBSCRIPTION
  IDENTITY_DISABLED_SUBSCRIPTION AUTOMATION_APP_URL
)

for key in "${required[@]}"; do require_key "$key"; done

grep -q 'shared_agent_op_idjag.*cryptoKeyVersions/1' "$shared" || {
  echo 'service-env-contract: Agent OP needs a KMS CryptoKeyVersion, not a CryptoKey' >&2
  exit 1
}

# The absent-endpoint sentinel is a contract between Terraform and the readers of
# endpoints.json (packages/xaa-contracts DISABLED_ENDPOINT). If one side changes it, a
# disabled service becomes a real request to a host that does not resolve.
sentinel=$(grep -oE "'https://disabled\\.invalid'" packages/xaa-contracts/src/schema/platform-endpoints.schema.ts | head -1)
[[ -n "$sentinel" ]] && grep -q 'https://disabled.invalid' infra/envs/demo/locals-endpoints.tf || {
  echo 'service-env-contract: the disabled-endpoint sentinel differs between Terraform and the contract' >&2
  exit 1
}

for obsolete in ALLOWED_SCOPES SIGNING_KEY_WRAP_KMS_KEY; do
  if grep -qE "^[[:space:]]+$obsolete[[:space:]]*=" "$services"; then
    echo "service-env-contract: obsolete variable remains: $obsolete" >&2
    exit 1
  fi
done

echo 'ok: Terraform covers every production startup environment contract'
