# Digital Witness

## Local Development

### Start infrastructure
```
docker compose -f infra/docker/docker-compose.yml up -d
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
