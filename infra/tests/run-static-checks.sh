#!/usr/bin/env bash
set -uo pipefail

status=0
for check in no-kms-key-version runtime-mutation-scope no-firestore-sdk-in-frontend; do
  if ! bash "infra/tests/$check.sh"; then status=1; fi
done
exit "$status"
