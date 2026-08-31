#!/usr/bin/env bash
# T-BRIDGE-11 / RULE-21. docs 06 §2 says the Bridge does not relay business APIs. That is
# only true if it has one way out, with an allow list on it — so `fetch(` outside
# `http/outbound.ts` is a route around the rule.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
while IFS= read -r file; do
  case "$file" in
    apps/google-bridge/src/http/outbound.ts) continue ;;
  esac
  if ! node scripts/checks/code-grep.mjs 'globalThis\.fetch|[^.a-zA-Z]fetch\(' "$file" >&2; then
    status=1
  fi
done < <(find apps/google-bridge/src -type f -name '*.ts')

if [ "$status" -ne 0 ]; then
  echo "the Bridge sends HTTP only through http/outbound.ts" >&2
  exit 1
fi
echo "ok: one outbound path, with an allow list on it"
