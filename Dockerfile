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

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
ARG APP
WORKDIR /app
COPY --from=build /deploy ./
CMD ["dist/server.js"]
