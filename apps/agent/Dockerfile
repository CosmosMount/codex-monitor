FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent ./apps/agent
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @codex-monitor/agent... build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app /app
ENV CODEX_HOME=/codex CODEX_MONITOR_STATE_DIR=/data
VOLUME ["/codex", "/data"]
CMD ["node", "apps/agent/dist/index.js"]
