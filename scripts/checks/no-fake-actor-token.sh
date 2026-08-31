#!/usr/bin/env bash
# T-APP-35. Only the Agent Runtime signs an agent assertion. If a demo path could mint
# one, a scripted scenario would be able to produce a token indistinguishable from a
# real agent's — and the recorded scripts exist precisely so that never has to happen.
set -euo pipefail
cd "$(dirname "$0")/../.."

hits=$(grep -rln "agent-assertion+jwt" --include='*.ts' apps packages e2e 2>/dev/null \
  | grep -v '^apps/agent-runtime/' \
  | grep -v '^apps/agent-op/' \
  | grep -v '^packages/xaa-contracts/' \
  | grep -v '^e2e/harness/' || true)
if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "agent assertions are signed by the Agent Runtime only" >&2
  exit 1
fi
echo "ok: no unexpected agent assertion signer"
