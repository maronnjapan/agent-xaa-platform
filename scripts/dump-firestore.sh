#!/usr/bin/env bash
set -euo pipefail

output=${1:-firestore-dump.json}
mise exec node@22.23.2 -- pnpm --filter @xaa/gcp build
mise exec node@22.23.2 -- node packages/gcp/dist/dump-firestore.js "$output"
