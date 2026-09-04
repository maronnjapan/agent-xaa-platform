#!/usr/bin/env bash
set -euo pipefail

guide=scripts/deploy-gcp-guide.sh

[[ $(grep -cE '^[[:space:]]+verify_automation_login_registration$' "$guide") -eq 2 ]] || {
  echo 'deploy-guide-oidc-client: deploy and verify must both check the login registration' >&2
  exit 1
}
grep -qF "scope=openid+profile" "$guide" || {
  echo 'deploy-guide-oidc-client: Automation App login scope is not pinned' >&2
  exit 1
}
grep -qF "error=invalid_scope" "$guide" || {
  echo 'deploy-guide-oidc-client: invalid_scope is not rejected' >&2
  exit 1
}
grep -qF 'apps/human-idp/src/config/scopes.ts' "$guide" || {
  echo 'deploy-guide-oidc-client: repair guidance does not identify the client scope registry' >&2
  exit 1
}

echo 'ok: deploy guide verifies the Automation App OIDC client scope registration'
