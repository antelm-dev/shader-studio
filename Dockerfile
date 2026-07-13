# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

ENV CI=true \
    NG_CLI_ANALYTICS=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm install --global pnpm@10.28.2

# The Electron tooling is linked by path from a sibling checkout
# (`link:../electron-libs/*`). It takes no part in the web build, but pnpm
# refuses to install unless the link targets resolve, so stub them out.
RUN mkdir -p /electron-libs/ipc-module /electron-libs/electron-run \
    && echo '{"name":"electron-ipc-module","version":"0.0.0"}' > /electron-libs/ipc-module/package.json \
    && echo '{"name":"electron-run","version":"0.0.0"}' > /electron-libs/electron-run/package.json

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# `main/` (the Electron process) is left out of the build context; these two
# files replace what `src/` uses from it. See docker/electron.d.ts.
COPY docker/electron.d.ts src/electron.d.ts
COPY docker/tsconfig.app.json tsconfig.app.json

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
