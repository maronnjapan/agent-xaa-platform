#!/usr/bin/env bash
# T-PROV-22 / RULE-22 / RULE-38. An Agent Client Credential's private half exists in
# this process's memory and in one Job Execution's environment. Nowhere else.
#
# Two shapes would break that, and both are checked here:
#   - a Secret Manager client, which is how a key gets somewhere durable;
#   - a Firestore `set`/`update`/`create` whose payload names the private JWK.
#
# The IAM binding in dedicated.ts names a Secret Manager *resource* so the dedicated OP
# can read the shared `agent-platform` client secret. Granting a role is not holding a
# key, so the check looks for the client and the import, not for the word.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0

clients=$(grep -rn "@google-cloud/secret-manager\|SecretManagerServiceClient\|AccessSecretVersion\|accessSecretVersion" apps/provisioner/src || true)
if [ -n "$clients" ]; then
  echo "$clients" >&2
  echo "the Provisioner must not hold a Secret Manager client: an agent key has nowhere to be stored" >&2
  status=1
fi

persisted=$(grep -rn "\.\(set\|update\|create\)(" apps/provisioner/src \
  | grep -i "privatejwk\|private_jwk\|privatekey" || true)
if [ -n "$persisted" ]; then
  echo "$persisted" >&2
  echo "a private JWK must never be handed to a document write" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then echo "ok: no path persists an agent private key"; fi
exit "$status"
