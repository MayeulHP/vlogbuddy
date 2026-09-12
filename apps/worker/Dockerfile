# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable

# ffmpeg does the actual video work. yt-dlp is only used when ENABLE_YT_AUDIO
# is true (see the warning in .env.example).
RUN apk add --no-cache ffmpeg python3 py3-pip font-noto \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS runner
ENV NODE_ENV=production
ENV TMP_DIR=/tmp/vlogbuddy

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

RUN mkdir -p /tmp/vlogbuddy

CMD ["pnpm", "--filter", "@vlogbuddy/worker", "start"]
