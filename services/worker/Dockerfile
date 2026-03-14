FROM node:20-alpine AS runner

RUN apk add --no-cache \
    openssl \
    ca-certificates

WORKDIR /app
RUN corepack enable

FROM base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
RUN test -n "$DATABASE_URL"
COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/prisma.config.ts
COPY services/worker/src services/worker/src
COPY services/worker/tsconfig.json services/worker/tsconfig.json
COPY services/worker/scripts services/worker/scripts
COPY services/worker/src/pdf/assets services/worker/src/pdf/assets
COPY services/worker/tsconfig.build.json services/worker/tsconfig.build.json
RUN pnpm --filter proovra-api prisma:generate
RUN pnpm --filter proovra-worker build

FROM node:20-alpine AS worker-base
RUN apk add --no-cache wget
WORKDIR /app/services/worker
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/services/worker/dist ./dist
COPY --from=build /app/services/worker/package.json ./package.json
USER app
EXPOSE 8090
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]
