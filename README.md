# Proovra

## Local Development

### Monorepo layout
- `services/api` — API
- `services/worker` — worker
- `apps/web` — marketing + verify + dashboard (Next.js)
- `apps/mobile` — mobile app (Expo)
- `packages/shared` — shared types/schemas/constants

### Start infrastructure
```
docker compose -f infra/docker/docker-compose.yml up -d
```

Create a `.env` in the repo root with `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, and the standard
app env vars from `services/api/.env.example` and `services/worker/.env.example`.
For local MinIO over HTTP, set `S3_ALLOW_INSECURE=true`.
Leave `S3_PUBLIC_BASE_URL` empty to force signed downloads.

### Start full stack (prod-like)
```
docker compose -f infra/docker/docker-compose.full.yml up -d
```

Uses the same `.env` in the repo root.

### Production (Docker, external services)
For Hetzner deployment, use external Neon Postgres, Redis, and Cloudflare R2.
Create a `.env` in the repo root with production values (see
`services/api/.env.example` and `services/worker/.env.example`) and run:
```
docker compose -f infra/docker/docker-compose.prod.yml up -d --build
```

### Create MinIO bucket (local only)
```
docker compose -f infra/docker/docker-compose.yml exec minio mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
docker compose -f infra/docker/docker-compose.yml exec minio mc mb --ignore-existing local/proovra-prod-assets
```

### Prisma (generate + migrate + seed)
```
pnpm --filter proovra-api prisma:generate
pnpm --filter proovra-api prisma:migrate
pnpm --filter proovra-api prisma:seed
```

### Run API
```
pnpm --filter proovra-api dev
```

### Run Worker
```
pnpm --filter proovra-worker dev
```

### Run Web
```
pnpm --filter proovra-web dev
```

### Run Mobile
```
pnpm --filter proovra-mobile dev
```

### Mobile runtime smoke test (dev-only)
1) Set env: `EXPO_PUBLIC_DEBUG_SMOKE=1`
2) Launch the app and open Settings (tab)
3) Run "Runtime Smoke Test"
4) Confirm logs show: auth → create → PUT → complete → report
5) Ensure signed PUT returns 200/201 and report URL opens

### Dev shortcuts
```
pnpm dev:web
pnpm dev:mobile
pnpm dev:all
```

### Verify flow
1) Create evidence: `POST /v1/evidence`  
2) Upload via presigned PUT URL  
3) Complete: `POST /v1/evidence/:id/complete` (returns SIGNED)  
4) Worker generates report asynchronously  
5) Fetch report: `GET /v1/evidence/:id/report/latest` (download PDF from `url`)  
6) Public verify: `GET /public/verify/:id`  

Example curl:
```
BASE="http://127.0.0.1:8080"
CREATE=$(curl -sS -H "content-type: application/json" -d '{"type":"PHOTO","mimeType":"text/plain"}' "$BASE/v1/evidence")
ID=$(echo "$CREATE" | jq -r '.id')
PUT_URL=$(echo "$CREATE" | jq -r '.upload.putUrl')
curl -sS -X PUT --upload-file services/api/fixtures/sample.txt -H "content-type: text/plain" "$PUT_URL"
curl -sS -H "content-type: application/json" -d '{}' "$BASE/v1/evidence/$ID/complete"
curl -sS "$BASE/v1/evidence/$ID/report/latest"
curl -sS "$BASE/public/verify/$ID"
```

## Auth (Guest + Google + Apple)
- Guest login: `POST /v1/auth/guest`
- Google login: `POST /v1/auth/google` with `{ idToken }`
- Apple login: `POST /v1/auth/apple` with `{ idToken }`
- Current user: `GET /v1/auth/me`
- Claim guest evidence: `POST /v1/evidence/claim` with `{ guestToken, evidenceIds? }`

### Apple private key (.p8)
1) Create a Service ID and download the Sign in with Apple key (.p8).
2) Store the contents of the .p8 in `APPLE_PRIVATE_KEY` (env var), keep it secret.
3) Set the Apple env vars:
   - `APPLE_TEAM_ID`
   - `APPLE_KEY_ID`
   - `APPLE_CLIENT_ID` (Service ID, e.g. `com.proovra.web`)
   - `APPLE_REDIRECT_URI` (e.g. `https://www.proovra.com/auth/apple/callback`)

## Billing (Stripe + PayPal)
### Stripe (sandbox)
- Checkout: `POST /v1/billing/checkout/stripe`
- Webhook: `POST /webhooks/stripe`
- Use Stripe CLI for local testing:
  ```
  stripe listen --forward-to http://localhost:8080/webhooks/stripe
  ```

### PayPal (sandbox)
- Checkout: `POST /v1/billing/checkout/paypal`
- Webhook: `POST /webhooks/paypal`

## Teams
- Create invite: `POST /v1/teams/:id/invites` with `{ email, role }`
- Accept invite: `POST /v1/teams/invites/:token/accept`

## Testing
```
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Example PowerShell:
```
$base = "http://127.0.0.1:8080"
$e = Invoke-RestMethod -Method Post -Uri "$base/v1/evidence" -ContentType "application/json" -Body '{"type":"PHOTO","mimeType":"text/plain"}'
Invoke-WebRequest -Method Put -Uri $e.upload.putUrl -InFile "services/api/fixtures/sample.txt" -ContentType "text/plain" | Out-Null
Invoke-RestMethod -Method Post -Uri "$base/v1/evidence/$($e.id)/complete" -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Get -Uri "$base/v1/evidence/$($e.id)/report/latest"
Invoke-RestMethod -Method Get -Uri "$base/public/verify/$($e.id)"
```

### Production notes (Proovra)
- Domain: `proovra.com`
- Database: Neon Postgres (Frankfurt)
- Object storage: Cloudflare R2 (`proovra-prod-assets`)
- Redis: managed Redis via `REDIS_URL`
- Use `prisma migrate deploy` in production
