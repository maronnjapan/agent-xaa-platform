#!/usr/bin/env bash
# T-BRIDGE-10 / RULE-22. The token route hands an agent a short-lived Access Token and
# nothing else. Building a refresh-token grant is `saas/refresh-grant.ts`'s job, so the
# word appearing in the response path means a long-lived credential is on its way out.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! node scripts/checks/code-grep.mjs 'refresh_token' apps/google-bridge/src/token >&2; then
  echo "the token response path must not name a refresh token" >&2
  exit 1
fi
echo "ok: no refresh token in the token response path"
