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
#   BACKUP_RETAIN     number of most recent backups to keep (default 14; 0 = keep all)
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
BACKUP_RETAIN="${BACKUP_RETAIN:-14}"

for tool in pg_dump psql sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is not installed"
done
[[ "$BACKUP_RETAIN" =~ ^[0-9]+$ ]] || fail "BACKUP_RETAIN must be a non-negative integer"

mkdir -p "$BACKUP_DIR"
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
