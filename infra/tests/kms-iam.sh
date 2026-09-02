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

# Every KMS grant is written in one file, and the per-key grants come from one map.
# Without this, a second file could add a binding that neither the ledger nor this check
# would mention, and "which service account can sign with which key" would stop having a
# single answer (T-IAC-19).
elsewhere=$(find infra/envs -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -lE '^resource "google_kms_(crypto_key|key_ring)_iam_' | grep -v '^infra/envs/demo/iam-kms.tf$' || true)
[[ -z "$elsewhere" ]] || {
  echo "kms-iam: KMS IAM belongs in infra/envs/demo/iam-kms.tf, found in: $elsewhere" >&2
  exit 1
}
grep -qF 'for_each      = local.kms_bindings' infra/envs/demo/iam-kms.tf || {
  echo 'kms-iam: per-key grants must be generated from locals.kms_bindings' >&2
  exit 1
}
expected='docs_as finance_as human_idp shared_op_idp_connection shared_op_sign'
actual=$(sed -n '/kms_bindings = {/,/^  }/p' infra/envs/demo/iam-kms.tf | grep -oE '^    [a-z_]+ = \{' | grep -oE '[a-z_]+' | sort | tr '\n' ' ')
[[ "$actual" == "$expected " ]] || {
  echo "kms-iam: kms_bindings should be [$expected], found [$actual]" >&2
  exit 1
}

# Key Ring level grants exist only for the two runtime namespaces, and only as admin
# (which does not include signing): the Provisioner creates per-Agent keys, the Lifecycle
# Manager destroys their versions, and neither may use them (T-IAC-37).
rings=$(sed -n '/resource "google_kms_key_ring_iam_member"/,/^}/p' infra/envs/demo/iam-kms.tf)
[[ -z "$rings" ]] || {
  grep -qF 'role        = "roles/cloudkms.admin"' <<<"$rings" || {
    echo 'kms-iam: a Key Ring grant other than cloudkms.admin is not allowed' >&2
    exit 1
  }
  for ring in idjag-signing idp-connection-encryption; do
    grep -qF "\"$ring\"" <<<"$rings" || { echo "kms-iam: missing runtime Key Ring $ring" >&2; exit 1; }
  done
}

bash infra/tests/no-kms-key-version.sh
