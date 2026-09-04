FROM node:22-slim AS deps
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY security-rules ./security-rules
COPY demo-scenarios ./demo-scenarios
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG APP
RUN test -n "$APP" && pnpm build
# pnpm 10 refuses to deploy from a workspace that does not inject its packages
# (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE). The legacy implementation copies the
# workspace packages into the deployed tree, which is exactly what the image needs.
RUN pnpm --filter "./apps/$APP" deploy --legacy --prod /deploy
# The entry is the package's own `main`: dist/server.js for the listening apps,
# dist/main.js for the Agent Runtime, which does not listen (DEC-APP-02), and
# dist/src/server.js for the Automation App, whose build root also covers client/.
# Writing one file with a fixed name keeps the CMD below identical for every image;
# a distroless CMD cannot branch on its own.
RUN node -e "const main = require('/deploy/package.json').main; \
  if (!main) throw new Error('package.json has no main'); \
  require('node:fs').accessSync('/deploy/' + main); \
  require('node:fs').writeFileSync('/deploy/entry.js', 'import \"./' + main + '\";\n');"

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
ARG APP
WORKDIR /app
COPY --from=build /deploy ./
# These files are read at module initialization. pnpm deploy only copies package
# contents, so repository-level runtime data must be carried into the final image
# explicitly. Keep security-rules at /security-rules because the emitted imports
# resolve there; Automation App discovers demo-scenarios below its /app workdir.
COPY --from=build /workspace/security-rules /security-rules
COPY --from=build /workspace/demo-scenarios ./demo-scenarios
CMD ["entry.js"]
