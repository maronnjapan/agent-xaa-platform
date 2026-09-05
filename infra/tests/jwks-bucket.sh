#!/usr/bin/env bash
# T-IAC-20. One shared JWKS bucket, readable by anyone and writable only under the
# prefix that belongs to the writer. No principal holds a predefined storage role that can
# delete an object: those all cover the whole bucket, and a deleted `keys/*.json` drops a
# signer out of the aggregate `jwks.json` with every token it signed then failing
# verification and no trace of why.
#
# Two custom roles carry that permission on purpose, each for one thing. The Lifecycle
# Manager removes a retired Agent's key (apps/lifecycle-manager/src/clients/gcp.ts), and
# the publish job replaces the aggregate, which Cloud Storage counts as a delete of the
# generation it replaces. The checks at the end of this file are what keep the second one
# narrow: a single permission, bound under the condition that names `jwks.json`.
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

# The single exception, and the shape that keeps it single: one custom role carrying that
# one permission, bound under a condition that names the aggregate object. The same
# permission granted without the condition would reach every keys/*.json in the bucket.
replacer=$(sed -n '/resource "google_project_iam_custom_role" "jwks_aggregate_replacer"/,/^}/p' infra/envs/demo/iam-jwks.tf)
grep -qF 'permissions = ["storage.objects.delete"]' <<<"$replacer" || {
  echo 'jwks-bucket: the aggregate replacer role must carry storage.objects.delete and nothing else' >&2
  exit 1
}
binding=$(sed -n '/resource "google_storage_bucket_iam_member" "jwks_publish_replace"/,/^}/p' infra/envs/demo/iam-jwks.tf)
grep -qF "objects/jwks.json'" <<<"$binding" || {
  echo 'jwks-bucket: the delete grant must be conditioned on the aggregate object' >&2
  exit 1
}
[[ $(grep -v '^[[:space:]]*#' infra/envs/demo/iam-jwks.tf | grep -c 'storage\.objects\.delete') -eq 1 ]] || {
  echo 'jwks-bucket: storage.objects.delete is granted more than once in iam-jwks.tf' >&2
  exit 1
}
