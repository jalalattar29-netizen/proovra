#!/usr/bin/env bash
# =============================================================================
# PROOVRA — PostgreSQL logical backup (AUD-023).
#
# Produces ONE consistent, verifiable backup of the database named by
# DATABASE_URL:
#
#   <BACKUP_DIR>/proovra-<UTC stamp>.dump          pg_dump custom format
#   <BACKUP_DIR>/proovra-<UTC stamp>.dump.sha256   "<sha256>  <file name>"
#   <BACKUP_DIR>/proovra-<UTC stamp>.counts        "<schema.table>|<rows>" per table
#   <BACKUP_DIR>/proovra-<UTC stamp>.schema        the schema fingerprint lines
#
# CONSISTENCY: the row counts, the schema fingerprint and the dump are all taken
# from ONE exported snapshot (REPEATABLE READ + pg_export_snapshot +
# pg_dump --snapshot), so the restore drill (pg-restore-drill.sh) can require
# the restored database to match them EXACTLY — a backup that cannot be shown
# to restore to the same rows and schema is not counted as a backup.
#
# WHAT THIS DOES NOT COVER: evidence objects live in S3 under Object Lock
# (COMPLIANCE, >= 2920 days). Their durability, versioning and any cross-region
# replication are owned by the storage infrastructure, not by this script.
#
# Requirements: bash, pg_dump, psql (PostgreSQL client >= the server's major
# version), sha256sum. On the production host without a local client, run it in
# the matching client image, e.g.
#   docker run --rm --network host -e DATABASE_URL -e BACKUP_DIR=/backups \
#     -v /opt/proovra/backups/postgres:/backups -v "$PWD/scripts/ops:/ops:ro" \
#     postgres:16 bash /ops/pg-backup.sh
#
# Environment:
#   DATABASE_URL      required; the source database (never printed)
#   BACKUP_DIR        default /opt/proovra/backups/postgres
#   BACKUP_RETAIN     number of most recent backups to keep (default 4; 0 = keep all).
#                     Sized to the production host (75 GB disk, ~11 GB free,
#                     a ~1.07 GB dump): 4 dumps hold ~4.3 GB, a fifth exists
#                     only while a backup runs (retention runs after it), and
#                     the weekly drill needs ~3.5 GB of scratch on the same
#                     disk, so the worst moment is ~7.8 GB. 14 would need
#                     ~15 GB and fill the disk before retention ever ran.
#   BACKUP_FREE_MARGIN_MB  free space kept beyond the estimate (default 1024)
#
# FREE-SPACE PRECHECK: the backup refuses to start (FAILED, exit 1) unless the
# backup directory has at least 2 x the newest dump's size + the margin free.
# With no earlier dump, the database's own size stands in for the dump (a
# compressed custom dump is smaller than the database, so this over-asks).
#
# VERSION CHECK: pg_dump refuses a server of a newer major version with a
# terse error. The majors are compared first, and a mismatch fails with the
# two versions and the image to use, so the FAILED line says why.
#
# Exit status: 0 only when the dump, its checksum and its verification facts
# were all written. Any failure removes the partial files.
# =============================================================================
set -Eeuo pipefail
umask 077

fail() {
  echo "pg-backup: FAILED — $*" >&2
  exit 1
}

: "${DATABASE_URL:?pg-backup: DATABASE_URL is required (it is never printed)}"
BACKUP_DIR="${BACKUP_DIR:-/opt/proovra/backups/postgres}"
BACKUP_RETAIN="${BACKUP_RETAIN:-4}"
BACKUP_FREE_MARGIN_MB="${BACKUP_FREE_MARGIN_MB:-1024}"

for tool in pg_dump psql sha256sum df; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is not installed"
done
[[ "$BACKUP_RETAIN" =~ ^[0-9]+$ ]] || fail "BACKUP_RETAIN must be a non-negative integer"
[[ "$BACKUP_FREE_MARGIN_MB" =~ ^[0-9]+$ ]] || fail "BACKUP_FREE_MARGIN_MB must be a non-negative integer"

mkdir -p "$BACKUP_DIR"

# --- client vs server major version (before anything is written) -------------
SERVER_VERSION_NUM="$(psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "SHOW server_version_num" 2>/dev/null | tr -d '[:space:]')" ||
  fail "could not connect to the database to read its server version"
[[ "$SERVER_VERSION_NUM" =~ ^[0-9]{5,6}$ ]] || fail "could not read the database server version"
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
CLIENT_VERSION="$(pg_dump --version 2>/dev/null)" ||
  fail "could not run 'pg_dump --version' to read the client version"
CLIENT_MAJOR="$(printf '%s\n' "$CLIENT_VERSION" | sed -nE 's/^pg_dump \(PostgreSQL\) ([0-9]+).*/\1/p')"
[[ "$CLIENT_MAJOR" =~ ^[0-9]+$ ]] || fail "could not read the pg_dump client version"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] ||
  fail "version mismatch — pg_dump client is PostgreSQL ${CLIENT_MAJOR} and the server is PostgreSQL ${SERVER_MAJOR}; pg_dump cannot dump a newer server. Run this in the pgvector/pgvector:pg${SERVER_MAJOR} image (infra/docker/docker-compose.prod.yml, service pg-backup)."

# --- free space (before anything is written) ---------------------------------
# Needed: 2 x the newest dump + the margin. With no earlier dump, the database's
# size stands in (larger than its compressed dump, so this over-asks).
LAST_DUMP="$(ls -1 "$BACKUP_DIR"/proovra-*.dump 2>/dev/null | sort | tail -n 1 || true)"
if [ -n "$LAST_DUMP" ]; then
  ESTIMATE_BYTES="$(wc -c <"$LAST_DUMP" | tr -d ' ')"
  ESTIMATE_FROM="the newest dump"
else
  ESTIMATE_BYTES="$(psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "SELECT pg_database_size(current_database())" 2>/dev/null | tr -d '[:space:]')" ||
    fail "could not read the database size for the free-space check"
  ESTIMATE_FROM="the database size (no earlier dump)"
fi
[[ "$ESTIMATE_BYTES" =~ ^[0-9]+$ ]] || fail "could not size the backup for the free-space check"
NEED_KB=$(((2 * ESTIMATE_BYTES) / 1024 + BACKUP_FREE_MARGIN_MB * 1024))
FREE_KB="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR == 2 {print $4}')" ||
  fail "could not read the free space of the backup directory"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] || fail "could not read the free space of the backup directory"
[ "$FREE_KB" -ge "$NEED_KB" ] ||
  fail "insufficient disk space — ${BACKUP_DIR} has $((FREE_KB / 1024)) MB free and needs $((NEED_KB / 1024)) MB (2 x ${ESTIMATE_FROM}, $((ESTIMATE_BYTES / 1048576)) MB, + ${BACKUP_FREE_MARGIN_MB} MB margin). Nothing was written; free space or lower BACKUP_RETAIN."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="${BACKUP_DIR}/proovra-${STAMP}"
PARTIAL="${BASE}.dump.partial"

cleanup_partial() {
  rm -f "$PARTIAL" "${BASE}.counts.partial" "${BASE}.schema.partial" "${BASE}.snapshot.partial"
}
trap cleanup_partial ERR

# shellcheck source=pg-verification-queries.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-verification-queries.sh"

# One session holds the snapshot open for the whole dump.
coproc PSQL { psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 2>&1; }
PSQL_IN="${PSQL[1]}"
PSQL_OUT="${PSQL[0]}"

psql_lines_until() {
  # Read lines from the session until the sentinel; fail on an ERROR line.
  local sentinel="$1" line
  while IFS= read -r -t 600 line <&"$PSQL_OUT"; do
    [ "$line" = "$sentinel" ] && return 0
    case "$line" in
      *ERROR:*) fail "the snapshot session reported: ${line#*ERROR:}" ;;
    esac
    printf '%s\n' "$line"
  done
  fail "the snapshot session ended before '$sentinel'"
}

printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" "SELECT '__SNAPSHOT_END__';" >&"$PSQL_IN"
# (Not via $(...): a coprocess's descriptors do not survive into a subshell.)
psql_lines_until __SNAPSHOT_END__ >"${BASE}.snapshot.partial"
SNAPSHOT="$(tail -n 1 "${BASE}.snapshot.partial")"
rm -f "${BASE}.snapshot.partial"
[[ "$SNAPSHOT" =~ ^[0-9A-F]+-[0-9A-F]+(-[0-9]+)?$ ]] || fail "could not export a snapshot"

printf '%s\n' "$PROOVRA_ROW_COUNT_SQL" "SELECT '__COUNTS_END__';" >&"$PSQL_IN"
psql_lines_until __COUNTS_END__ >"${BASE}.counts.partial"

printf '%s\n' "$PROOVRA_SCHEMA_FINGERPRINT_SQL" "SELECT '__SCHEMA_END__';" >&"$PSQL_IN"
psql_lines_until __SCHEMA_END__ >"${BASE}.schema.partial"

pg_dump --snapshot="$SNAPSHOT" --format=custom --compress=6 --no-owner --no-privileges \
  --file="$PARTIAL" --dbname="$DATABASE_URL" ||
  fail "pg_dump exited non-zero"

printf '%s\n' "COMMIT;" >&"$PSQL_IN"
exec {PSQL_IN}>&-
wait "$PSQL_PID" 2>/dev/null || true

[ -s "$PARTIAL" ] || fail "pg_dump produced an empty file"
[ -s "${BASE}.counts.partial" ] || fail "no tables were counted (empty database or failed query)"

mv "$PARTIAL" "${BASE}.dump"
mv "${BASE}.counts.partial" "${BASE}.counts"
mv "${BASE}.schema.partial" "${BASE}.schema"
(cd "$BACKUP_DIR" && sha256sum "proovra-${STAMP}.dump" >"proovra-${STAMP}.dump.sha256")
trap - ERR

TABLES="$(wc -l <"${BASE}.counts" | tr -d ' ')"
BYTES="$(wc -c <"${BASE}.dump" | tr -d ' ')"
SHA="$(cut -d' ' -f1 "${BASE}.dump.sha256")"

# Retention: keep the BACKUP_RETAIN most recent complete backups.
if [ "$BACKUP_RETAIN" -gt 0 ]; then
  mapfile -t OLD < <(ls -1 "$BACKUP_DIR"/proovra-*.dump 2>/dev/null | sort -r | tail -n +"$((BACKUP_RETAIN + 1))")
  for old in "${OLD[@]}"; do
    rm -f "$old" "$old.sha256" "${old%.dump}.counts" "${old%.dump}.schema"
  done
fi

echo "pg-backup: OK ${BASE}.dump (${BYTES} bytes, ${TABLES} tables, sha256 ${SHA})"
