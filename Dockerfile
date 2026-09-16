# Mentat — production image
#
# Self-hosted, single-node deployment. State lives on a mounted volume under /data,
# so the container itself is disposable: everything that matters (the SQLite
# database, the blob store and the secrets master key) is outside it.
#
#   docker build -t mentat .
#   docker run -p 5273:3000 -v mentat-data:/data -e MENTAT_MASTER_KEY=... mentat
#
# The build runs Vite under Bun because the server imports `bun:sqlite`, which Node's
# ESM loader cannot resolve.

FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Dependencies first so a source change does not invalidate the install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# `svelte-kit sync` generates the route types the typecheck depends on; the build
# itself is all that is required to produce the server bundle.
RUN bun run build


FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# Only the built output, the migration SQL and the runtime scripts are needed.
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/lib/server ./src/lib/server
COPY --from=build /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production \
    MENTAT_DB_PATH=/data/mentat.db \
    MENTAT_BLOB_ROOT=/data/blobs \
    MENTAT_DATA_DIR=/data \
    MENTAT_MIGRATIONS_DIR=/app/drizzle \
    PORT=3000 \
    HOST=0.0.0.0

# The named volume holds the database, blobs and the generated master key.
VOLUME ["/data"]
EXPOSE 3000

# The health endpoint reports database and worker status without exposing tenant data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/api/health || exit 1

# `bun` runs the adapter-node output; migrations and bootstrap happen on first request.
CMD ["bun", "./build/index.js"]
