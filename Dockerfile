# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

ENV CI=true \
    NG_CLI_ANALYTICS=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install --global pnpm@10.28.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/renderer/package.json ./apps/renderer/
COPY apps/server/package.json ./apps/server/
COPY packages/backend/package.json ./packages/backend/
COPY packages/desktop-api/package.json ./packages/desktop-api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/mcp/package.json ./packages/mcp/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# `apps/desktop/` is left out of the build context; these two files replace the
# renderer's desktop declaration. See docker/electron.d.ts.
COPY docker/electron.d.ts apps/renderer/src/electron.d.ts
COPY docker/tsconfig.app.json apps/renderer/tsconfig.app.json

RUN pnpm build

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    SHADER_DATA_DIR=/data \
    SHADER_EXAMPLES_DIR=/app/examples

# The SSR bundle inlines Express and Angular and imports nothing but Node
# builtins, so the runtime image needs no node_modules at all.
COPY --from=build /app/dist/shader-studio ./dist/shader-studio
COPY --from=build /app/examples ./examples

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/shaders').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/shader-studio/server/server.mjs"]
