FROM node:24-bookworm-slim AS workspace

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

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
CMD ["npm", "run", "start", "-w", "@lilac/bot"]

FROM workspace AS worker
ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@lilac/worker"]

FROM workspace AS migrate
ENV NODE_ENV=production
CMD ["npm", "run", "migrate", "-w", "@lilac/db"]

FROM workspace AS web-build
RUN npm run build -w @lilac/web

FROM web-build AS web
ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@lilac/web"]
