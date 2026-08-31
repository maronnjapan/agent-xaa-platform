#!/usr/bin/env bash
set -euo pipefail

[[ $(sed -n '/key_rings = toset/,/^  ])/p' infra/envs/shared/kms.tf | grep -cE '"[a-z-]+"') -eq 5 ]] || {
  echo 'kms-iam: exactly five key rings are required' >&2
  exit 1
}
if find infra -name '*.tf' -not -path '*/.terraform/*' -print0 | xargs -0 -r grep -lE 'google_project_iam_(member|binding)' | xargs -r grep -nE 'roles/cloudkms\.'; then
  echo 'kms-iam: KMS roles must not be project-level' >&2
  exit 1
fi
bash infra/tests/no-kms-key-version.sh
