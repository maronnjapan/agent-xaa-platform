#!/usr/bin/env bash
# T-RUN-01. The Agent Runtime is a Job, never a Service. A Cloud Run Service named
# after it would mean something can call into an agent, which is the shape this
# platform refuses: instructions reach an agent through Firestore, written by the
# Automation App, and nowhere else.
set -euo pipefail
cd "$(dirname "$0")/../.."

if grep -rn 'resource "google_cloud_run_v2_service"' infra --include='*.tf' -A 4 \
  | grep -E 'name\s*=.*agent-runtime' >/dev/null; then
  echo "agent-runtime must not be deployed as a Cloud Run Service" >&2
  exit 1
fi
echo "ok: no Cloud Run Service is named agent-runtime"
