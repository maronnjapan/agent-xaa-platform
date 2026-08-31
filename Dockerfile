FROM node:22-slim AS deps
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG APP
RUN test -n "$APP" && pnpm build
RUN pnpm --filter "./apps/$APP" deploy --prod /deploy
# The Agent Runtime is the one app that does not listen (DEC-APP-02), so its entry is
# main.js rather than server.js. Writing one file with a fixed name keeps the CMD below
# identical for every image; a distroless CMD cannot branch on its own.
RUN if [ "$APP" = "agent-runtime" ]; then \
      echo "import './main.js';" > /deploy/dist/entry.js; \
    else \
      echo "import './server.js';" > /deploy/dist/entry.js; \
    fi

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
ARG APP
WORKDIR /app
COPY --from=build /deploy ./
CMD ["dist/entry.js"]
