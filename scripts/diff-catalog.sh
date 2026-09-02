#!/usr/bin/env bash
# T-IAC-26. After `seed` has run, the Catalog in Firestore is exactly what infra/seed
# declares: every tool_id / connector_id in the YAML is present, and nothing else is.
# Prints one line per difference and exits 1 when there is any; silence means equal.
#
# Reads Firestore through the same dump the JWT-plaintext check uses, so it needs the
# deployer's ADC (or STORE_MODE=emulator) and PROJECT_ID / FIRESTORE_DATABASE as the
# seed Job has them. ENABLE_GOOGLE_BRIDGE=false (the default) drops the stub SaaS rows,
# exactly as apps/seed/src/index.ts does before it writes.
set -euo pipefail
cd "$(dirname "$0")/.."

dump=$(mktemp)
trap 'rm -f "$dump"' EXIT
[ -f packages/gcp/dist/dump-firestore.js ] || pnpm --filter @xaa/gcp build >/dev/null
node packages/gcp/dist/dump-firestore.js "$dump" >/dev/null

expected_ids() { # <dir> <key>
  local dir=$1 key=$2 file id
  for file in "$dir"/*.yaml; do
    id=$(grep -m1 "^${key}:" "$file" | sed "s/^${key}:[[:space:]]*//")
    if [ "${ENABLE_GOOGLE_BRIDGE:-false}" != true ] && grep -q '^connector_id:[[:space:]]*stub-saas-calendar' "$file"; then continue; fi
    printf '%s\n' "$id"
  done | sort
}
actual_ids() { # <collection>
  node -e '
    const dump = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const row of dump[process.argv[2]] ?? []) console.log(row.id);
  ' "$dump" "$1" | sort
}

status=0
for pair in "tools:tool_id:catalog_tools" "connectors:connector_id:catalog_connectors"; do
  IFS=: read -r dir key collection <<<"$pair"
  if ! diff <(expected_ids "infra/seed/$dir" "$key") <(actual_ids "$collection") \
      | sed -n "s/^< /$collection missing: /p; s/^> /$collection unexpected: /p"; then :; fi
  if ! diff -q <(expected_ids "infra/seed/$dir" "$key") <(actual_ids "$collection") >/dev/null; then status=1; fi
done
exit "$status"
