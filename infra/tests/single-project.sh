#!/usr/bin/env bash
set -euo pipefail

mapfile -t tf_files < <(find infra -type f -name '*.tf' -not -path '*/.terraform/*')
((${#tf_files[@]} > 0)) || { echo 'single-project: no Terraform files found' >&2; exit 1; }

if grep -nE 'resource[[:space:]]+"google_project"' "${tf_files[@]}"; then
  echo 'single-project: Terraform must consume one existing project and must not create projects' >&2
  exit 1
fi

if grep -nE 'variable[[:space:]]+"[^"]*project[^"]*"' "${tf_files[@]}" | grep -vE 'variable "project_id"'; then
  echo 'single-project: project_id is the only project variable allowed' >&2
  exit 1
fi

api_count=$(grep -oE '"[a-z0-9.-]+\.googleapis\.com"' infra/envs/shared/services.tf | sort -u | wc -l)
[[ "$api_count" -eq 14 ]] || { echo "single-project: expected 14 APIs, found $api_count" >&2; exit 1; }
