# Deployed topology record

What is known about the production deployment, and how. The repository describes
what could run. It cannot show what does. Every line below says which it is.

Written 2026-11-01 from the repository and the enterprise audit of that week. **No
production host, console or database was read for this record.** Replace each
UNVERIFIED line with what you read, the date, and who read it.

## Evidence levels

- **REPO**: stated by a versioned file. Proves intent only.
- **OBSERVED**: seen from outside, in the audit.
- **UNVERIFIED**: needs the access named.

## Components

| Component | What the evidence says | Level | To settle it |
|---|---|---|---|
| API and worker | Containers from `ghcr.io/<owner>/proovra-{api,worker}:sha-<7>`, deployed by `scripts/deploy-prod-pull.sh` as compose project `docker`, one replica each. The worker publishes no host port and its count is `WORKER_REPLICAS` (default 1); the deploy gate checks `/readyz` inside every worker container (B8-F-305) | REPO | Host shell: `docker compose ls`, `docker ps` |
| Running release | Unknown. `GET /v1/admin/platform/release` now states the API and worker builds once this release is live; `.deploy-state/releases.jsonl` records each deploy from then on | UNVERIFIED | Platform admin session, or host shell |
| Web | Vercel, deploying every `main` push whose build the `vercel.json` ignore gate lets through (live API compatible, not older than the live web) | REPO | Vercel build log lines `vercel-ignore-build:` |
| Edge | Caddy from `infra/caddy/Caddyfile`, which is not versioned. Responses show `Via: 1.1 Caddy` and no Cloudflare markers, which fits one proxy hop but is a single observation | OBSERVED, file UNVERIFIED | Read the host file and compare with `infra/caddy/Caddyfile.example` |
| Database | Contradictory. The README says Neon, `subprocessors.md` lists Neon, and the audited workstation `.env` names host `postgres`, which `docker-compose.prod.yml` does not define | UNVERIFIED | Host: the host part of `DATABASE_URL`; provider console for backups and PITR |
| Redis | Contradictory. Compose runs a local Redis; the workstation `.env` points at Upstash | UNVERIFIED | Host: host part of `REDIS_URL`; `INFO memory` for `maxmemory_policy`; the readiness item `redis_eviction_policy_unsafe` reports it once live |
| Object storage | README says Cloudflare R2; the workstation `.env` names AWS S3 `eu-central-1`; `R2_*` has no reader | UNVERIFIED | Host: `S3_ENDPOINT`; bucket replication and versioning in the provider console |
| Signing | Local PEM mounted from the host, or KMS, by `SIGNER_PROVIDER` | UNVERIFIED | Host env; `/readyz` now refuses an unregistered KMS identity |
| Bitcoin verifier | Off unless `/opt/proovra/app/secrets/bitcoin-rpc/verifier.env` exists and enables it. The worker logs `ots.bitcoin_verifier.state` at start. Node existence and sync are not visible | UNVERIFIED | Worker log line; node RPC |
| Host cron | The repository defines none. The delivery sweeps now run from the worker and are safe beside a crontab | UNVERIFIED | Host: `crontab -l`, `/etc/cron.*`, systemd timers |
| Monitoring | Whether anything is deployed is unknown. The documented command no longer starts a second stack | UNVERIFIED | Host: `docker compose ls`, Grafana access |
| Backups | The services exist and are not started by a deploy. Observed 2026-11-21: never started; the image is now pinned pg17 for the PG 17.12 server; `BACKUP_RETAIN` default 4 for ~11 GB free | UNVERIFIED | `docker compose --profile backup ps`, `platform_backup_records`, the readiness page |
| Capacity | **No user, seat or throughput figure is established.** See the audit's capacity report | not measured | A staging host of production size |
| Worker scaling | Isolated local stack, 2026-11-21 (closure/ops): 2 workers from the production service definition; 30 records with 60 duplicate report jobs gave exactly 30 reports, 30 report objects and 60 packages (one full + one external-disclosure each); 6 concurrent claims refused; reconciliation never overlapped. Peak per worker during report rendering: ~2.3 GB RAM and >3.5 CPU cores (unconstrained 32-core workstation). Production is 2 vCPU / 3 GB in total, so a second worker does not fit; one stays | measured locally, not on a production-size host | A staging host of production size with container limits |

## Configuration

`/opt/proovra/app/.env` was not read. The workstation `.env` cannot be it: it fails
production boot validation, so either the server's file differs or production runs
an older release. Nothing here is a statement of an effective production value.

`scripts/deploy-prod-pull.sh` now refuses an env file with a repeated key. If the
server's file has the duplicates the workstation copy has, **the next deploy will
stop until they are removed**. For each repeated key, Compose has been using the
last occurrence, so keep that one unless you know otherwise, and check it with
`docker compose config` before you delete the others.

## Keeping versions compatible

Migrations go first, then API, then worker, then web
(`docs/architecture/migration-deployment-plan.md`; since M676 the worker deploys
before the API). Vercel deploys `main` on merge, but its ignore gate
(`scripts/vercel-ignore-build.mjs`) skips a build that the live API does not serve
yet. The web is then released after the API, as described in `web-release-after-api.md`. A page
newer than the API, open across a release, says an update is finishing.
