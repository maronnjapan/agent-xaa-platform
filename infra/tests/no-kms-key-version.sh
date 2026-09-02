#!/usr/bin/env bash
set -euo pipefail

mapfile -t files < <(find infra -type f -name '*.tf')
if ((${#files[@]} == 0)); then
  echo 'no Terraform files found' >&2
  exit 1
fi
# The forbidden resource type is assembled from two halves rather than written out, so
# that a repository-wide grep for it over infra/ stays at zero hits. A checker that is
# itself the only hit makes that grep useless as evidence (T-IAC-18).
forbidden='google_kms_crypto_key''_version'
if grep -n "$forbidden" "${files[@]}"; then
  echo 'explicit KMS CryptoKeyVersion resources are forbidden' >&2
  echo 'DEC-IAC-04: only the version GCP creates with the CryptoKey is used' >&2
  exit 1
fi
