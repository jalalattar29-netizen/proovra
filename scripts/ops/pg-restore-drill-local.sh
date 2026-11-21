#!/usr/bin/env bash
# =============================================================================
# PROOVRA — the restore drill with its own throwaway server (OPS-004).
#
# pg-restore-drill.sh needs a disposable PostgreSQL server. In the database image
# one can be started here, on loopback, with its data in a temporary directory,
# so a scheduled drill needs no second database and cannot reach production. The
# server and its data are removed when this exits, pass or fail.
#
# Environment: BACKUP_FILE (required), as pg-restore-drill.sh.
#   DRILL_MAX_WAL_SIZE / DRILL_MIN_WAL_SIZE  default 256MB / 80MB. Measured on
#     the production dump (1.07 GB custom format): a restore with the default
#     WAL settings used ~5.6 GB of disk, with max_wal_size=256MB ~3.5 GB. The
#     drill shares the host disk with the backups, so WAL is bounded here.
#   DRILL_FREE_MARGIN_MB  default 1024. The drill refuses to start (FAILED,
#     exit 1) unless its scratch directory has 4 x the dump + this margin free
#     (the measured restore needed ~3.3 x the dump with bounded WAL).
# =============================================================================
set -Eeuo pipefail

: "${BACKUP_FILE:?pg-restore-drill-local: BACKUP_FILE is required}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DRILL_LOCAL_PORT:-55432}"
DRILL_MAX_WAL_SIZE="${DRILL_MAX_WAL_SIZE:-256MB}"
DRILL_MIN_WAL_SIZE="${DRILL_MIN_WAL_SIZE:-80MB}"
DRILL_FREE_MARGIN_MB="${DRILL_FREE_MARGIN_MB:-1024}"
[[ "$DRILL_FREE_MARGIN_MB" =~ ^[0-9]+$ ]] || { echo "pg-restore-drill-local: FAILED — DRILL_FREE_MARGIN_MB must be a non-negative integer" >&2; exit 1; }
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
[ -n "$PG_BIN" ] && PATH="$PG_BIN:$PATH"
for tool in initdb pg_ctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "pg-restore-drill-local: FAILED — '$tool' is not installed" >&2; exit 1; }
done

DATA="$(mktemp -d /tmp/proovra-drill-XXXXXX)"
# Free-space precheck: 4 x the dump + the margin, in the scratch directory.
DUMP_BYTES="$(wc -c <"$BACKUP_FILE" 2>/dev/null | tr -d " " || true)"
FREE_KB="$(df -Pk "$DATA" | awk 'NR == 2 {print $4}')"
if [[ "$DUMP_BYTES" =~ ^[0-9]+$ ]] && [[ "$FREE_KB" =~ ^[0-9]+$ ]]; then
  NEED_KB=$(((4 * DUMP_BYTES) / 1024 + DRILL_FREE_MARGIN_MB * 1024))
  if [ "$FREE_KB" -lt "$NEED_KB" ]; then
    rm -rf "$DATA"
    echo "pg-restore-drill-local: FAILED — insufficient disk space — the drill scratch has $((FREE_KB / 1024)) MB free and needs $((NEED_KB / 1024)) MB (4 x the $((DUMP_BYTES / 1048576)) MB dump + ${DRILL_FREE_MARGIN_MB} MB margin)" >&2
    exit 1
  fi
else
  rm -rf "$DATA"
  echo "pg-restore-drill-local: FAILED — could not size the dump or the free space of the drill scratch" >&2
  exit 1
fi
# initdb refuses a user it cannot name, and a container started with --user for
# a host UID has no passwd entry. The image's own entrypoint answers this with
# libnss_wrapper, so do the same: give the current UID a name for this drill.
if [ "$(id -u)" -ne 0 ] && ! id -un >/dev/null 2>&1; then
  for wrapper in /usr/lib/*/libnss_wrapper.so /usr/lib/libnss_wrapper.so; do
    [ -s "$wrapper" ] || continue
    export LD_PRELOAD="$wrapper" NSS_WRAPPER_PASSWD="$DATA/passwd" NSS_WRAPPER_GROUP="$DATA/group"
    printf 'postgres:x:%s:%s:PostgreSQL:%s:/bin/false\n' "$(id -u)" "$(id -g)" "$DATA" >"$NSS_WRAPPER_PASSWD"
    printf 'postgres:x:%s:\n' "$(id -g)" >"$NSS_WRAPPER_GROUP"
    break
  done
fi
as_server() {
  if [ "$(id -u)" -eq 0 ]; then
    chown -R postgres:postgres "$DATA"
    gosu postgres "$@"
  else
    "$@"
  fi
}
stop_server() {
  as_server pg_ctl -D "$DATA/pg" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap stop_server EXIT

as_server initdb -D "$DATA/pg" -U drill --auth=trust --encoding=UTF8 --locale=C >/dev/null
as_server pg_ctl -D "$DATA/pg" -w -l "$DATA/server.log" \
  -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DATA -c fsync=off -c max_wal_size=${DRILL_MAX_WAL_SIZE} -c min_wal_size=${DRILL_MIN_WAL_SIZE}" start >/dev/null
echo "pg-restore-drill-local: drill server max_wal_size=$(psql "postgresql://drill@127.0.0.1:${PORT}/postgres" -X -q -A -t -c "SHOW max_wal_size") min_wal_size=$(psql "postgresql://drill@127.0.0.1:${PORT}/postgres" -X -q -A -t -c "SHOW min_wal_size")"

DRILL_ADMIN_URL="postgresql://drill@127.0.0.1:${PORT}/postgres" BACKUP_FILE="$BACKUP_FILE" \
  bash "$OPS_DIR/pg-restore-drill.sh"
