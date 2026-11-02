#!/usr/bin/env bash
# =============================================================================
# PROOVRA — one scheduled database backup cycle (OPS-004).
#
# pg-backup.sh and pg-restore-drill.sh were sound and nothing ran them. This is
# what the `pg-backup` service in infra/docker/docker-compose.prod.yml runs:
#
#   1. back up (pg-backup.sh);
#   2. restore-test on schedule, in a throwaway server inside this container
#      (pg-restore-drill-local.sh), which needs no second database anywhere;
#   3. record each outcome in platform_backup_records, which is what the readiness
#      posture reads. A script existing is not a backup running: only a row here
#      can make the posture say a backup or a restore happened;
#   4. carry over the off-host result left by pg-backup-offhost.sh.
#
# It runs in the database client image, so the client major version must be at
# least the server's. A cycle that fails records FAILED where it can and exits
# non-zero; --loop keeps going, because the next cycle may succeed.
#
# Environment:
#   DATABASE_URL                 required; the source database (never printed)
#   BACKUP_DIR                   default /opt/proovra/backups/postgres
#   BACKUP_RETAIN                see pg-backup.sh
#   BACKUP_INTERVAL_SECONDS      with --loop, default 21600
#   BACKUP_DRILL_EVERY_SECONDS   default 604800; 0 runs a drill every cycle
#
# Usage: pg-backup-cycle.sh [--loop]
# =============================================================================
set -Euo pipefail
umask 077

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DATABASE_URL:?pg-backup-cycle: DATABASE_URL is required (it is never printed)}"
BACKUP_DIR="${BACKUP_DIR:-/opt/proovra/backups/postgres}"
export BACKUP_DIR
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
DRILL_EVERY="${BACKUP_DRILL_EVERY_SECONDS:-604800}"
[[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]] || { echo "pg-backup-cycle: BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1; }
[[ "$DRILL_EVERY" =~ ^[0-9]+$ ]] || { echo "pg-backup-cycle: BACKUP_DRILL_EVERY_SECONDS must be a non-negative integer" >&2; exit 1; }

# The application URL may carry Prisma's own parameters, which libpq refuses.
# Everything libpq reads, sslmode above all, is kept.
clean_url() {
  local url="$1" base query kept="" pair
  case "$url" in
    *\?*) base="${url%%\?*}"; query="${url#*\?}" ;;
    *) printf '%s' "$url"; return ;;
  esac
  local IFS='&'
  for pair in $query; do
    case "${pair%%=*}" in
      schema | connection_limit | pool_timeout | pgbouncer | statement_cache_size | socket_timeout) ;;
      *) kept="${kept:+$kept&}$pair" ;;
    esac
  done
  printf '%s' "${base}${kept:+?$kept}"
}
DATABASE_URL="$(clean_url "$DATABASE_URL")"
export DATABASE_URL

# A record that cannot be written leaves the posture saying less than happened,
# which is the safe direction, so it warns and does not fail the cycle.
record() {
  local kind="$1" outcome="$2" stamp="${3:-}" tables="${4:-}" rows="${5:-}" bytes="${6:-}" sha="${7:-}"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -v kind="$kind" -v outcome="$outcome" -v stamp="$stamp" -v tables="$tables" \
    -v rows="$rows" -v bytes="$bytes" -v sha="$sha" >/dev/null <<'SQL' ||
INSERT INTO platform_backup_records (kind, outcome, backup_stamp, table_count, row_count, byte_count, sha256)
VALUES (:'kind', :'outcome', NULLIF(:'stamp', ''), NULLIF(:'tables', '')::int,
        NULLIF(:'rows', '')::bigint, NULLIF(:'bytes', '')::bigint, NULLIF(:'sha', ''));
SQL
    echo "pg-backup-cycle: WARNING — could not record ${kind} ${outcome}" >&2
}

carry_offhost_result() {
  local status="$BACKUP_DIR/.offhost-status" seen="$BACKUP_DIR/.offhost-recorded" line
  [ -s "$status" ] || return 0
  line="$(cat "$status")"
  [ "$line" != "$(cat "$seen" 2>/dev/null || true)" ] || return 0
  record OFFHOST_COPY "${line#* }" "${line%% *}"
  printf '%s\n' "$line" >"$seen"
}

drill_is_due() {
  [ "$DRILL_EVERY" -gt 0 ] || return 0
  local marker="$BACKUP_DIR/.last-drill" last now
  [ -s "$marker" ] || return 0
  last="$(cat "$marker")"
  now="$(date -u +%s)"
  [ $((now - last)) -ge "$DRILL_EVERY" ]
}

run_cycle() {
  local output dump stamp tables bytes sha
  if ! output="$(bash "$OPS_DIR/pg-backup.sh" 2>&1)"; then
    printf '%s\n' "$output" >&2
    record DATABASE_BACKUP FAILED
    return 1
  fi
  printf '%s\n' "$output"
  dump="$(ls -1 "$BACKUP_DIR"/proovra-*.dump | sort | tail -n 1)"
  stamp="$(basename "$dump" .dump)"
  stamp="${stamp#proovra-}"
  tables="$(wc -l <"${dump%.dump}.counts" | tr -d ' ')"
  bytes="$(wc -c <"$dump" | tr -d ' ')"
  sha="$(cut -d' ' -f1 "$dump.sha256")"
  record DATABASE_BACKUP SUCCEEDED "$stamp" "$tables" \
    "$(awk -F'|' '{s += $2} END {print s + 0}' "${dump%.dump}.counts")" "$bytes" "$sha"

  carry_offhost_result

  if drill_is_due; then
    if output="$(BACKUP_FILE="$dump" bash "$OPS_DIR/pg-restore-drill-local.sh" 2>&1)"; then
      printf '%s\n' "$output"
      date -u +%s >"$BACKUP_DIR/.last-drill"
      record RESTORE_DRILL SUCCEEDED "$stamp" "$tables" \
        "$(awk -F'|' '{s += $2} END {print s + 0}' "${dump%.dump}.counts")" "$bytes" "$sha"
    else
      printf '%s\n' "$output" >&2
      record RESTORE_DRILL FAILED "$stamp"
      return 1
    fi
  fi
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    run_cycle || echo "pg-backup-cycle: cycle FAILED; the next one runs in ${INTERVAL}s" >&2
    sleep "$INTERVAL"
  done
fi
run_cycle
