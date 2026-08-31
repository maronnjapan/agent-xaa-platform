#!/usr/bin/env bash
set -euo pipefail

grep -qE 'contains(\["direct", "loadbalancer"\], var.issuer_profile)' infra/envs/demo/variables-issuer.tf || {
  echo 'issuer-profile: validation is missing' >&2
  exit 1
}
grep -qE 'var.issuer_profile == "direct"' infra/envs/demo/locals-endpoints.tf || {
  echo 'issuer-profile: endpoint switch is missing' >&2
  exit 1
}
grep -qE 'var.enable_lb_reservation \? 1 : 0' infra/envs/shared/lb-reservation.tf || {
  echo 'issuer-profile: LB reservation is not opt-in' >&2
  exit 1
}
