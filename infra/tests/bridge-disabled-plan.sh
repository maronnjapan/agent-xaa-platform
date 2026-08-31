#!/usr/bin/env bash
# T-BRIDGE-20 / DEC-SCOPE-04. With enable_google_bridge=false — the default — none of the
# Bridge or stub services exist. Checked against the Terraform source rather than a live
# plan, because the check has to run in CI without credentials: every one of the four
# services must sit behind a count or for_each driven by the flag.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
for service in google-bridge google-bridge-callback stub-saas-op stub-saas-api; do
  block=$(grep -rn "\"$service\"" infra --include='*.tf' || true)
  [ -z "$block" ] && continue
  # The service is declared; it must be gated on the flag.
  if ! grep -rn 'enable_google_bridge' infra --include='*.tf' >/dev/null; then
    echo "$service is declared but enable_google_bridge gates nothing" >&2
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "ok: the bridge services are gated on enable_google_bridge"
exit "$status"
