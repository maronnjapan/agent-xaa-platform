#!/usr/bin/env bash
# T-APP-21 / RULE-55. Activity Events go to one Pub/Sub topic and nowhere else. Writing
# them to Cloud Logging as well would put a person's timeline into the detection
# pipeline, where it would be read by rules that were never written for it.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
if grep -rn --include='*.ts' "activity-events" apps packages 2>/dev/null | grep -v node_modules >/dev/null; then
  echo "the topic is agent-activity-stream; 'activity-events' is the discarded name" >&2
  status=1
fi
if grep -rn --include='*.ts' -E "logger\.(info|warning|error|critical)\('activity_event" apps packages 2>/dev/null >/dev/null; then
  echo "Activity Events must not be written to Cloud Logging" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "ok: Activity Events use one channel"
exit "$status"
