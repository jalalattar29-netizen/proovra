#!/usr/bin/env bash
# =============================================================================
# PROOVRA — prove the OFF-HOST copy restores (OPS closure 2, 2026-11-21).
#
# pg-backup-offhost.sh checks sizes and the checksum file after each upload.
# This goes further, from the bucket's side: it downloads the newest off-host
# dump with its artifacts into a scratch directory, verifies the downloaded
# dump's SHA-256 against the uploaded .sha256 AND against the local record, and
# restores the RETRIEVED copy in a throwaway server (pg-restore-drill-local.sh),
# which requires the exact row counts and schema fingerprint the backup recorded.
#
# Two phases, because the tools live in two images (both are the compose
# services' own images, so each phase gets that service's environment):
#
#   fetch  in the aws-cli image (service pg-backup-offhost): list, download,
#          verify the SHA-256 against the uploaded .sha256 and the local
#          /backups/<name>.sha256 when the dump is still retained locally;
#   drill  in the pg17 image (service pg-backup): verify the SHA-256 again and
#          against platform_backup_records (when DATABASE_URL is set; read-only
#          SELECT), restore the retrieved copy, then remove the scratch.
#
#   docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml \
#     --profile backup run --rm --no-deps --entrypoint bash pg-backup-offhost /ops/pg-backup-offhost-verify.sh fetch
#   docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml \
#     --profile backup run --rm --no-deps --entrypoint bash pg-backup /ops/pg-backup-offhost-verify.sh drill
#
# Environment:
#   BACKUP_S3_URI     (fetch) required; s3://bucket/prefix
#   BACKUP_DIR        default /backups (the local backups, read-only here)
#   VERIFY_DIR        default $BACKUP_DIR/.offhost-verify (excluded from the
#                     off-host sync; removed by the drill phase unless VERIFY_KEEP=1)
#   VERIFY_STAMP      optional; a specific proovra-<stamp> instead of the newest
#   DATABASE_URL      (drill) optional; only to read the recorded sha256
#   DRILL_*           as pg-restore-drill-local.sh (free-space precheck, WAL)
#
# Disk: the dump (~1.07 GB) in VERIFY_DIR plus the drill's ~3.5 GB of scratch.
# Output never prints a URL or a credential. Exit 0 only when every check passed.
# =============================================================================
set -Eeuo pipefail
umask 077

PHASE="${1:-}"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
VERIFY_DIR="${VERIFY_DIR:-$BACKUP_DIR/.offhost-verify}"

fail() {
  echo "pg-backup-offhost-verify: FAILED — $*" >&2
  exit 1
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }
recorded_sha_of() { cut -d' ' -f1 "$1"; }

fetch() {
  local uri="${BACKUP_S3_URI:-}" name stem f
  [ -n "$uri" ] || fail "BACKUP_S3_URI is not set; there is no off-host copy to verify"
  case "$uri" in s3://?*) ;; *) fail "BACKUP_S3_URI must be s3://bucket[/prefix]" ;; esac
  command -v aws >/dev/null 2>&1 || fail "the fetch phase runs in the aws-cli image (service pg-backup-offhost)"
  if [ -n "${VERIFY_STAMP:-}" ]; then
    [[ "$VERIFY_STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "VERIFY_STAMP must look like 20261121T151057Z"
    name="proovra-${VERIFY_STAMP}.dump"
  else
    name="$(aws s3 ls "${uri%/}/" 2>/dev/null | awk '{print $4}' | grep -E '^proovra-[0-9]{8}T[0-9]{6}Z\.dump$' | sort | tail -n 1 || true)"
    [ -n "$name" ] || fail "no proovra-*.dump at the off-host destination (or it could not be listed)"
  fi
  stem="${name%.dump}"
  rm -rf "$VERIFY_DIR"
  mkdir -p "$VERIFY_DIR"
  echo "pg-backup-offhost-verify: newest off-host backup is $name"
  for f in "$name" "$name.sha256" "$stem.counts" "$stem.schema"; do
    aws s3 cp "${uri%/}/$f" "$VERIFY_DIR/$f" --no-progress --only-show-errors ||
      fail "could not download $f from the off-host destination"
    [ -s "$VERIFY_DIR/$f" ] || fail "$f downloaded empty"
  done
  verify_sums "$name"
  # The drill phase may run as another user in another image.
  chmod 0755 "$VERIFY_DIR"
  chmod 0644 "$VERIFY_DIR"/*
  printf '%s\n' "$name" >"$VERIFY_DIR/.fetched"
  chmod 0644 "$VERIFY_DIR/.fetched"
  echo "pg-backup-offhost-verify: fetch OK — $name ($(wc -c <"$VERIFY_DIR/$name" | tr -d ' ') bytes) retrieved; run the drill phase next"
}

# The retrieved dump against the uploaded .sha256, and against the local copy's
# .sha256 when the dump is still retained on the host.
verify_sums() {
  local name="$1" actual uploaded
  actual="$(sha_of "$VERIFY_DIR/$name")"
  uploaded="$(recorded_sha_of "$VERIFY_DIR/$name.sha256")"
  [ "$actual" = "$uploaded" ] ||
    fail "checksum mismatch — the retrieved $name hashes to $actual, the uploaded .sha256 says $uploaded"
  echo "pg-backup-offhost-verify: sha256 of the retrieved dump matches the uploaded .sha256 ($actual)"
  if [ -s "$BACKUP_DIR/$name.sha256" ]; then
    [ "$(recorded_sha_of "$BACKUP_DIR/$name.sha256")" = "$actual" ] ||
      fail "checksum mismatch — the retrieved $name differs from the local record $BACKUP_DIR/$name.sha256"
    echo "pg-backup-offhost-verify: sha256 matches the local record"
  else
    echo "pg-backup-offhost-verify: the local copy of $name has rotated out; compared with the uploaded .sha256 (and the database record in the drill phase)"
  fi
}

drill() {
  local name stamp recorded
  [ -s "$VERIFY_DIR/.fetched" ] || fail "nothing fetched: run the fetch phase first"
  name="$(cat "$VERIFY_DIR/.fetched")"
  [[ "$name" =~ ^proovra-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || fail "the fetch marker does not name a backup"
  stamp="${name#proovra-}"
  stamp="${stamp%.dump}"
  if [ "${VERIFY_KEEP:-0}" != "1" ]; then
    trap 'rm -rf "$VERIFY_DIR"' EXIT
  fi
  verify_sums "$name"
  if [ -n "${DATABASE_URL:-}" ]; then
    # libpq refuses Prisma's own URL parameters (as in pg-backup-cycle.sh).
    local base="${DATABASE_URL%%\?*}" query="" kept="" pair
    case "$DATABASE_URL" in *\?*) query="${DATABASE_URL#*\?}" ;; esac
    local IFS='&'
    for pair in $query; do
      case "${pair%%=*}" in
        schema | connection_limit | pool_timeout | pgbouncer | statement_cache_size | socket_timeout) ;;
        *) kept="${kept:+$kept&}$pair" ;;
      esac
    done
    unset IFS
    DATABASE_URL="${base}${kept:+?$kept}"
    export DATABASE_URL
    # Read-only: the recorded checksum of this backup, never a write.
    recorded="$(psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v stamp="$stamp" 2>/dev/null <<'SQL' || true
SET default_transaction_read_only = on;
SELECT sha256 FROM platform_backup_records
 WHERE kind = 'DATABASE_BACKUP' AND outcome = 'SUCCEEDED' AND backup_stamp = :'stamp'
 ORDER BY recorded_at_utc DESC LIMIT 1;
SQL
)"
    recorded="$(printf '%s' "$recorded" | tr -d '[:space:]')"
    if [ -n "$recorded" ]; then
      [ "$recorded" = "$(sha_of "$VERIFY_DIR/$name")" ] ||
        fail "checksum mismatch — platform_backup_records holds $recorded for $stamp"
      echo "pg-backup-offhost-verify: sha256 matches platform_backup_records"
    else
      echo "pg-backup-offhost-verify: no platform_backup_records row for $stamp could be read; the uploaded .sha256 stands"
    fi
  fi
  # The drill restores into its own throwaway server; DATABASE_URL is only used
  # by pg-restore-drill.sh to refuse restoring onto that server.
  BACKUP_FILE="$VERIFY_DIR/$name" bash "$OPS_DIR/pg-restore-drill-local.sh" ||
    fail "the retrieved off-host copy did not restore (see the drill output above)"
  echo "pg-backup-offhost-verify: PASS — the off-host copy $name was retrieved, matches its checksums, and restores with exact counts and schema"
}

case "$PHASE" in
  fetch) fetch ;;
  drill) drill ;;
  *) fail "usage: pg-backup-offhost-verify.sh fetch|drill" ;;
esac
