#!/usr/bin/env bash
# T-PROV-03 / RULE-16. The Provisioner learns where a Resource lives from the Tool
# Catalog, which the seed job fills from Terraform's `platform_endpoints`. A URL
# written into this app's source would survive a redeploy that moved the service, and
# would do so silently: the agent would be provisioned with an audience nobody serves.
#
# Two kinds of literal are not that, and are allowed:
#   - `*.googleapis.com` — Google's own control plane, where the admin SDK sends its
#     requests. It is not a platform endpoint and no deployment moves it.
#   - `src/testing/` — the in-process harness, whose hosts exist only inside a test.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rn "https://" apps/provisioner/src \
  | grep -v '^apps/provisioner/src/testing/' \
  | grep -v 'googleapis\.com' || true)

if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "the Provisioner must read every endpoint from the catalogue, never from a literal" >&2
  exit 1
fi
echo "ok: no hardcoded endpoint in apps/provisioner/src"
