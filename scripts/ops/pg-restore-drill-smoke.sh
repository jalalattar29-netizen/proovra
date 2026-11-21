#!/usr/bin/env bash
# =============================================================================
# PROOVRA — restore drill with an isolated, AUTHENTICATED application smoke
# (OPS closure 2, 2026-11-21). Runs on the Docker host, from the repository
# checkout.
#
# The phase-1 drill proved a dump restores (exact counts and schema) and that
# the API boots on it (/health, /readyz, 401 without auth). No authenticated
# journey ran. This does the same restore and then signs in:
#
#   1. a disposable PostgreSQL 17 server, a Redis and a MinIO (Object Lock
#      bucket), all on a Docker network created with --internal: no route out,
#      no published port;
#   2. pg-restore-drill.sh restores the dump (checksum, exact row counts and
#      schema fingerprint) and keeps the database;
#   3. the API image starts on that network with DUMMY configuration only: no
#      --env-file, no production credential, PROOVRA_TEST_STACK=1 (the API then
#      loads no .env, email can only go to the recording transport, and /health
#      reports the isolation facts, which are required here);
#   4. smoke: /health 200 (isolated, no env file, no live credential name),
#      /readyz 200, /v1/auth/me and /v1/evidence 401 without auth; then a
#      SYNTHETIC user is inserted into the RESTORED copy only, signs in through
#      POST /v1/auth/email/login, and /v1/auth/me answers 200 with that user;
#      /v1/evidence with the session is reported;
#   5. everything this run created is removed (by exact name), the dump is
#      untouched.
#
# SAFETY
#   - The API's DATABASE_URL is built here and must name this run's drill
#     container; anything else is refused before any container starts. An
#     inherited DATABASE_URL / DIRECT_URL that names anything else is refused.
#   - Every resource is named "${DRILL_PREFIX}<role>-<run>" and labelled
#     proovra.drill2=1; cleanup removes only those (`cleanup` mode removes
#     leftovers of earlier runs, still only by prefix AND label).
#   - Memory and CPU are bounded per container; the free disk under Docker's
#     data root is checked first (4 x the dump + margin).
#
# Usage:
#   API_IMAGE=ghcr.io/<owner>/proovra-api:sha-<7> bash scripts/ops/pg-restore-drill-smoke.sh [run]
#   bash scripts/ops/pg-restore-drill-smoke.sh cleanup
#
# Environment:
#   API_IMAGE           required (run); the API image to boot, e.g. the running sha tag
#   BACKUP_FILE         a specific dump; default: the newest proovra-*.dump in BACKUP_DIR
#   BACKUP_DIR          default /opt/proovra/backups/postgres (root-only is fine:
#                       it is then read through a no-network container)
#   DRILL_PREFIX        default proovra-drill2- (must start with "proovra-drill")
#   DRILL_FREE_MARGIN_MB  default 2048
#   DRILL_PG_MEMORY / DRILL_API_MEMORY / DRILL_MINIO_MEMORY / DRILL_REDIS_MEMORY
#                       defaults 768m / 768m / 256m / 64m
#   DRILL_API_NODE_ENV  default development (the runbook's isolated smoke)
#   DRILL_SMOKE_KEEP    1 keeps the resources for inspection (remove with `cleanup`)
#   DRILL_DISK_CHECK_PATH  only off-host (Docker Desktop): the path whose free space stands in for Docker's data root
#   PG_IMAGE, MINIO_IMAGE, MC_IMAGE, REDIS_IMAGE  pinned defaults below
#
# Exit 0 only when the restore and every required smoke check passed. Output
# never prints a URL, a password or a token.
# =============================================================================
set -Eeuo pipefail

MODE="${1:-run}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${DRILL_PREFIX:-proovra-drill2-}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd}"
MINIO_IMAGE="${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}"
MC_IMAGE="${MC_IMAGE:-pgsty/mc:RELEASE.2026-09-16T00-00-00Z}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine}"
LABEL="proovra.drill2=1"

fail() {
  echo "pg-restore-drill-smoke: FAILED — $*" >&2
  exit 1
}
say() { echo "pg-restore-drill-smoke: $*"; }

case "$PREFIX" in
  proovra-drill*) ;;
  *) fail "DRILL_PREFIX must start with 'proovra-drill' (cleanup removes by this prefix)" ;;
esac
[[ "$PREFIX" =~ ^[a-z0-9-]+$ ]] || fail "DRILL_PREFIX may hold only a-z, 0-9 and '-'"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"

# Remove resources that carry BOTH the label and the prefix; with a run id,
# only that run's.
cleanup_resources() {
  local run_filter=() name
  [ -n "${1:-}" ] && run_filter=(--filter "label=proovra.drill2.run=$1")
  for name in $(docker ps -a --filter "label=$LABEL" "${run_filter[@]}" --format '{{.Names}}'); do
    case "$name" in "$PREFIX"*) docker rm -f -v "$name" >/dev/null 2>&1 || true ;; esac
  done
  for name in $(docker volume ls --filter "label=$LABEL" "${run_filter[@]}" --format '{{.Name}}'); do
    case "$name" in "$PREFIX"*) docker volume rm "$name" >/dev/null 2>&1 || true ;; esac
  done
  for name in $(docker network ls --filter "label=$LABEL" "${run_filter[@]}" --format '{{.Name}}'); do
    case "$name" in "$PREFIX"*) docker network rm "$name" >/dev/null 2>&1 || true ;; esac
  done
}

if [ "$MODE" = "cleanup" ]; then
  cleanup_resources ""
  say "cleanup done (only resources named ${PREFIX}* and labelled $LABEL)"
  exit 0
fi
[ "$MODE" = "run" ] || fail "usage: pg-restore-drill-smoke.sh [run|cleanup]"

: "${API_IMAGE:?pg-restore-drill-smoke: API_IMAGE is required (the API image to boot, e.g. ghcr.io/<owner>/proovra-api:sha-<7>)}"
RUN="$(date -u +%Y%m%d%H%M%S)-$$"
LABELS=(--label "$LABEL" --label "proovra.drill2.run=$RUN")
NET="${PREFIX}net-${RUN}"
PG="${PREFIX}pg-${RUN}"
REDIS="${PREFIX}redis-${RUN}"
MINIO="${PREFIX}minio-${RUN}"
API="${PREFIX}api-${RUN}"
PGVOL="${PREFIX}pgdata-${RUN}"
MINIOVOL="${PREFIX}miniodata-${RUN}"
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
PW="$(rand_hex 16)"            # throwaway; never a production credential
USER_PW="$(rand_hex 18)"       # the synthetic user's password; never printed

# host:port of a postgres URL (never printed).
server_of() {
  local rest="${1#*://}"
  rest="${rest#*@}"
  printf '%s' "${rest%%/*}"
}
# The ONLY database the API may be given: this run's drill container.
assert_drill_url() {
  [ "$(server_of "$1")" = "${PG}:5432" ] || fail "refusing: the API's DATABASE_URL does not name this run's drill container"
}
for inherited in DATABASE_URL DIRECT_URL; do
  if [ -n "${!inherited:-}" ] && [ "$(server_of "${!inherited}")" != "${PG}:5432" ]; then
    fail "refusing: $inherited is set in this shell and names another server; run from a clean shell (nothing is inherited, but a production URL here is a mistake)"
  fi
done

# The dump. The production backups directory is root-only (umask 077), so when
# this user cannot read it, it is listed and sized through a throwaway container
# (no network, read-only mount) instead of asking for root.
if [ -n "${BACKUP_FILE:-}" ]; then
  DUMP_DIR="$(dirname "$BACKUP_FILE")"
  DUMP_NAME="$(basename "$BACKUP_FILE")"
else
  DUMP_DIR="${BACKUP_DIR:-/opt/proovra/backups/postgres}"
  DUMP_NAME=""
fi
case "$DUMP_DIR" in /* | [A-Za-z]:/*) ;; *) DUMP_DIR="$PWD/$DUMP_DIR" ;; esac
in_backup_dir() {
  docker run --rm --network none "${LABELS[@]}" -v "$DUMP_DIR:/b:ro" --entrypoint sh "$PG_IMAGE" -c "$1"
}
if [ -z "$DUMP_NAME" ]; then
  if [ -r "$DUMP_DIR" ] && [ -x "$DUMP_DIR" ]; then
    DUMP_NAME="$(ls -1 "$DUMP_DIR" 2>/dev/null | grep -E '^proovra-[0-9]{8}T[0-9]{6}Z\.dump$' | sort | tail -n 1 || true)"
  else
    DUMP_NAME="$(in_backup_dir 'ls -1 /b' 2>/dev/null | grep -E '^proovra-[0-9]{8}T[0-9]{6}Z\.dump$' | sort | tail -n 1 || true)"
  fi
fi
[ -n "$DUMP_NAME" ] || fail "no dump found in $DUMP_DIR; set BACKUP_FILE"
[[ "$DUMP_NAME" =~ ^proovra-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || fail "BACKUP_FILE must be a proovra-<stamp>.dump made by pg-backup.sh"
if [ -r "$DUMP_DIR/$DUMP_NAME" ]; then
  DUMP_BYTES="$(wc -c <"$DUMP_DIR/$DUMP_NAME" | tr -d ' ')"
else
  DUMP_BYTES="$(in_backup_dir "wc -c < /b/$DUMP_NAME" 2>/dev/null | tr -d ' \r' || true)"
fi
[[ "$DUMP_BYTES" =~ ^[0-9]+$ ]] && [ "$DUMP_BYTES" -gt 0 ] || fail "the dump $DUMP_NAME is missing or empty"

# Disk under Docker's data root: the restored database (~3.3 x the dump with
# bounded WAL) plus the margin.
# DRILL_DISK_CHECK_PATH: only where Docker's data root is not a host path (Docker
# Desktop keeps it inside a VM); on the production host leave it unset.
ROOT_DIR="${DRILL_DISK_CHECK_PATH:-$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)}"
[ -n "$ROOT_DIR" ] || fail "could not read Docker's data root"
FREE_KB="$(df -Pk "$ROOT_DIR" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] || fail "could not read the free space under Docker's data root"
NEED_KB=$(((4 * DUMP_BYTES) / 1024 + ${DRILL_FREE_MARGIN_MB:-2048} * 1024))
[ "$FREE_KB" -ge "$NEED_KB" ] ||
  fail "insufficient disk space — Docker's data root has $((FREE_KB / 1024)) MB free and needs $((NEED_KB / 1024)) MB (4 x the dump + margin)"
say "run $RUN: dump $DUMP_NAME ($((DUMP_BYTES / 1048576)) MB), $((FREE_KB / 1024)) MB free under Docker's data root"

if [ "${DRILL_SMOKE_KEEP:-0}" = "1" ]; then
  trap 'say "DRILL_SMOKE_KEEP=1 — resources kept; remove them with: bash scripts/ops/pg-restore-drill-smoke.sh cleanup"' EXIT
else
  trap 'cleanup_resources "$RUN"; say "removed every resource of run $RUN"' EXIT
fi

BOUNDS=(--cpus 1 --pids-limit 512)

# 1. Internal network, PG17 with bounded WAL, Redis, MinIO with an Object Lock bucket.
docker network create --internal "${LABELS[@]}" "$NET" >/dev/null
docker volume create "${LABELS[@]}" "$PGVOL" >/dev/null
docker volume create "${LABELS[@]}" "$MINIOVOL" >/dev/null
docker run -d --name "$PG" --network "$NET" "${LABELS[@]}" "${BOUNDS[@]}" --memory "${DRILL_PG_MEMORY:-768m}" \
  -v "$PGVOL:/var/lib/postgresql/data" \
  -e POSTGRES_USER=restore -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=postgres \
  "$PG_IMAGE" -c max_wal_size=256MB -c min_wal_size=80MB >/dev/null
docker run -d --name "$REDIS" --network "$NET" "${LABELS[@]}" "${BOUNDS[@]}" --memory "${DRILL_REDIS_MEMORY:-64m}" \
  "$REDIS_IMAGE" redis-server --save "" --appendonly no >/dev/null
docker run -d --name "$MINIO" --network "$NET" "${LABELS[@]}" "${BOUNDS[@]}" --memory "${DRILL_MINIO_MEMORY:-256m}" \
  -v "$MINIOVOL:/data" -e MINIO_ROOT_USER=restore -e MINIO_ROOT_PASSWORD="$PW" \
  "$MINIO_IMAGE" server /data >/dev/null
for _ in $(seq 1 120); do
  docker exec "$PG" pg_isready -U restore >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U restore >/dev/null 2>&1 || fail "the drill PostgreSQL never became ready"

# 2. Restore and verify, keeping the database.
ADMIN_URL="postgresql://restore:${PW}@${PG}:5432/postgres"
assert_drill_url "$ADMIN_URL"
RESTORE_OUT="$(docker run --rm --network "$NET" "${LABELS[@]}" --memory 512m \
  -v "$DUMP_DIR:/backups:ro" -v "$OPS_DIR:/ops:ro" \
  -e BACKUP_FILE="/backups/$DUMP_NAME" -e DRILL_ADMIN_URL="$ADMIN_URL" -e DRILL_KEEP=1 \
  "$PG_IMAGE" bash /ops/pg-restore-drill.sh 2>&1)" || { printf '%s\n' "$RESTORE_OUT" >&2; fail "the restore drill failed"; }
printf '%s\n' "$RESTORE_OUT"
DB="$(printf '%s\n' "$RESTORE_OUT" | sed -n 's/.*the restored database is kept as \(proovra_restore_drill_[0-9_]*\).*/\1/p' | tail -n 1)"
[ -n "$DB" ] || fail "could not read the restored database's name"
DRILL_DB_URL="postgresql://restore:${PW}@${PG}:5432/${DB}"
assert_drill_url "$DRILL_DB_URL"

# The MinIO bucket the API's storage contract expects (Object Lock).
for _ in $(seq 1 60); do
  docker run --rm --network "$NET" "${LABELS[@]}" --entrypoint /bin/sh "$MC_IMAGE" -c \
    "mc alias set r http://${MINIO}:9000 restore $PW >/dev/null 2>&1 && mc mb --ignore-existing --with-lock r/restore-smoke >/dev/null 2>&1" && break
  sleep 1
done

# 3. The API: explicit dummy configuration only (no --env-file), internal network only.
JWT="$(rand_hex 32)"
HASHSECRET="$(rand_hex 32)"
docker run -d --name "$API" --network "$NET" "${LABELS[@]}" "${BOUNDS[@]}" --memory "${DRILL_API_MEMORY:-768m}" \
  -e NODE_ENV="${DRILL_API_NODE_ENV:-development}" -e PROOVRA_TEST_STACK=1 -e EMAIL_TRANSPORT=recording -e PORT=8080 \
  -e NODE_OPTIONS=--max-old-space-size=512 \
  -e DATABASE_URL="$DRILL_DB_URL" -e REDIS_URL="redis://${REDIS}:6379" \
  -e S3_ENDPOINT="http://${MINIO}:9000" -e S3_REGION=us-east-1 -e S3_FORCE_PATH_STYLE=true \
  -e S3_ACCESS_KEY=restore -e S3_SECRET_KEY="$PW" -e S3_BUCKET=restore-smoke -e S3_ALLOW_INSECURE=true \
  -e AUTH_JWT_SECRET="$JWT" -e IDENTITY_SECURITY_HASH_SECRET="$HASHSECRET" \
  -e PLATFORM_MAINTENANCE_RECONCILER_ENABLED=false -e OPS_WATCHDOG_ENABLED=false \
  "$API_IMAGE" >/dev/null
# What the container actually holds: its DATABASE_URL must name the drill container.
ACTUAL_DB_URL="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API" | sed -n 's/^DATABASE_URL=//p' | head -n 1)"
assert_drill_url "$ACTUAL_DB_URL"
for _ in $(seq 1 180); do
  docker exec "$API" node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1 && break
  [ "$(docker inspect --format '{{.State.Running}}' "$API" 2>/dev/null)" = "true" ] || { docker logs --tail 40 "$API" >&2 || true; fail "the API container exited"; }
  sleep 1
done

# 4. The synthetic user, in the RESTORED copy only.
EMAIL="drill-smoke-${RUN}@restore-drill.test"
HASH="$(docker exec -e P="$USER_PW" "$API" node -e \
  'const c=require("crypto");const s=c.randomBytes(16);const k=c.scryptSync(process.env.P,s,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});process.stdout.write(`scrypt$16384$8$1$${s.toString("hex")}$${k.toString("hex")}`)')"
[[ "$HASH" =~ ^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$ ]] || fail "could not derive the synthetic password hash"
USER_ID="$(docker exec -i "$PG" psql -U restore -d "$DB" -X -q -A -t -v ON_ERROR_STOP=1 -v email="$EMAIL" -v hash="$HASH" <<'SQL'
INSERT INTO users (email, provider, provider_user_id, password_hash, email_verified_at, display_name, updated_at)
VALUES (:'email', 'EMAIL', :'email', :'hash', now(), 'Restore drill synthetic user', now())
RETURNING id;
SQL
)" || fail "could not create the synthetic user in the restored copy"
USER_ID="$(printf '%s' "$USER_ID" | tr -d '[:space:]')"
say "synthetic user created in the restored copy only (${DB})"

SMOKE_OUT="$(docker exec -i -e SMOKE_EMAIL="$EMAIL" -e SMOKE_PASSWORD="$USER_PW" -e SMOKE_USER_ID="$USER_ID" "$API" \
  node --input-type=module - 2>&1 <<'JS'
const base = "http://localhost:8080";
const out = [];
let failed = false;
const check = (name, ok, detail) => { out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed = true; };
const get = async (path, token) => {
  const r = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body };
};
const health = await get("/health");
const iso = health.body?.isolation;
check("GET /health 200, db up", health.status === 200 && health.body?.db === "up", `status ${health.status}`);
check("isolated test stack, no env file, no live credential",
  iso?.isolated === true && iso?.envFilesLoaded === 0 && Array.isArray(iso?.liveCredentialNames) && iso.liveCredentialNames.length === 0,
  iso ? `envFilesLoaded ${iso.envFilesLoaded}, live ${JSON.stringify(iso.liveCredentialNames)}, email ${iso.emailTransport}` : "no isolation block");
const ready = await get("/readyz");
check("GET /readyz 200", ready.status === 200, `status ${ready.status}`);
const meAnon = await get("/v1/auth/me");
check("GET /v1/auth/me without auth 401", meAnon.status === 401, `status ${meAnon.status}`);
const evAnon = await get("/v1/evidence");
check("GET /v1/evidence without auth 401", evAnon.status === 401, `status ${evAnon.status}`);
const login = await fetch(base + "/v1/auth/email/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }),
});
let token = null;
try { token = (await login.json())?.token ?? null; } catch { /* none */ }
check("POST /v1/auth/email/login (synthetic user) 200 with a session", login.status === 200 && typeof token === "string", `status ${login.status}`);
if (token) {
  const me = await get("/v1/auth/me", token);
  check("GET /v1/auth/me with the session 200, same user", me.status === 200 && me.body?.user?.id === process.env.SMOKE_USER_ID, `status ${me.status}`);
  const ev = await get("/v1/evidence", token);
  out.push(`INFO GET /v1/evidence with the session: status ${ev.status}`);
  const wrong = await get("/v1/auth/me", token.slice(0, -4) + "AAAA");
  check("GET /v1/auth/me with a tampered token 401", wrong.status === 401, `status ${wrong.status}`);
}
console.log(out.join("\n"));
process.exit(failed ? 1 : 0);
JS
)" && SMOKE_RC=0 || SMOKE_RC=$?
printf '%s\n' "$SMOKE_OUT" | sed 's/^/pg-restore-drill-smoke: /'
[ "$SMOKE_RC" -eq 0 ] || { docker logs --tail 40 "$API" >&2 || true; fail "the authenticated smoke did not pass"; }
say "PASS — $DUMP_NAME restored (exact counts and schema), the API served it in isolation, and a synthetic user signed in (200) where no session got 401"
