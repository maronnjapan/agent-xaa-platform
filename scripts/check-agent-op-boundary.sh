#!/usr/bin/env bash
# RULE-20 / REQ-05-036 / REQ-05-037: Agent OP decides nothing. It never asks another
# Control Plane service a question at request time, and it never loads Vertex AI or
# the Security Detection modules. The only outbound destinations are Human IdP's
# three URLs plus GCS, KMS, Firestore and Pub/Sub.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/apps/agent-op/src"
[ -d "$src" ] || { echo "check-agent-op-boundary: $src does not exist" >&2; exit 1; }

files=()
while IFS= read -r file; do files+=("$file"); done < <(find "$src" -name '*.ts' | sort)
((${#files[@]} > 0)) || { echo 'check-agent-op-boundary: no sources to inspect' >&2; exit 1; }

status=0

forbidden_env='PROVISIONER_URL|AUTHORIZATION_URL|TOOL_CATALOG_URL|LIFECYCLE_URL|LIFECYCLE_MANAGER_URL|AUTOMATION_APP_BASE_URL'
if grep -nE "$forbidden_env" "${files[@]}"; then
  echo 'check-agent-op-boundary: Agent OP must not address another Control Plane service' >&2
  status=1
fi

forbidden_import='@google-cloud/aiplatform|@google-cloud/vertexai|@platform/security/(rules|correlation|scoring|ai)|@xaa/vertex'
if grep -nE "$forbidden_import" "${files[@]}"; then
  echo 'check-agent-op-boundary: forbidden import in Agent OP' >&2
  status=1
fi

exit $status
