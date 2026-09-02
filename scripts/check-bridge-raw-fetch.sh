#!/usr/bin/env bash
# T-BRIDGE-11 / RULE-21. docs 06 §2 says the Bridge does not relay business APIs. That is
# only true if it has one way out, with an allow list on it — so `fetch(` outside
# `http/outbound.ts` is a route around the rule.
set -euo pipefail
cd "$(dirname "$0")/.."

# One pass over the directory rather than one Node process per file: the check runs
# from a unit test with a five-second budget, and the process starts spend most of it.
# code-grep walks directories itself and strips comments first, so what is checked is
# unchanged — prose about `fetch(` is still not a call to it.
hits=$(node scripts/checks/code-grep.mjs 'globalThis\.fetch|[^.a-zA-Z]fetch\(' apps/google-bridge/src || true)
hits=$(printf '%s' "$hits" | grep -v '^apps/google-bridge/src/http/outbound\.ts:' || true)

if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "the Bridge sends HTTP only through http/outbound.ts" >&2
  exit 1
fi
echo "ok: one outbound path, with an allow list on it"
