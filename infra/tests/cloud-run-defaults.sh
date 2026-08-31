#!/usr/bin/env bash
set -euo pipefail

file=infra/modules/cloud-run-service/main.tf
[[ -f "$file" ]] || { echo 'cloud-run-defaults: module is missing' >&2; exit 1; }
for expected in 'min_instance_count = 0' 'execution_environment = "EXECUTION_ENVIRONMENT_GEN2"' 'service_account       = var.service_account'; do
  grep -qF "$expected" "$file" || { echo "cloud-run-defaults: missing $expected" >&2; exit 1; }
done
grep -qE 'default compute service accounts are forbidden' infra/modules/cloud-run-service/variables.tf || {
  echo 'cloud-run-defaults: default service-account guard is missing' >&2
  exit 1
}
