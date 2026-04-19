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

RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
RUN test -n "$DATABASE_URL"

COPY tsconfig.json ./tsconfig.json

COPY services/api/src services/api/src
COPY services/api/keys services/api/keys
COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/prisma.config.ts
COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/tsconfig.build.json services/api/tsconfig.build.json

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/tsconfig.build.json packages/shared/tsconfig.build.json

COPY packages/shared-billing/src packages/shared-billing/src
COPY packages/shared-billing/tsconfig.json packages/shared-billing/tsconfig.json

COPY packages/shared-evidence-presentation/src packages/shared-evidence-presentation/src
COPY packages/shared-evidence-presentation/tsconfig.json packages/shared-evidence-presentation/tsconfig.json
COPY packages/shared-evidence-presentation/tsconfig.build.json packages/shared-evidence-presentation/tsconfig.build.json

RUN pnpm --filter @proovra/shared build
RUN pnpm --filter @proovra/shared-billing build
RUN pnpm --filter @proovra/shared-evidence-presentation build
RUN pnpm --filter proovra-api prisma:generate
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
COPY --from=build /app/tsconfig.json /app/tsconfig.json

WORKDIR /app/services/api

USER app
EXPOSE 8080
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]
