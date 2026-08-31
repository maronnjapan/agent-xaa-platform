#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/demo/locals-services.tf
required=(human-idp automation-app authorization provisioner lifecycle shared-agent-op agent-op-callback security-detection resource-finance-as resource-finance-api resource-docs-as resource-docs-api)
conditional=(google-bridge google-bridge-callback stub-saas-op stub-saas-api)
for service in "${required[@]}" "${conditional[@]}"; do
  grep -qE "\"$service\"" "$file" || { echo "service-inventory: missing $service" >&2; exit 1; }
done
[[ "${#required[@]}" -eq 12 && "${#conditional[@]}" -eq 4 ]] || exit 1
sa_count=$(sed -n '/service_accounts = {/,/^  }/p' infra/envs/demo/locals-sa.tf | tail -n +2 | grep -cE '^[[:space:]]+[a-z_]+[[:space:]]*=')
[[ "$sa_count" -eq 19 ]] || { echo "service-inventory: expected 19 service accounts, found $sa_count" >&2; exit 1; }
