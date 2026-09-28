# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/kernel/package.json packages/kernel/
COPY apps/host/package.json apps/host/
COPY apps/plugin/package.json apps/plugin/
COPY apps/dashboard-api/package.json apps/dashboard-api/
COPY apps/dashboard-web/package.json apps/dashboard-web/
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY scripts/copy-assets.mjs scripts/
COPY packages/contracts/src packages/contracts/src
COPY packages/kernel/src packages/kernel/src
COPY apps/host/src apps/host/src
COPY apps/plugin/src apps/plugin/src
RUN npm run build:bins && npm prune --omit=dev

FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data \
  && chown node:node /data

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist

ENV NODE_ENV=production \
  CEREBRIUM_HOME=/data \
  MEMORY_DAEMON_RESIDENT=1

USER node
VOLUME /data

# The only daemon in the container is this one, so a pidfile left by a crash is stale.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "rm -f \"$CEREBRIUM_HOME/daemon.pid\" && exec node dist/daemon.js"]

ARG CEREBRIUM_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/MakhnoGK/cerebrium" \
  org.opencontainers.image.version="${CEREBRIUM_VERSION}"
