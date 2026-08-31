#!/usr/bin/env bash
# T-APP-34 / RULE-60. A demonstration uses the same screen and the same data as ordinary
# use. `POST /api/demo/replay` writes scripted events into the ordinary timeline; a
# separate demo page would let the two diverge, and the demo would stop proving anything.
set -euo pipefail
cd "$(dirname "$0")/../.."

hits=$(grep -rnE "app\.(get|post|put|patch|delete)\(['\"]/demo" apps/automation-app/src || true)
if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "the only demo entry point is POST /api/demo/replay" >&2
  exit 1
fi
echo "ok: demos use the ordinary screens"
