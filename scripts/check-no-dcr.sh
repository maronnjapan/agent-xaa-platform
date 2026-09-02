#!/usr/bin/env bash
# T-PROV-30 / RULE-50 / DEC-ID-22. There is one registered client, `agent-platform`,
# and provisioning an agent does not create another.
#
# Dynamic Client Registration would give every agent a client record at Human IdP and
# at both Resource AS, which is a registration to revoke on every expiry and a secret
# to hold for every agent. An agent is identified by `cnf.jkt`, by `act` and by the
# audit log instead — none of which needs a client of its own.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0

endpoints=$(grep -rn "registration_endpoint\|register_client\|dynamic_client_registration" apps/provisioner/src || true)
if [ -n "$endpoints" ]; then
  echo "$endpoints" >&2
  echo "the Provisioner must not reach a client registration endpoint" >&2
  status=1
fi

paths=$(grep -rnE "['\"\`][^'\"\`]*/register([/?'\"\`]|\$)" apps/provisioner/src || true)
if [ -n "$paths" ]; then
  echo "$paths" >&2
  echo "no /register URL may be built here" >&2
  status=1
fi

secrets=$(grep -rnE "client_secret[[:space:]]*[:=][^=]" apps/provisioner/src || true)
if [ -n "$secrets" ]; then
  echo "$secrets" >&2
  echo "the Provisioner mints no client secret" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then echo "ok: no client registration is created"; fi
exit "$status"
