#!/usr/bin/env bash
set -uo pipefail

status=0
for check in reachability forbidden-roles invoker-matrix; do
  echo "[infra-verify] $check"
  if ! bash "infra/tests/$check.sh"; then status=1; fi
done
exit "$status"
