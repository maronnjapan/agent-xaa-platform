#!/usr/bin/env bash
# Regenerates every committed OIDC provider into generated-baseline/.
# The CLI version comes from the workspace's exact pin, never from a literal here.
set -euo pipefail

cd "$(dirname "$0")/.."

# Human IdP must not accept token-exchange (RULE-47), so it is generated without the
# id-jag feature. The two Resource AS redeem an ID-JAG, so they need it.
pnpm exec maronn-oidc generate hono --output generated-baseline/human-idp
# stub-saas-op is generated here but its baseline is not committed and
# check-oidc-patches.mjs does not compare against it: the app that ships is a
# hand-written stand-in for somebody else's OAuth server, not a provider this platform
# operates, so it has no src/oidc to hold to a baseline. DEC-ID-01 counts it among the
# four generated OPs, and T-BRIDGE-19 declares both paths, so the difference is a known
# gap rather than a decision this script is allowed to make on its own.
pnpm exec maronn-oidc generate hono --output generated-baseline/stub-saas-op
for app in resource-docs-as resource-finance-as; do
  pnpm exec maronn-oidc generate hono --enable id-jag --output "generated-baseline/$app"
done
# Reference only: Agent OP rebuilds the issuance pipeline from the exported step
# functions and never deploys this output (DEC-ID-01).
pnpm exec maronn-oidc generate hono --enable id-jag --output generated-baseline/agent-op-reference
