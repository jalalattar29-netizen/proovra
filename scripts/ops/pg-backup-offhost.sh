#!/usr/bin/env bash
# =============================================================================
# PROOVRA — the off-host copy of the database backups (OPS-004).
#
# A backup on the host it protects does not survive that host. This runs in the
# aws-cli image beside the `pg-backup` service and copies the backup directory to
# an S3-compatible bucket, then confirms the newest dump and its checksum are
# there. The result goes in .offhost-status, which pg-backup-cycle.sh records.
#
# The bucket should be in another account or at least another region from the
# evidence bucket, with its own credentials. Which one is the operator's choice.
# Lifecycle and retention there belong to that bucket's configuration.
#
# Environment:
#   BACKUP_S3_URI                  required; s3://bucket/prefix
#   BACKUP_DIR                     default /backups
#   BACKUP_OFFHOST_INTERVAL_SECONDS  with --loop, default 3600
#   AWS_* and AWS_ENDPOINT_URL     the usual aws-cli settings (never printed)
#
# Usage: pg-backup-offhost.sh [--loop]
# =============================================================================
set -Euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_OFFHOST_INTERVAL_SECONDS:-3600}"
URI="${BACKUP_S3_URI:-}"

report() {
  # Atomic: the cycle in the other container never reads half a line.
  printf '%s %s\n' "$1" "$2" >"$BACKUP_DIR/.offhost-status.partial"
  mv "$BACKUP_DIR/.offhost-status.partial" "$BACKUP_DIR/.offhost-status"
}

copy_once() {
  local newest stamp remote
  newest="$(ls -1 "$BACKUP_DIR"/proovra-*.dump 2>/dev/null | sort | tail -n 1 || true)"
  if [ -z "$newest" ]; then
    echo "pg-backup-offhost: no backup to copy yet"
    return 0
  fi
  stamp="$(basename "$newest" .dump)"
  stamp="${stamp#proovra-}"
  if [ -z "$URI" ]; then
    echo "pg-backup-offhost: FAILED — BACKUP_S3_URI is not set" >&2
    report "$stamp" FAILED
    return 1
  fi
  if ! aws s3 sync "$BACKUP_DIR" "$URI" --exclude ".*" --no-progress --only-show-errors; then
    echo "pg-backup-offhost: FAILED — the copy did not complete" >&2
    report "$stamp" FAILED
    return 1
  fi
  remote="$(aws s3 ls "${URI%/}/proovra-${stamp}.dump.sha256" 2>/dev/null || true)"
  if [ -z "$remote" ] || ! aws s3 ls "${URI%/}/proovra-${stamp}.dump" >/dev/null 2>&1; then
    echo "pg-backup-offhost: FAILED — the newest backup is not at the destination" >&2
    report "$stamp" FAILED
    return 1
  fi
  report "$stamp" SUCCEEDED
  echo "pg-backup-offhost: OK proovra-${stamp}.dump copied"
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    copy_once || true
    sleep "$INTERVAL"
  done
fi
copy_once
