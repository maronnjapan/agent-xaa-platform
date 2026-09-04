#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

iam=infra/envs/demo/iam-config.tf
services=infra/envs/demo/services.tf

for expected in \
  'human_idp           = "sso-signing/current.json"' \
  'resource_docs_as    = "resource-as-signing/docs/current.json"' \
  'resource_finance_as = "resource-as-signing/finance/current.json"'; do
  grep -qF "$expected" "$iam" || {
    echo "signing-key-storage: missing object mapping: $expected" >&2
    exit 1
  }
done

for expected in \
  'role     = "roles/storage.objectCreator"' \
  "resource.name == 'projects/_/buckets/" \
  'SIGNING_KEY_OBJECT   = local.signing_key_objects.resource_docs_as' \
  'SIGNING_KEY_OBJECT   = local.signing_key_objects.resource_finance_as'; do
  grep -qF "$expected" "$iam" "$services" >/dev/null || {
    echo "signing-key-storage: missing constrained bootstrap setting: $expected" >&2
    exit 1
  }
done

grep -qF 'google_storage_bucket_iam_member.signing_key_writers' "$services" || {
  echo 'signing-key-storage: Cloud Run can start before signing-key IAM is ready' >&2
  exit 1
}

echo 'ok: signing-key bootstrap storage is isolated and ordered before Cloud Run'
