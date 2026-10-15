#!/usr/bin/env bash
# =============================================================================
# PROOVRA — PostgreSQL restore drill (AUD-023).
#
# Proves that ONE backup made by pg-backup.sh restores: it
#
#   1. verifies the dump against its recorded SHA-256 (a corrupted or
#      substituted file fails here, before anything is restored);
#   2. creates a FRESH, uniquely named database on a DISPOSABLE server
#      (DRILL_ADMIN_URL), restores the dump into it with pg_restore
#      --exit-on-error;
#   3. recomputes the row count of every table and the schema fingerprint
#      with the SAME queries the backup recorded (pg-verification-queries.sh)
#      and requires an EXACT match;
#   4. drops the drill database (unless DRILL_KEEP=1).
#
# It never touches the production database: the drill server must not be the
# server DATABASE_URL names (refused unless DRILL_ALLOW_SAME_SERVER=1, for a
# dedicated restore-test instance only).
#
# Requirements: bash, pg_restore, psql, sha256sum, diff.
#
# Environment:
#   BACKUP_FILE       required; path to proovra-<stamp>.dump
#   DRILL_ADMIN_URL   required; a URL to a DISPOSABLE server's maintenance db
#                     (e.g. postgresql://user:pw@restore-test:5432/postgres)
#   DATABASE_URL      optional; the production source, only to refuse it
#   DRILL_KEEP        1 to keep the restored database for inspection
#
# Exit status: 0 only when every check passed. Output never prints a URL.
# =============================================================================
set -Eeuo pipefail

fail() {
  echo "pg-restore-drill: FAILED — $*" >&2
  exit 1
}

: "${BACKUP_FILE:?pg-restore-drill: BACKUP_FILE is required}"
: "${DRILL_ADMIN_URL:?pg-restore-drill: DRILL_ADMIN_URL is required (a disposable server)}"

for tool in pg_restore psql sha256sum diff; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is not installed"
done

DIR="$(cd "$(dirname "$BACKUP_FILE")" && pwd)"
NAME="$(basename "$BACKUP_FILE")"
STEM="${NAME%.dump}"
[ "$STEM" != "$NAME" ] || fail "BACKUP_FILE must be a .dump made by pg-backup.sh"
for f in "$NAME" "$NAME.sha256" "$STEM.counts" "$STEM.schema"; do
  [ -s "$DIR/$f" ] || fail "missing backup artifact: $f"
done

# host:port of a postgres URL, for the same-server refusal only (never printed).
server_of() {
  local rest="${1#*://}"
  rest="${rest#*@}"
  printf '%s' "${rest%%/*}"
}
if [ -n "${DATABASE_URL:-}" ] && [ "${DRILL_ALLOW_SAME_SERVER:-0}" != "1" ]; then
  [ "$(server_of "$DATABASE_URL")" != "$(server_of "$DRILL_ADMIN_URL")" ] ||
    fail "DRILL_ADMIN_URL names the same server as DATABASE_URL; a drill restores into a DISPOSABLE server"
fi

# 1. Integrity.
(cd "$DIR" && sha256sum --check --quiet "$NAME.sha256") ||
  fail "checksum mismatch — $NAME is not the file the backup recorded"
echo "pg-restore-drill: checksum OK"

# 2. Restore into a fresh database.
DRILL_DB="proovra_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
DRILL_URL="${DRILL_ADMIN_URL%/*}/${DRILL_DB}"
case "$DRILL_ADMIN_URL" in
  *\?*) DRILL_URL="${DRILL_ADMIN_URL%%\?*}"; DRILL_URL="${DRILL_URL%/*}/${DRILL_DB}?${DRILL_ADMIN_URL#*\?}" ;;
esac

drop_drill_db() {
  if [ "${DRILL_KEEP:-0}" != "1" ]; then
    psql "$DRILL_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\" WITH (FORCE);" >/dev/null 2>&1 || true
  fi
}
trap drop_drill_db EXIT

psql "$DRILL_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DRILL_DB}\";" >/dev/null ||
  fail "could not create the drill database"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$DRILL_URL" "$DIR/$NAME" ||
  fail "pg_restore exited non-zero"
echo "pg-restore-drill: restore OK into a disposable database"

# 3. Same facts, same queries.
# shellcheck source=pg-verification-queries.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-verification-queries.sh"
WORK="$(mktemp -d)"
trap 'drop_drill_db; rm -rf "$WORK"' EXIT
psql "$DRILL_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$PROOVRA_ROW_COUNT_SQL" >"$WORK/counts" ||
  fail "could not count the restored tables"
psql "$DRILL_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$PROOVRA_SCHEMA_FINGERPRINT_SQL" >"$WORK/schema" ||
  fail "could not fingerprint the restored schema"

if ! diff -u "$DIR/$STEM.counts" "$WORK/counts" >"$WORK/counts.diff"; then
  sed -n '1,40p' "$WORK/counts.diff" >&2
  fail "restored row counts differ from the backup's recorded counts"
fi
if ! diff -u "$DIR/$STEM.schema" "$WORK/schema" >"$WORK/schema.diff"; then
  sed -n '1,40p' "$WORK/schema.diff" >&2
  fail "restored schema differs from the backup's recorded schema"
fi

TABLES="$(wc -l <"$WORK/counts" | tr -d ' ')"
ROWS="$(awk -F'|' '{s += $2} END {print s + 0}' "$WORK/counts")"
echo "pg-restore-drill: PASS — ${NAME}: checksum, ${TABLES} tables / ${ROWS} rows and the schema fingerprint match exactly"
