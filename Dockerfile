FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web
RUN pnpm -r build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --prod --ignore-scripts=false
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
EXPOSE 8000
ENTRYPOINT ["node", "packages/server/dist/index.js"]
CMD ["--config", "/etc/aya/config.yaml"]
