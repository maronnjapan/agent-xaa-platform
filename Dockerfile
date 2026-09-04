FROM node:22-slim AS deps
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# One `pnpm build` compiles every workspace project, so all 17 images can share a single
# run of it — but only while nothing in this stage reads $APP. BuildKit folds the value of
# every build argument a command references into that command's cache key, so the earlier
# `test -n "$APP" && pnpm build` gave each app its own key and recompiled the whole
# workspace once per image. The guard now lives in the stage below, where $APP is
# unavoidable anyway, and this stage is a cache hit for images 2 through 17.
FROM deps AS build
# security-detection imports security-rules/*.json, so tsc needs the directory present.
# It is copied after the install because editing a rule must not make pnpm resolve
# dependencies again.
COPY security-rules ./security-rules
RUN pnpm build

FROM build AS deploy
ARG APP
# The guard has to sit below the compile rather than beside it, because anything that
# reads $APP takes the shared stage down with it. A missing APP therefore costs one
# compile before it is reported — which no caller here can hit, since build-images.sh
# and `make image-%` both always pass a name.
RUN test -n "$APP" || { echo 'APP build argument is required' >&2; exit 1; }
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
WORKDIR /app
COPY --from=deploy /deploy ./
# These files are read at module initialization. pnpm deploy only copies package
# contents, so repository-level runtime data must be carried into the final image
# explicitly. Keep security-rules at /security-rules because the emitted imports
# resolve there; Automation App discovers demo-scenarios below its /app workdir.
# Both come straight from the build context: routing them through an earlier stage
# would put runtime-only data upstream of the install and the compile, and every edit
# to a rule or a scenario would then invalidate both.
COPY security-rules /security-rules
COPY demo-scenarios ./demo-scenarios
CMD ["entry.js"]
