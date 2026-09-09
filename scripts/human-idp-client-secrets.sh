#!/usr/bin/env bash
# The Secret Manager containers that hold the Human IdP's confidential client secrets,
# one id per line.
#
# Terraform declares them once, in `local.human_idp_client_secrets`, and Cloud Run mounts
# them as environment variables. A container without an enabled version stops the revision
# from becoming ready, so both paths that create the first versions — the unattended
# `scripts/ensure-secret-versions.sh` and the guided `scripts/deploy-gcp-guide.sh` — have
# to cover every one of them. They read the list here rather than each keeping their own
# copy: a fourth client added to Terraform is otherwise a deploy that fails on the apply,
# which is how `human-idp-analysis-console-client-secret` was missed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

source_file=infra/envs/shared/secrets.tf
ids=$(awk '
  /human_idp_client_secrets[[:space:]]*=[[:space:]]*\{/ { inside = 1; next }
  inside && /^[[:space:]]*\}/ { inside = 0 }
  inside && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2) }
' "$source_file")

# Reading nothing is the one answer this must not give quietly: an empty list makes every
# caller a no-op, and the deploy then fails several minutes later on a revision that
# cannot start, naming a secret rather than the list that lost it.
[[ -n $ids ]] || {
  printf 'human-idp-client-secrets: no secret ids in %s\n' "$source_file" >&2
  exit 1
}
printf '%s\n' "$ids"
