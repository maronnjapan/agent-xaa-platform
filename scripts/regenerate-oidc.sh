#!/usr/bin/env bash
# Regenerates every committed OIDC provider into generated-baseline/.
# The CLI version comes from the workspace's exact pin, never from a literal here.
set -euo pipefail

cd "$(dirname "$0")/.."

# Human IdP must not accept token-exchange (RULE-47), so it is generated without the
# id-jag feature. The two Resource AS redeem an ID-JAG, so they need it.
pnpm exec maronn-oidc generate hono --output generated-baseline/human-idp
pnpm exec maronn-oidc generate hono --output generated-baseline/stub-saas-op
for app in resource-docs-as resource-finance-as; do
  pnpm exec maronn-oidc generate hono --enable id-jag --output "generated-baseline/$app"
done
# Reference only: Agent OP rebuilds the issuance pipeline from the exported step
# functions and never deploys this output (DEC-ID-01).
pnpm exec maronn-oidc generate hono --enable id-jag --output generated-baseline/agent-op-reference
