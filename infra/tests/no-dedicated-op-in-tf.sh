#!/usr/bin/env bash
set -euo pipefail

mapfile -t tf_files < <(find infra -type f -name '*.tf' -not -path '*/.terraform/*')
((${#tf_files[@]} > 0)) || { echo 'no-dedicated-op-in-tf: no Terraform files found' >&2; exit 1; }
pattern='(name|account_id|crypto_key_id)[[:space:]]*=[[:space:]]*"(dedicated-op-|sa-op-|sa-agent-|idjag-|idpconn-|agent-runtime-[^"]+)'
if grep -nE "$pattern" "${tf_files[@]}" | grep -vE 'name[[:space:]]*=[[:space:]]*"agent-runtime-standard"'; then
  echo 'no-dedicated-op-in-tf: runtime-owned namespace appears in a Terraform resource name' >&2
  exit 1
fi
# The forbidden slot variable names are assembled from halves rather than written out,
# so that a repository-wide grep for them over infra/ stays at zero hits. A checker that
# is itself the only hit makes that grep useless as evidence (T-IAC-13).
slot='_slot'
slots="dedicated${slot}_count|dedicated_op${slot}_count|full_isolation${slot}_count|isolation${slot//_/-}"
if grep -nE "$slots" "${tf_files[@]}"; then
  echo 'no-dedicated-op-in-tf: slot resources are forbidden' >&2
  exit 1
fi
