#!/usr/bin/env bash
set -euo pipefail

declared=$(find infra/bootstrap infra/envs/shared infra/envs/demo -name 'variables*.tf' -print0 \
  | xargs -0 -r grep -ohE 'variable "[^"]+"' | sed -E 's/.*variable "([^"]+)"/\1/' | sort -u)
documented=$(grep -E '^\| `[a-z0-9_]+' infra/README.md | sed -E 's/^\| `([^`]+)`.*/\1/' | sort -u)
if ! diff -u <(printf '%s\n' "$declared") <(printf '%s\n' "$documented"); then
  echo 'check-readme-vars: Terraform variables and README table differ' >&2
  exit 1
fi
