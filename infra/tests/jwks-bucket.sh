#!/usr/bin/env bash
# T-IAC-20. One shared JWKS bucket, readable by anyone and writable only under the
# prefix that belongs to the writer. Nobody may delete an object: a deleted `keys/*.json`
# silently drops a signer out of the aggregate `jwks.json` and every token it signed
# starts failing verification with no trace of why.
set -euo pipefail

file=infra/envs/demo/storage-jwks.tf
for expected in 'uniform_bucket_level_access = true' 'force_destroy               = true'; do
  grep -qF "$expected" "$file" || { echo "jwks-bucket: missing $expected" >&2; exit 1; }
done
grep -qF 'member = "allUsers"' infra/envs/demo/iam-public.tf || {
  echo 'jwks-bucket: the anonymous read grant belongs in iam-public.tf' >&2
  exit 1
}
[[ $(grep -c 'resource "google_storage_bucket" "jwks"' "$file") -eq 1 ]] || {
  echo 'jwks-bucket: exactly one JWKS bucket is expected' >&2
  exit 1
}
[[ $(sed -n '/jwks_writer_prefixes = {/,/^  }/p' infra/envs/demo/iam-jwks.tf | tail -n +2 | grep -cE '^[[:space:]]+[a-z_]+') -eq 4 ]] || {
  echo 'jwks-bucket: expected four prefix-constrained static writers' >&2
  exit 1
}
grep -qE 'resource.name.startsWith' infra/envs/demo/iam-jwks.tf || { echo 'jwks-bucket: prefix IAM condition is missing' >&2; exit 1; }

# Roles that carry storage.objects.delete. objectCreator and objectViewer do not.
deletable='storage\.objectAdmin|storage\.objectUser|storage\.legacyBucketWriter|storage\.admin'
if find infra/envs -name '*.tf' -not -path '*/.terraform/*' -print0 \
  | xargs -0 -r grep -nE "roles/($deletable)"; then
  echo 'jwks-bucket: no principal may hold a storage role that can delete an object' >&2
  exit 1
fi
