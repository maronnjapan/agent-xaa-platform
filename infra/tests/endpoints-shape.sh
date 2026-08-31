#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/demo/locals-endpoints.tf
keys=(issuer jwks_url xaa_token_url xaa_callback_url subject_token_url authorization_url provisioner_url lifecycle_url resource_docs_as_issuer resource_docs_api_url resource_finance_as_issuer resource_finance_api_url bridge_internal_url stub_saas_op_issuer agent_max_lifetime_seconds vertex_model vertex_location enable_google_bridge)
[[ -f "$file" ]] || { echo 'endpoints-shape: endpoint locals are missing' >&2; exit 1; }
for key in "${keys[@]}"; do
  count=$(grep -cE "^[[:space:]]+$key[[:space:]]*=" "$file")
  [[ "$count" -eq 1 ]] || { echo "endpoints-shape: $key occurs $count times" >&2; exit 1; }
done
actual=$(sed -n '/platform_endpoints = {/,/^  }/p' "$file" | tail -n +2 | grep -cE '^[[:space:]]+[a-z_]+[[:space:]]*=')
[[ "$actual" -eq 18 ]] || { echo "endpoints-shape: expected 18 keys, found $actual" >&2; exit 1; }
