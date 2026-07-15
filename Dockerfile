FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS workspace

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_CACHE=/tmp/npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/discord-ui/package.json packages/discord-ui/package.json
COPY packages/proof/package.json packages/proof/package.json
RUN npm ci

COPY . .

RUN npm run build -w @lilac/config \
    && npm run build -w @lilac/core \
    && npm run build -w @lilac/proof \
    && npm run build -w @lilac/db \
    && npm run build -w @lilac/discord-ui

FROM workspace AS bot
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "apps/bot/src/index.ts"]

FROM workspace AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]

FROM workspace AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "packages/db/src/migrate.ts"]

FROM postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3 AS db-provision
COPY --chmod=0555 ops/provision-db-roles.sh /usr/local/bin/provision-db-roles
COPY --chmod=0444 ops/database-runtime-roles.sql /opt/lilac/database-runtime-roles.sql
# Make every migration change invalidate this image so grants are re-applied
# before newly migrated tables can be reached by a runtime service.
COPY --chmod=0444 db/migrations /opt/lilac/migrations
ENV DATABASE_ROLES_SQL_PATH=/opt/lilac/database-runtime-roles.sql
USER postgres
ENTRYPOINT ["/usr/local/bin/provision-db-roles"]

FROM workspace AS web-build
RUN npm run build -w @lilac/web

FROM web-build AS web
ENV NODE_ENV=production
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web"]
