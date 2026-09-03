# ALPINE MINOR IS PINNED, NODE MAJOR IS NOT CHANGED.
#
# `node:20-alpine` is a floating variant: it currently resolves to Alpine
# 3.23, and it will silently move to 3.24 the day upstream retags. That matters
# here because the Alpine minor decides which `/etc/apk/repositories` path is
# fetched (`/alpine/v3.23/main`), so a silent move changes the package universe
# underneath a build that was previously reproducible. `node:20-alpine3.23` is
# byte-identical to `node:20-alpine` today — same image id, same Node 20.20.2 —
# so this pins the intent without changing anything that ships.
#
# The application Node major stays 20. A Node-major migration is a separate
# piece of work with its own compatibility evidence, and this is an incident
# fix for a package-fetch failure.
FROM node:20-alpine3.23 AS base
WORKDIR /app

# THE hardened package installer, copied before ANY dependency or source layer.
#
# Placement is load-bearing. Docker invalidates every layer after a changed
# one, so if this were copied later — next to the source tree — an ordinary
# code edit would invalidate the OS-package layer and force a fresh apk fetch
# on every single build. Copied here, the installer and the packages it
# installs are cached together and an application change never touches them.
COPY --chmod=0755 infra/docker/apk-install.sh /usr/local/sbin/apk-install

# openssl is required by Prisma: its query engine links against libssl, and
# `prisma generate` in the build stage resolves the engine by detecting the
# installed OpenSSL. ca-certificates gives the build stage a trusted CA bundle
# for HTTPS registry traffic. Neither is present in node:20-alpine.
RUN apk-install openssl ca-certificates
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

# The cold store pulls the whole monorepo's tarballs at once, and pnpm's
# default two retries do not outlast a burst of registry ECONNRESETs —
# which is exactly how the full-stack build died on the first CI runs to
# reach it in days, and twice in local reproduction. Lower concurrency,
# more retries, longer backoff: the fetch becomes patient instead of
# lucky. Values are build-time only and change nothing about what is
# installed.
RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted \
    --network-concurrency=6 --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

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

# BUILD ORDER — prisma:generate MUST precede @proovra/shared-runtime.
#
# shared-runtime imports PrismaClient, Prisma and the generated enums, so
# compiling it without a generated client fails with ~58 "has no exported
# member" errors. This stage lists the steps explicitly rather than calling
# the root `build:shared` because it does not COPY every package that script
# builds; the GENERATION COMMAND is the same one the root authority runs, and
# a contract test asserts this ordering so the two cannot drift.
RUN pnpm --filter @proovra/shared build
RUN pnpm --filter @proovra/shared-billing build
RUN pnpm --filter @proovra/shared-evidence-presentation build
RUN pnpm --filter proovra-api prisma:generate
RUN pnpm --filter @proovra/shared-runtime build
RUN pnpm --filter proovra-worker build

# THE RUNNER INHERITS `base`, AND THAT IS THE POINT.
#
# It used to be a second, independent `FROM node:20-alpine`, which meant
# `openssl` and `ca-certificates` were declared and fetched TWICE in one build
# — once here and once in `base`. BuildKit has no dependency edge between two
# independent `FROM` stages, so it ran both `apk add` steps CONCURRENTLY, and
# both hit the Alpine CDN in the same instant. That is how one stage installed
# `ca-certificates` successfully while the other failed to fetch APKINDEX in
# the same build.
#
# Inheriting `base` removes the duplicate declaration, shares one package
# layer instead of building two, and gives BuildKit an ordering edge so the two
# remaining fetches are serialised rather than racing each other. The retry
# helper handles a genuinely transient failure; this removes one of the two
# chances to have one.
#
# `base` contributes exactly: WORKDIR, the apk-install helper, openssl,
# ca-certificates, and corepack shims. NODE_ENV is not inherited from `deps`
# (which sets it to development) because this stage descends from `base`, not
# from `deps`, and it sets NODE_ENV=production explicitly below.
FROM base AS runner
WORKDIR /app

# RUNTIME packages only. `openssl` and `ca-certificates` are already present
# from `base` and are deliberately not repeated.
#
# The compilers and headers that used to be here — gcc, musl-dev, python3-dev,
# libffi-dev — are GONE. They were carried to build the OpenTimestamps client,
# but `opentimestamps-client` and its dependencies install from wheels and need
# no toolchain; this was verified by building the venv with `python3` and
# `py3-pip` alone. Shipping a compiler in a production image costs image size
# and hands anything that reaches the container a build toolchain, for no
# capability the worker uses.
RUN apk-install \
    wget \
    python3 \
    py3-pip \
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

# `python3 -m ensurepip || true` used to sit here. It was a swallowed failure
# guarding a step that is not needed: `python3 -m venv` provisions pip into the
# virtualenv itself, and if it could not, the very next line fails loudly.
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
