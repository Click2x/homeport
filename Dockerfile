# syntax=docker/dockerfile:1

# ---- build: install, compile, then drop dev dependencies ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY docker ./docker
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---- run: Node plus the Docker CLI and Compose plugin Homeport drives ----
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production \
    HOMEPORT_IN_CONTAINER=1 \
    HOMEPORT_DATA=/data \
    HOMEPORT_PORT=8484 \
    DOCKER_CONFIG=/tmp/.docker
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/docker ./docker
VOLUME /data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8484/api/status >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/main.js"]
