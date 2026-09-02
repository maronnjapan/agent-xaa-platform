#!/usr/bin/env bash
# T-BRIDGE-20 / DEC-SCOPE-04. With enable_google_bridge=false — the default — none of the
# Bridge or stub services exist.
#
# Checked against the Terraform source rather than a live plan, because the check has to
# run in CI without credentials. `terraform plan -json` would answer the same question,
# and `infra/tests/verify-all.sh` asks it that way after an apply; here the two facts a
# plan would show are established from the configuration instead:
#
#   1. the flag's default is false, so a plain `terraform apply` leaves the four
#      services out — flipping that default is what makes this script exit non-zero;
#   2. none of the four is in the set that is always created, and each is reachable only
#      through the flag-gated set.
set -euo pipefail
cd "$(dirname "$0")/../.."

services="google-bridge google-bridge-callback stub-saas-op stub-saas-api"
variables=infra/envs/demo/variables-bridge.tf
locals=infra/envs/demo/locals-services.tf
status=0

# 1. The default apply must not switch the Bridge on.
default=$(awk '/variable "enable_google_bridge"/,/^}/' "$variables" | awk '/default/ { print $3 }')
if [ "$default" != "false" ]; then
  echo "enable_google_bridge defaults to '${default:-unset}': the default apply would create the bridge services" >&2
  status=1
fi

# 2. The optional set is the only way in, and it is gated on the flag.
if ! grep -q 'optional_service_names = var.enable_google_bridge ?' "$locals"; then
  echo "optional_service_names is not gated on var.enable_google_bridge" >&2
  status=1
fi

required=$(awk '/required_service_names = toset\(\[/,/\]\)/' "$locals")
for service in $services; do
  if ! grep -rqn "\"$service\"" infra --include='*.tf'; then
    continue  # not declared at all: nothing to gate.
  fi
  case "$required" in
    *"\"$service\""*)
      echo "$service is in required_service_names and would be created by the default apply" >&2
      status=1
      ;;
  esac
done

[ "$status" -eq 0 ] && echo "ok: the four bridge services exist only when enable_google_bridge is true"
exit "$status"
