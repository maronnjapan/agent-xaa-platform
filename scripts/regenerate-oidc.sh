#!/usr/bin/env bash
# Regenerates every committed OIDC provider into generated-baseline/.
# The CLI version comes from the workspace's exact pin, never from a literal here.
#
# With --check nothing in the working tree is touched: the CLI writes into a
# temporary directory and the result is compared byte for byte against
# generated-baseline/. That is the question CI actually asks — "is the committed
# baseline still what this CLI version produces?" — and it can be asked without a
# dirty tree.
set -euo pipefail

cd "$(dirname "$0")/.."

mode=write
if [[ "${1:-}" == "--check" ]]; then mode=check; fi

# Human IdP must not accept token-exchange (RULE-47), so it is generated without the
# id-jag feature. The two Resource AS redeem an ID-JAG, so they need it.
# Reference only: Agent OP rebuilds the issuance pipeline from the exported step
# functions and never deploys this output (DEC-ID-01).
generate() { # <output-dir> <extra flags...>
  local output=$1; shift
  pnpm exec maronn-oidc generate hono "$@" --output "$output"
}

# stub-saas-op is absent on purpose: it stands in for an external SaaS during tests,
# so it is a fixture rather than a provider this platform operates, and it is written
# by hand (apps/stub-saas-op has no src/oidc). check-oidc-patches.mjs excludes it for
# the same reason.
generate_all() { # <root>
  local root=$1
  generate "$root/human-idp"
  local app
  for app in resource-docs-as resource-finance-as; do
    generate "$root/$app" --enable id-jag
  done
  generate "$root/agent-op-reference" --enable id-jag
}

if [[ "$mode" == write ]]; then
  generate_all generated-baseline
  exit 0
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
generate_all "$scratch" >/dev/null

if diff -r generated-baseline "$scratch"; then
  echo "ok: generated-baseline/ is byte-identical to what the pinned CLI generates"
else
  echo 'regenerate-oidc: generated-baseline/ differs from the CLI output; run this script without --check' >&2
  exit 1
fi
