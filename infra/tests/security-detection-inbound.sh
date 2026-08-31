#!/usr/bin/env bash
# T-SEC-08 / REQ-01-025. Detection is a one-way feed: applications log, the detector
# reads, and nothing calls back. No application service account may invoke
# security-detection — the only inbound edge allowed is Pub/Sub's own push identity,
# which exists solely for the non-default `security_events_delivery = "push"`.
set -euo pipefail
cd "$(dirname "$0")/../.."

offenders=$(grep -oE '\["[a-z_]+", "security-detection"\]' infra/envs/demo/locals-invoker.tf \
  | grep -v '"pubsub_push"' || true)

if [ -n "$offenders" ]; then
  echo "$offenders" >&2
  echo "no application may invoke security-detection" >&2
  exit 1
fi
echo "ok: nothing calls the detector but Pub/Sub delivery"
