#!/usr/bin/env bash
# T-PROV-03 / REQ-04-027. `risk_level` is an audit and display attribute. It is put on
# the Activity Event and the structured log and read by nobody else here.
#
# What it must never do is decide isolation: that is the Policy Engine's decision
# (RULE-07), reached from the whole request rather than from one connector's rating.
# A Provisioner that raised isolation on a high-risk tool would be quietly overruling
# a decision the Authorization Platform already recorded and the person already saw.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rn "risk_level" apps/provisioner/src | grep "isolation_level" || true)

if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "risk_level must not take part in deciding the isolation level" >&2
  exit 1
fi
echo "ok: risk_level decides no isolation level"
