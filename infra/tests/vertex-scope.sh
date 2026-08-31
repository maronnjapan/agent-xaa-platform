#!/usr/bin/env bash
set -euo pipefail

expected=(automation_app authorization agent_runtime security)
block=$(grep -E 'vertex_users[[:space:]]*= toset' infra/envs/demo/iam-project.tf)
for key in "${expected[@]}"; do
  grep -qE "\"$key\"" <<<"$block" || { echo "vertex-scope: missing static principal $key" >&2; exit 1; }
done
[[ $(grep -oE '"[a-z_]+"' <<<"$block" | sort -u | wc -l) -eq 4 ]] || { echo 'vertex-scope: static Vertex principal set is not exact' >&2; exit 1; }
grep -qE 'roles/aiplatform.user' infra/envs/demo/locals-dedicated-iam.tf || { echo 'vertex-scope: dedicated Agent template is missing' >&2; exit 1; }
# Test fixtures may name a model; production sources must take it from VERTEX_MODEL.
if find apps packages -name '*.ts' -not -path '*/dist/*' -not -path '*/node_modules/*' -not -path '*/test/*' -print0 | xargs -0 -r grep -nE 'gemini-[0-9]'; then
  echo 'vertex-scope: model names must come from Terraform configuration' >&2
  exit 1
fi
