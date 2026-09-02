#!/usr/bin/env bash
# T-BRIDGE-11 / RULE-21. docs 06 §2 says the Bridge does not relay business APIs. That is
# only true if it has one way out, with an allow list on it — so `fetch(` outside
# `http/outbound.ts` is a route around the rule.
set -euo pipefail
cd "$(dirname "$0")/.."

# One `code-grep` run over every file, rather than one run each: same check, without a
# Node process per source file.
files=()
while IFS= read -r file; do
  case "$file" in
    apps/google-bridge/src/http/outbound.ts) continue ;;
  esac
  files+=("$file")
done < <(find apps/google-bridge/src -type f -name '*.ts')

if [ ${#files[@]} -eq 0 ]; then
  echo "no bridge sources to check" >&2
  exit 1
fi

if ! node scripts/checks/code-grep.mjs 'globalThis\.fetch|[^.a-zA-Z]fetch\(' "${files[@]}" >&2; then
  echo "the Bridge sends HTTP only through http/outbound.ts" >&2
  exit 1
fi
echo "ok: one outbound path, with an allow list on it"
