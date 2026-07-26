# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

ENV CI=true \
    NG_CLI_ANALYTICS=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install --global pnpm@10.28.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY apps/desktop/package.json ./apps/desktop/
COPY libs/backend/package.json ./libs/backend/
COPY libs/desktop-api/package.json ./libs/desktop-api/
COPY libs/shared/package.json ./libs/shared/
COPY tools/mcp/package.json ./tools/mcp/
COPY tools/workspace/package.json ./tools/workspace/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# The web declarations consume the generated, typed Electron IPC contract even
# though the runtime image does not contain Electron. Generate it in the build
# stage, then produce the SSR bundle (which keeps `pg` external; see
# apps/web/angular.json) and the standalone migrate-files CLI.
RUN pnpm gen:ipc \
    && pnpm build \
    && pnpm --filter @shader-studio/server build:cli

# The runtime needs the PostgreSQL driver at runtime (it is deliberately not
# bundled into the SSR output). Install just `pg` and its deps into an isolated
# tree so the runtime image stays minimal.
RUN mkdir -p /runtime-deps && cd /runtime-deps \
    && npm init -y >/dev/null 2>&1 \
    && npm install --omit=dev --no-package-lock pg@8.13.1

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    SHADER_DATA_DIR=/data \
    SHADER_EXAMPLES_DIR=/app/examples

# SSR bundle + examples + the CLI, plus the pg driver the server imports at
# runtime. Everything else (Express, Angular) is inlined into the bundle.
COPY --from=build /app/dist/shader-studio ./dist/shader-studio
COPY --from=build /app/examples ./examples
COPY --from=build /runtime-deps/node_modules ./node_modules

# A local SQLite file is only used when DATABASE_URL is unset (Compose always
# sets it, selecting PostgreSQL). /data stays available for that fallback and as
# a mount point for a legacy library to import.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/shaders').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/shader-studio/server/server.mjs"]
