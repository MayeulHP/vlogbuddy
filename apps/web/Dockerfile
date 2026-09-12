# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile || pnpm install

# --- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

# Next needs these at build time; real values are injected at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV PUBLIC_BASE_URL=http://localhost:3000
ENV PUBLIC_STORAGE_URL=http://localhost:9000
ENV S3_ENDPOINT=http://localhost:9000
ENV S3_BUCKET=build
ENV S3_ACCESS_KEY=build
ENV S3_SECRET_KEY=build
ENV SESSION_SECRET=build-time-placeholder-secret-value

RUN pnpm --filter @vlogbuddy/web build

# --- runtime ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app ./

EXPOSE 3000

# Migrations run on boot so a fresh `docker compose up` just works.
CMD ["sh", "-c", "pnpm --filter @vlogbuddy/db migrate && pnpm --filter @vlogbuddy/web start"]
