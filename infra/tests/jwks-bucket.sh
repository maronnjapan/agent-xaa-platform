#!/usr/bin/env bash
set -euo pipefail

file=infra/envs/demo/storage-jwks.tf
for expected in 'uniform_bucket_level_access = true' 'force_destroy               = true' 'member = "allUsers"'; do
  grep -qF "$expected" "$file" || { echo "jwks-bucket: missing $expected" >&2; exit 1; }
done
[[ $(sed -n '/jwks_writer_prefixes = {/,/^  }/p' infra/envs/demo/iam-jwks.tf | tail -n +2 | grep -cE '^[[:space:]]+[a-z_]+') -eq 4 ]] || {
  echo 'jwks-bucket: expected four prefix-constrained static writers' >&2
  exit 1
}
grep -qE 'resource.name.startsWith' infra/envs/demo/iam-jwks.tf || { echo 'jwks-bucket: prefix IAM condition is missing' >&2; exit 1; }
