FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates
RUN corepack enable

FROM base AS deps
ENV NODE_ENV=development

# Phase 31.22 — worker container no longer requires services/api source.
# All shared business logic lives in packages/shared-runtime; the worker
# imports from @proovra/shared-runtime and never reaches into api/src.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY services/worker/package.json services/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared-billing/package.json packages/shared-billing/package.json
COPY packages/shared-evidence-presentation/package.json packages/shared-evidence-presentation/package.json
COPY packages/shared-runtime/package.json packages/shared-runtime/package.json

RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
RUN test -n "$DATABASE_URL"

# Phase 2.7Z+ — TypeScript build memory headroom (worker variant).
#
# The worker's `pnpm --filter proovra-worker build` step below runs
# `tsc -p tsconfig.build.json` against the entire worker source tree
# (verification-package builder, report-v2 PDF renderer, intelligence
# adapters, capture-trust pipeline) plus every shared package's
# generated d.ts files in scope, plus Prisma-generated client types.
# Even on a clean checkout this is enough to exhaust the default
# V8 heap (~1.7 GB on 64-bit Linux) inside the Docker build sandbox
# with `FATAL ERROR: JavaScript heap out of memory`.
#
# Scope is INTENTIONALLY the `build` stage only — the `runner` stage
# below does not inherit this ENV, so the production worker container
# keeps its default Node heap. This is a build-time tool budget, not
# a runtime memory contract.
#
# 6144 MB (6 GB) mirrors the API build stage for consistency and
# leaves room for future growth of shared-runtime + worker source.
ENV NODE_OPTIONS="--max-old-space-size=6144"

COPY tsconfig.json ./tsconfig.json

COPY services/worker/src services/worker/src
COPY services/worker/scripts services/worker/scripts
COPY services/worker/tsconfig.json services/worker/tsconfig.json
COPY services/worker/tsconfig.build.json services/worker/tsconfig.build.json
COPY services/worker/src/pdf/assets services/worker/src/pdf/assets

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/tsconfig.build.json packages/shared/tsconfig.build.json

COPY packages/shared-billing/src packages/shared-billing/src
COPY packages/shared-billing/tsconfig.json packages/shared-billing/tsconfig.json

COPY packages/shared-evidence-presentation/src packages/shared-evidence-presentation/src
COPY packages/shared-evidence-presentation/tsconfig.json packages/shared-evidence-presentation/tsconfig.json
COPY packages/shared-evidence-presentation/tsconfig.build.json packages/shared-evidence-presentation/tsconfig.build.json

# Phase 31.22 — shared-runtime (Prisma-using business logic + DTOs
# shared between services/api and services/worker).
COPY packages/shared-runtime/src packages/shared-runtime/src
COPY packages/shared-runtime/tsconfig.json packages/shared-runtime/tsconfig.json

# Prisma schema needed by shared-runtime to type-resolve PrismaClient.
# The schema file is canonical-owned by services/api; the worker
# container still needs `prisma generate` to materialise the Prisma
# client. This is NOT a cross-import of api source — it's a build-
# time tool dependency.
COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/prisma.config.ts
COPY services/api/package.json services/api/package.json

RUN pnpm --filter @proovra/shared build
RUN pnpm --filter @proovra/shared-billing build
RUN pnpm --filter @proovra/shared-evidence-presentation build
RUN pnpm --filter proovra-api prisma:generate
RUN pnpm --filter @proovra/shared-runtime build
RUN pnpm --filter proovra-worker build

FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache \
    wget \
    openssl \
    ca-certificates \
    python3 \
    py3-pip \
    python3-dev \
    gcc \
    musl-dev \
    libffi-dev \
    chromium \
    nss \
    freetype \
    harfbuzz \
    fontconfig \
    ttf-freefont \
    ffmpeg
# `ffmpeg` (Alpine package) provides BOTH the `ffmpeg` and `ffprobe`
# binaries on PATH. ffprobe powers deterministic video/audio technical
# metadata extraction (codec / duration / dimensions / frame rate). The
# worker degrades gracefully to parseResult:"UNSUPPORTED" if ffprobe is
# ever absent at runtime — evidence completion never fails over it — so
# this install is a quality upgrade, not a hard runtime dependency.

RUN python3 -m ensurepip || true
RUN python3 -m venv /opt/ots-venv
RUN /opt/ots-venv/bin/pip install --upgrade pip setuptools wheel
# Fail the image build unless the upstream OTS CLI is actually present
# and reachable as `ots` in a standard runtime location.
RUN /opt/ots-venv/bin/pip install --no-cache-dir opentimestamps-client \
    && test -x /opt/ots-venv/bin/ots \
    && ln -sf /opt/ots-venv/bin/ots /usr/local/bin/ots \
    && /usr/local/bin/ots --help >/dev/null

ENV PATH="/opt/ots-venv/bin:$PATH"
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

COPY --from=build /app/services/worker /app/services/worker
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/shared-billing /app/packages/shared-billing
COPY --from=build /app/packages/shared-evidence-presentation /app/packages/shared-evidence-presentation
COPY --from=build /app/packages/shared-runtime /app/packages/shared-runtime
COPY --from=build /app/tsconfig.json /app/tsconfig.json

WORKDIR /app/services/worker

USER app
EXPOSE 8090
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]
