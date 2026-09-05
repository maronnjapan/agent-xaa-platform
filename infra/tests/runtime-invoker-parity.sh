#!/usr/bin/env bash
set -euo pipefail

# The two lists that say which doors an Agent Runtime may open, held together.
#
# `locals-invoker.tf` names them for `sa-agent-runtime`, the shared identity every
# STANDARD Execution runs as. `DEDICATED_RUNTIME_INVOKER_SERVICES` names them for
# `sa-agent-<short>`, the Service Account a FULL_ISOLATION Agent gets instead, and the
# Provisioner binds `roles/run.invoker` from it at provisioning time. The two are the
# same set apart from the Agent OP: a Dedicated Agent talks to its own OP, created
# alongside it, and never to the shared one.
#
# They were not the same set. The dedicated list named the two Resource AS and left out
# the two Resource APIs behind them, so a FULL_ISOLATION Agent could redeem an ID-JAG
# and then be refused at the API door by Cloud Run, with an Access Token in hand and
# nothing to spend it on. Nothing measured it: `invoker-matrix.sh` reads a deployed
# project, and a Dedicated service exists only while such an Agent does.

invoker_tf=infra/envs/demo/locals-invoker.tf
services_tf=infra/envs/demo/services.tf
for file in "$invoker_tf" "$services_tf"; do
  [[ -f "$file" ]] || { echo "runtime-invoker-parity: missing $file" >&2; exit 1; }
done

# Every target of an `agent_runtime` edge, less the Shared OP a Dedicated Agent replaces.
shared_targets=$(grep -oE '\["agent_runtime", "[^"]+"\]' "$invoker_tf" \
  | sed -E 's/.*, "([^"]+)"\]/\1/' | grep -v '^shared-agent-op$' | sort -u)

dedicated_targets=$(sed -n '/DEDICATED_RUNTIME_INVOKER_SERVICES = jsonencode/,/\]))/p' "$services_tf" \
  | grep -oE 'services/[a-z0-9-]+' | sed 's|services/||' | sort -u)

[[ -n "$shared_targets" ]] || { echo 'runtime-invoker-parity: read no agent_runtime edge' >&2; exit 1; }
[[ -n "$dedicated_targets" ]] || { echo 'runtime-invoker-parity: read no dedicated invoker service' >&2; exit 1; }

if ! diff -u <(echo "$shared_targets") <(echo "$dedicated_targets") >/dev/null; then
  echo 'runtime-invoker-parity: sa-agent-runtime and a Dedicated Agent may invoke different services' >&2
  diff -u --label 'locals-invoker.tf (agent_runtime, less shared-agent-op)' \
    --label 'services.tf (DEDICATED_RUNTIME_INVOKER_SERVICES)' \
    <(echo "$shared_targets") <(echo "$dedicated_targets") >&2 || true
  exit 1
fi

echo 'runtime-invoker-parity: the shared and dedicated runtime invoker lists agree'
