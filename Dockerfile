# syntax=docker/dockerfile:1.7-labs
# The labs channel is what provides `COPY --parents`, and it is the only way to copy
# apps/*/package.json into the image while keeping the directory each one came from.
# Without it the manifests have to be listed one COPY per workspace package, which goes
# stale the first time an app is added. `RUN --mount` needs BuildKit too, so a build has
# to run with DOCKER_BUILDKIT=1 — the default since Docker 23, and set explicitly by
# scripts/build-images.sh.

# --------------------------------------------------------------------------------
# base: Node, plus the exact pnpm the root manifest pins.
# --------------------------------------------------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace
# Only the root manifest, so corepack's download of pnpm lands in a layer that nothing
# but a `packageManager` bump can invalidate.
COPY package.json ./
RUN corepack enable && corepack install

# --------------------------------------------------------------------------------
# deps: node_modules for the whole workspace.
# --------------------------------------------------------------------------------
# The manifests are copied on their own. This file used to copy apps/ and packages/
# before installing, which put every source edit ahead of the install and threw the
# installed tree away with it; now editing a source file leaves this layer untouched.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --parents ./apps/*/package.json ./packages/*/package.json ./
# pnpm-workspace.yaml also lists e2e and tests. Neither reaches the image (.dockerignore
# drops e2e, and nothing copies tests), and pnpm installs the importers it can see.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------------------------
# build: compile every workspace project, once for all the images.
# --------------------------------------------------------------------------------
# There is deliberately no `ARG APP` in this stage. `pnpm build` is `pnpm -r build`,
# which compiles the whole workspace whatever APP is set to, but while the stage declared
# the argument its cache key changed per image and a full `make images` run recompiled
# all 25 projects 17 times over. Keeping APP out of the stage lets every image share one
# compile; only the stage below is built per app.
FROM deps AS build
# tsconfig.base.json is what every package's tsconfig extends, and Security Detection
# imports security-rules/*.json by a path relative to the workspace root. Neither was
# copied before, so `pnpm build` could not succeed inside this image at all. They change
# far less often than the sources, so they are copied first.
COPY tsconfig.base.json ./
COPY security-rules ./security-rules
COPY packages ./packages
COPY apps ./apps
RUN pnpm build

# --------------------------------------------------------------------------------
# deploy: the one stage that varies per image.
# --------------------------------------------------------------------------------
FROM build AS deploy
ARG APP
RUN test -n "$APP" || { echo 'APP is required: docker build --build-arg APP=<directory under apps/>' >&2; exit 1; }
# pnpm 10 refuses to deploy from a workspace that does not inject its packages
# (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE). The legacy implementation copies the
# workspace packages into the deployed tree, which is exactly what the image needs.
# The store is mounted again because `deploy` resolves the production dependencies out
# of it; without the mount it would fetch every one of them from the registry again.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "./apps/$APP" deploy --legacy --prod /deploy
# The entry is the package's own `main`: dist/server.js for the listening apps,
# dist/main.js for the Agent Runtime, which does not listen (DEC-APP-02), and
# dist/src/server.js for the Automation App, whose build root also covers client/.
# Writing one file with a fixed name keeps the CMD below identical for every image;
# a distroless CMD cannot branch on its own.
RUN node -e "const main = require('/deploy/package.json').main; \
  if (!main) throw new Error('package.json has no main'); \
  require('node:fs').accessSync('/deploy/' + main); \
  require('node:fs').writeFileSync('/deploy/entry.js', 'import \"./' + main + '\";\n');"

# --------------------------------------------------------------------------------
# runtime
# --------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
COPY --from=deploy /deploy ./
# tsc emits Security Detection's `../../../../security-rules/*.json` imports unchanged,
# and four levels up from /app/dist/rules is the filesystem root, so this is where the
# deployed code looks for the rules. The other images carry the same 12 KB and ignore it.
COPY security-rules /security-rules
CMD ["entry.js"]
