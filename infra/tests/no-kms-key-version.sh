#!/usr/bin/env bash
set -euo pipefail

mapfile -t files < <(find infra -type f -name '*.tf')
if ((${#files[@]} == 0)); then
  echo 'no Terraform files found' >&2
  exit 1
fi
if grep -n 'google_kms_crypto_key_version' "${files[@]}"; then
  echo 'explicit KMS CryptoKeyVersion resources are forbidden' >&2
  exit 1
fi
