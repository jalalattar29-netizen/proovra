FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
RUN pnpm install --frozen-lockfile --prod=false --node-linker=hoisted

FROM deps AS build
ENV DATABASE_URL=postgresql://dw:dw_password@localhost:5432/dw
COPY services/api/src services/api/src
COPY services/api/keys services/api/keys
COPY services/api/prisma services/api/prisma
COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/tsconfig.build.json services/api/tsconfig.build.json
RUN pnpm --filter api prisma:generate
RUN pnpm --filter api build

FROM node:20-alpine AS runner
RUN apk add --no-cache wget
WORKDIR /app/services/api
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/services/api/dist ./dist
COPY --from=build /app/services/api/package.json ./package.json
COPY --from=build /app/services/api/keys ./keys
USER app
EXPOSE 8080
CMD ["node", "--experimental-specifier-resolution=node", "dist/index.js"]
