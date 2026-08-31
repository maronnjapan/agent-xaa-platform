#!/usr/bin/env bash
set -euo pipefail

mapfile -t tf_files < <(find infra -type f -name '*.tf' -not -path '*/.terraform/*')
((${#tf_files[@]} > 0)) || { echo 'no-dedicated-op-in-tf: no Terraform files found' >&2; exit 1; }
pattern='(name|account_id|crypto_key_id)[[:space:]]*=[[:space:]]*"(dedicated-op-|sa-op-|sa-agent-|idjag-|idpconn-|agent-runtime-[^"]+)'
if grep -nE "$pattern" "${tf_files[@]}" | grep -vE 'name[[:space:]]*=[[:space:]]*"agent-runtime-standard"'; then
  echo 'no-dedicated-op-in-tf: runtime-owned namespace appears in a Terraform resource name' >&2
  exit 1
fi
if grep -nE 'dedicated_slot_count|dedicated_op_slot_count|full_isolation_slot_count|isolation-slot' "${tf_files[@]}"; then
  echo 'no-dedicated-op-in-tf: slot resources are forbidden' >&2
  exit 1
fi
