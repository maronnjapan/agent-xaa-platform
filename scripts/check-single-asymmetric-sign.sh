#!/usr/bin/env bash
# DEC-ID-16 / REQ-08-032: KMS asymmetricSign is called from exactly one module, and
# no application ever imports a private key into its own process.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

callers=$(find apps packages -name '*.ts' -not -path '*/dist/*' -not -path '*/node_modules/*' -not -path '*/test/*' -print0 \
  | xargs -0 -r grep -l 'asymmetricSign' || true)
expected='packages/xaa-crypto/src/kms-signer.ts'
if [ "$callers" != "$expected" ]; then
  echo "check-single-asymmetric-sign: expected only $expected, found:" >&2
  echo "$callers" >&2
  exit 1
fi

agent_op=$(find apps/agent-op/src -name '*.ts' -print0 \
  | xargs -0 -r grep -nE 'importPKCS8|importJWK|createPrivateKey|createIdJagJwt|issueIdToken|issueAccessToken' || true)
if [ -n "$agent_op" ]; then
  echo 'check-single-asymmetric-sign: Agent OP must not handle private key material or mint other token types' >&2
  echo "$agent_op" >&2
  exit 1
fi
