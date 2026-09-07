FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://omnistudio:build-only@localhost:5432/omnistudio npm run db:generate && npm run build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS api-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @omnistudio/api --include-workspace-root && npm cache clean --force

FROM api-deps AS api-runtime-deps
RUN npm pkg delete dependencies.prisma devDependencies.typescript --workspace @omnistudio/api \
    && npm prune --omit=dev --omit=peer --workspace @omnistudio/api --include-workspace-root \
    && rm -rf node_modules/prisma node_modules/@prisma/engines node_modules/typescript node_modules/esbuild node_modules/@esbuild \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && test ! -e /usr/local/lib/node_modules/npm \
    && test ! -e node_modules/prisma \
    && test ! -e node_modules/@prisma/engines \
    && test ! -e node_modules/typescript \
    && test ! -e node_modules/esbuild \
    && test ! -e node_modules/@esbuild \
    && node -e "for (const id of ['@prisma/client/package.json', '@prisma/adapter-pg', 'pg', 'sharp', 'argon2', 'bullmq']) require.resolve(id)"

FROM api-runtime-deps AS api
ENV NODE_ENV=production
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/api/dist ./apps/api/dist
RUN test ! -e node_modules/prisma \
    && test ! -e node_modules/@prisma/engines \
    && test ! -e node_modules/typescript \
    && test ! -e node_modules/esbuild \
    && test ! -e node_modules/@esbuild \
    && node -e "for (const id of ['./apps/api/dist/generated/prisma/client.js', '@prisma/adapter-pg', 'pg', 'sharp', 'argon2', 'bullmq']) require(id)" \
    && mkdir -p /data/media \
    && chown -R node:node /app /data/media
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM api-deps AS migrate
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist/load-secret-files.js ./apps/api/dist/load-secret-files.js
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
RUN test -f node_modules/prisma/build/index.js \
    && node node_modules/prisma/build/index.js --version \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && test ! -e /usr/local/lib/node_modules/npm
USER node
CMD ["node", "--require", "./apps/api/dist/load-secret-files.js", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "apps/api/prisma.config.ts"]

FROM nginx:1.31.5-alpine3.24@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3 AS web
RUN apk upgrade --no-cache
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
