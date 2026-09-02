#!/usr/bin/env bash
# T-SEC-08. Defaults that are security decisions rather than conveniences.
#
# `security_events_delivery` defaults to pull because Security Detection runs with
# INTERNAL_ONLY ingress: a push subscription cannot reach it unless the DEC-SCOPE-02
# spike says otherwise, and pull also leaves the acknowledgement in the detector's hands
# so a failed run is redelivered rather than lost. A default of push would mean a fresh
# deployment silently drops every event it cannot deliver.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0

default_of() {
  # The `default` line inside the named variable block, and only that block.
  awk -v name="$1" '
    $0 ~ "^variable \"" name "\" \\{" { inside = 1; next }
    inside && /^}/ { inside = 0 }
    inside && $1 == "default" { print $3 }
  ' "$2" | tr -d '"'
}

delivery=$(default_of security_events_delivery infra/envs/demo/variables.tf)
if [ "$delivery" != "pull" ]; then
  echo "security events delivery defaults to pull, found '${delivery:-<none>}'" >&2
  status=1
fi

# Both values must stay reachable, so the spike's answer can be adopted without a code
# change; anything outside the pair is refused by the variable's own validation.
if ! grep -q 'contains(\["pull", "push"\], var.security_events_delivery)' infra/envs/demo/variables.tf; then
  echo 'security_events_delivery must be validated against exactly pull and push' >&2
  status=1
fi

# The push branch exists but is not the default path: it is the only thing that may name
# a push endpoint, and it must carry an OIDC token.
if ! grep -q 'var.security_events_delivery == "push"' infra/envs/demo/security-events.tf; then
  echo 'the push subscription must be conditional on security_events_delivery' >&2
  status=1
fi
if ! grep -q 'oidc_token' infra/envs/demo/security-events.tf; then
  echo 'a push subscription must authenticate with an OIDC token' >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "ok: security events delivery defaults to pull"
exit "$status"
