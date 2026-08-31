#!/usr/bin/env bash
set -euo pipefail

for app in human-idp resource-docs-as resource-finance-as stub-saas-op; do
  pnpm exec maronn-oidc generate hono --output "generated-baseline/$app"
done
pnpm exec maronn-oidc generate hono --enable id-jag --output generated-baseline/agent-op-reference
