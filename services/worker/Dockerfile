FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl ca-certificates
RUN corepack enable

FROM base AS deps
ENV NODE_ENV=development

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared-billing/package.json packages/shared-billing/package.json

RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
RUN test -n "$DATABASE_URL"

COPY tsconfig.json ./tsconfig.json

COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/prisma.config.ts

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

RUN pnpm --filter @proovra/shared build
RUN pnpm --filter @proovra/shared-billing build
RUN pnpm --filter proovra-api prisma:generate
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
    libffi-dev

RUN python3 -m ensurepip || true
RUN python3 -m venv /opt/ots-venv
RUN /opt/ots-venv/bin/pip install --upgrade pip setuptools wheel
RUN /opt/ots-venv/bin/pip install --no-cache-dir opentimestamps-client

ENV PATH="/opt/ots-venv/bin:$PATH"
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

COPY --from=build /app/services/worker /app/services/worker
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/shared-billing /app/packages/shared-billing
COPY --from=build /app/tsconfig.json /app/tsconfig.json

WORKDIR /app/services/worker

USER app
EXPOSE 8090
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]