# syntax=docker/dockerfile:1

ARG NODE_VERSION=24.22.0

FROM node:${NODE_VERSION}-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Full install and build of every workspace package.
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Production dependencies of the server only, resolved from the lockfile.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@open-itsm/server..."

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3030 \
    WEB_ROOT=/app/public \
    APP_VERSION=${APP_VERSION}

# Application files stay root-owned so the running process cannot modify them.
COPY --from=prod-deps /repo /app
COPY --from=build /repo/packages/shared/dist /app/packages/shared/dist
COPY --from=build /repo/apps/server/dist /app/apps/server/dist
COPY --from=build /repo/apps/server/drizzle /app/apps/server/drizzle
COPY --from=build /repo/apps/web/dist /app/public
RUN mkdir -p /data/attachments /data/backups && chown -R node:node /data \
 && printf '#!/bin/sh\nexec node /app/apps/server/dist/cli.js "$@"\n' > /usr/local/bin/itsm \
 && chmod 755 /usr/local/bin/itsm

USER node
WORKDIR /app/apps/server
EXPOSE 3030
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3030/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
