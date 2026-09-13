# syntax=docker/dockerfile:1
#
# Built to rebuild quickly on a small machine.
#
# Three things do the work: a persistent pnpm store on a BuildKit cache mount so
# a `git pull` doesn't re-download the world, `pnpm fetch` so the download layer
# depends only on the lockfile, and a runtime stage carrying production
# dependencies only — no Next compiler, no TypeScript, no Tailwind.
#
# It also never copies apps/worker, so worker-only changes don't invalidate a
# single layer here.

FROM node:22-alpine AS base
RUN corepack enable
# CI=true keeps pnpm non-interactive: without it, install stops to ask
# before replacing the node_modules that `pnpm fetch` left behind.
ENV CI=true \
    PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --- warm the store ---------------------------------------------------------
# Only the lockfile is copied, so this layer survives every change that isn't a
# dependency change — which is nearly all of them.
FROM base AS fetch
# The root package.json comes along for `packageManager` — without it corepack
# silently pulls whatever pnpm is newest, which is neither reproducible nor
# necessarily compatible with the lockfile.
COPY pnpm-lock.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# --- manifests --------------------------------------------------------------
# Package files only: `pnpm install` here can't be invalidated by source edits.
FROM fetch AS manifests
COPY pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/

# --- dependencies (with dev, for the build) ---------------------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @vlogbuddy/web... --filter @vlogbuddy/db...

# --- dependencies (production only, for the runtime) ------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --prod \
      --filter @vlogbuddy/web... --filter @vlogbuddy/db...

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY packages ./packages
COPY apps/web ./apps/web

# Next reads config at build time; the real values arrive at runtime.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
    PUBLIC_BASE_URL=http://localhost:3000 \
    PUBLIC_STORAGE_URL=http://localhost:9000 \
    S3_ENDPOINT=http://localhost:9000 \
    S3_BUCKET=build \
    S3_ACCESS_KEY=build \
    S3_SECRET_KEY=build \
    SESSION_SECRET=build-time-placeholder-secret-value

RUN pnpm --filter @vlogbuddy/web build

# --- runtime ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/web/package.json apps/web/next.config.mjs apps/web/server.ts apps/web/tsconfig.json ./apps/web/
COPY apps/web/src ./apps/web/src
# Manifest, icons and the service worker — Next serves these straight from disk
# at runtime, so they have to exist in the runner, not just in the build stage.
COPY apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/.next ./apps/web/.next

EXPOSE 3000

# Migrations run on boot so a fresh `docker compose up` just works.
CMD ["sh", "-c", "pnpm --filter @vlogbuddy/db migrate && pnpm --filter @vlogbuddy/web start"]
