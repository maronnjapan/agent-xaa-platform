#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/demo/locals-services.tf
public=(automation-app human-idp agent-op-callback google-bridge-callback stub-saas-op)
for service in "${public[@]}"; do
  grep -qE "\"$service\"" "$file" || { echo "public-surface: missing public declaration for $service" >&2; exit 1; }
done
if find infra -name '*.tf' -not -path '*/.terraform/*' -print0 | xargs -0 -r grep -nE 'google_(compute_)?(network|subnetwork|vpc_access_connector)'; then
  echo 'public-surface: VPC resources are outside the single-project demo design' >&2
  exit 1
fi
grep -qE 'INGRESS_TRAFFIC_INTERNAL_ONLY' infra/modules/cloud-run-service/variables.tf || {
  echo 'public-surface: internal ingress must be the module default' >&2
  exit 1
}
