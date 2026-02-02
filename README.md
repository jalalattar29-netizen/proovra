# Proovra

## Local Development

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
pnpm --filter api prisma:generate
pnpm --filter api prisma:migrate
pnpm --filter api prisma:seed
```

### Run API
```
pnpm --filter api dev
```

### Run Worker
```
pnpm --filter worker dev
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
# proovra
