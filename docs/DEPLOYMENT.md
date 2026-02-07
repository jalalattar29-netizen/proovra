# Proovra Deployment (Production)

This document covers the minimal, production-safe deployment path for
Proovra on a Linux host using Docker + Docker Compose.

## Requirements
- Docker Engine + Docker Compose plugin
- Access to Neon Postgres (Frankfurt)
- Access to Cloudflare R2 (S3-compatible)
- Redis (managed or self-hosted)

## Environment
Create `/opt/proovra/env/.env` with production values:
- `DATABASE_URL`, `DIRECT_URL`
- `REDIS_URL`
- `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- `S3_BUCKET=proovra-prod-assets`
- `SIGNING_*`
- `CORS_ORIGINS`, `VERIFY_RATE_LIMIT_*`

## Deploy
```
docker compose -f infra/docker/docker-compose.prod.yml up -d --build
```

## Health
```
curl -sS http://127.0.0.1:8080/health
curl -sS http://127.0.0.1:8090/health
```

## Caddy routing (production)
Recommended routing:
- `api.proovra.com` -> API container
- `app.proovra.com` -> Web container
- `www.proovra.com` -> Web container
- `proovra.com` -> redirect to `www.proovra.com`
