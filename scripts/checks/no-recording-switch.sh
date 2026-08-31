#!/usr/bin/env bash
# T-APP-25 / RULE-60. Recording is not a mode. A switch to turn the timeline off would
# make its absence ambiguous — was nothing happening, or was nobody watching?
set -euo pipefail
cd "$(dirname "$0")/../.."

if grep -rnE "app\.(get|post|put|patch|delete)\(['\"][^'\"]*(recording|demo-mode|capture)" apps/automation-app/src >/dev/null; then
  echo "automation-app must not expose a recording switch" >&2
  exit 1
fi
echo "ok: recording is always on"
