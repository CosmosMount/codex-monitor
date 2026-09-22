FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/hub ./apps/hub
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @codex-monitor/hub... build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app /app
ENV HOST=0.0.0.0 PORT=17321 CODEX_MONITOR_DATA_PATH=/data/hub.sqlite
VOLUME ["/data"]
EXPOSE 17321
CMD ["node", "apps/hub/dist/server.js"]
