#!/usr/bin/env bash
set -euo pipefail

files=(infra/envs/demo/jobs.tf infra/modules/cloud-run-job/main.tf)
for file in "${files[@]}"; do [[ -f "$file" ]] || { echo "job-env: missing $file" >&2; exit 1; }; done
for fixed in 'task_count  = 1' 'parallelism = 1' 'max_retries     = 0'; do
  grep -qF "$fixed" infra/modules/cloud-run-job/main.tf || { echo "job-env: missing fixed setting $fixed" >&2; exit 1; }
done
if sed -n '/runtime_static_env = merge/,/^  })/p' infra/envs/demo/jobs.tf | grep -niE 'agent.?id|private.?key|client.?secret|refresh.?token'; then
  echo 'job-env: agent-specific or secret environment key in the standard Job' >&2
  exit 1
fi
grep -qE 'ISOLATION_LEVEL[[:space:]]*=[[:space:]]*"standard"' infra/envs/demo/jobs.tf || {
  echo 'job-env: standard isolation marker is missing' >&2
  exit 1
}
