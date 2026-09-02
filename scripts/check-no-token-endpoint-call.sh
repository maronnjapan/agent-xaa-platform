#!/usr/bin/env bash
# T-PROV-23 / RULE-51. The Refresh Token belongs to the Agent OP alone. The Provisioner
# asks for a connection and asks whether it is ready; it never redeems a code itself.
#
# The moment this app called Human IdP's `/token`, it would hold a refresh token — for
# however short a time, in whatever variable — and the single-holder property that the
# whole delegation model rests on would be gone.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rn "/token" apps/provisioner/src \
  | grep -i "issuer\|human-idp\|humanidp\|idp_token\|idpToken" || true)

if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "only the Agent OP may call the Human IdP token endpoint" >&2
  exit 1
fi
echo "ok: the Provisioner calls no token endpoint"
