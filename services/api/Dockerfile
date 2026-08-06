FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
ENV NODE_ENV=development

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared-billing/package.json packages/shared-billing/package.json
COPY packages/shared-evidence-presentation/package.json packages/shared-evidence-presentation/package.json
# Phase 31.22 — shared-runtime package required by services/api.
COPY packages/shared-runtime/package.json packages/shared-runtime/package.json

RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
RUN test -n "$DATABASE_URL"

# Phase 2.7Z+ — TypeScript build memory headroom.
#
# The `pnpm --filter proovra-api build` step below invokes
# `tsc -p tsconfig.build.json` against the full API source tree
# (hundreds of files, ~all-strict checks, every shared package's
# generated d.ts files in scope, Prisma-generated client types).
# Inside the Docker build sandbox the default Node V8 heap (~1.7 GB
# on 64-bit Linux) is not enough — tsc's checker phase exhausts it
# and dies with `FATAL ERROR: JavaScript heap out of memory`.
#
# Scope is INTENTIONALLY the `build` stage only — the `runner` stage
# below does not inherit this ENV, so the production runtime container
# keeps its default Node heap. This is a build-time tool budget, not a
# runtime memory contract.
#
# 6144 MB (6 GB) chosen over 4096 MB because the API tree has been
# observed to need ≥5 GB during typecheck; a small headroom prevents
# bouncing the limit on future schema growth. The build host always
# has enough free memory (build runners run with 8–16 GB).
ENV NODE_OPTIONS="--max-old-space-size=6144"

COPY tsconfig.json ./tsconfig.json

COPY services/api/src services/api/src
# PHASE 12 — POINT 8: `services/api/keys` is NOT copied.
#
# It holds the repository's committed dev/test signing fixture. The runner
# stage below does `COPY --from=build /app/services/api`, so copying the
# fixture here put a real Ed25519 private key — one that is public in Git —
# inside the production image, one unset environment variable away from
# signing evidence that a verifier could not tell from the genuine article.
# Production supplies its key by mount or by SIGNING_PRIVATE_KEY_PEM; the
# build needs no key at all. `assertNotCommittedFixture` refuses the fixture
# by public-key fingerprint as the second line of defence.
COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/prisma.config.ts
COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/tsconfig.build.json services/api/tsconfig.build.json
# Phase 2.7Z+ — Deployment scripts must be present in the runtime image so
# operators can invoke `pnpm prisma:migrate`, `pnpm deploy:safe`,
# `pnpm db:preflight`, `pnpm db:risk-scan`, `pnpm db:drift-check`,
# `pnpm db:check-org-consistency`, and `pnpm db:not-null-readiness`
# directly inside the running container WITHOUT needing `docker cp` to
# patch the image post-hoc. The runner stage's
# `COPY --from=build /app/services/api /app/services/api` (below) carries
# this directory into the final image.
#
# Files in this directory are pure .mjs (no transpile step) and depend
# only on packages already present in the runner's node_modules:
#   - safe-migrate.mjs            → ./db-host-policy.mjs (sibling)
#   - db-preflight.mjs            → ./db-host-policy.mjs, ./migration-risk-scan.mjs,
#                                    ./drift-check.mjs, ./protected-runtime-tables.mjs
#   - deploy-safe.mjs             → spawns the above siblings via `node scripts/X.mjs`
#   - check-org-consistency.mjs   → @prisma/client + @prisma/adapter-pg + pg
#                                    (all in deps stage)
#   - migration-risk-scan.mjs     → ./protected-runtime-tables.mjs
#   - drift-check.mjs             → pnpm exec prisma (CLI; in deps)
#   - not-null-readiness.mjs      → @prisma/client (in deps)
#   - backfill-organizations.mjs  → @prisma/client (in deps)
#   - protected-runtime-tables.mjs → exported list, no runtime deps
#
# All of those sibling files are inside scripts/; the recursive COPY
# below picks them up in one directive.
COPY services/api/scripts services/api/scripts

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/tsconfig.build.json packages/shared/tsconfig.build.json

COPY packages/shared-billing/src packages/shared-billing/src
COPY packages/shared-billing/tsconfig.json packages/shared-billing/tsconfig.json

COPY packages/shared-evidence-presentation/src packages/shared-evidence-presentation/src
COPY packages/shared-evidence-presentation/tsconfig.json packages/shared-evidence-presentation/tsconfig.json
COPY packages/shared-evidence-presentation/tsconfig.build.json packages/shared-evidence-presentation/tsconfig.build.json

# Phase 31.22 — shared-runtime package (Prisma-using business logic).
COPY packages/shared-runtime/src packages/shared-runtime/src
COPY packages/shared-runtime/tsconfig.json packages/shared-runtime/tsconfig.json

RUN pnpm --filter @proovra/shared build
RUN pnpm --filter @proovra/shared-billing build
RUN pnpm --filter @proovra/shared-evidence-presentation build
RUN pnpm --filter proovra-api prisma:generate
RUN pnpm --filter @proovra/shared-runtime build
RUN pnpm --filter proovra-api build

FROM node:20-alpine AS runner
RUN apk add --no-cache wget curl openssl ca-certificates
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

COPY --from=build /app/services/api /app/services/api
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/shared-billing /app/packages/shared-billing
COPY --from=build /app/packages/shared-evidence-presentation /app/packages/shared-evidence-presentation
COPY --from=build /app/packages/shared-runtime /app/packages/shared-runtime
COPY --from=build /app/tsconfig.json /app/tsconfig.json

WORKDIR /app/services/api

USER app
EXPOSE 8080
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]
