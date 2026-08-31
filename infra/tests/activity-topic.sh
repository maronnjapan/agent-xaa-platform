#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/demo/pubsub-activity.tf
for expected in 'name    = "agent-activity-stream"' '/internal/activity/push' 'roles/pubsub.publisher'; do
  grep -qF "$expected" "$file" || { echo "activity-topic: missing $expected" >&2; exit 1; }
done
grep -qE 'audience[[:space:]]*=[[:space:]]*local.run_url\["automation-app"\]' "$file" || {
  echo 'activity-topic: push OIDC audience is incorrect' >&2
  exit 1
}
