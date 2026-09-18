# syntax=docker/dockerfile:1
#
# Same shape as the web image: cached pnpm store, lockfile-only fetch layer,
# production dependencies only. It never copies apps/web, so editing the UI
# doesn't rebuild the worker — which on a small machine is most of the win,
# because the ffmpeg/yt-dlp base layer is the expensive part and it only has to
# be built once.

FROM node:22-alpine AS base
RUN corepack enable
# CI=true keeps pnpm non-interactive: without it, install stops to ask
# before replacing the node_modules that `pnpm fetch` left behind.
ENV CI=true \
    PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store
WORKDIR /app

# --- system tools -----------------------------------------------------------
# Its own stage so a dependency bump never re-runs apk or pip.
FROM base AS system
# ffmpeg does the actual video work; yt-dlp fetches the audio behind a music
# link (see the warning in .env.example).
RUN apk add --no-cache ffmpeg python3 py3-pip font-noto \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

# --- warm the store ---------------------------------------------------------
FROM base AS fetch
# The root package.json comes along for `packageManager` — without it corepack
# silently pulls whatever pnpm is newest, which is neither reproducible nor
# necessarily compatible with the lockfile.
COPY pnpm-lock.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# --- dependencies (production only — the worker is never compiled) ----------
FROM fetch AS prod-deps
COPY pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --prod \
      --filter @vlogbuddy/worker... --filter @vlogbuddy/db...

# --- runtime ----------------------------------------------------------------
FROM system AS runner
ENV NODE_ENV=production \
    TMP_DIR=/tmp/vlogbuddy

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN mkdir -p /tmp/vlogbuddy

CMD ["pnpm", "--filter", "@vlogbuddy/worker", "start"]
