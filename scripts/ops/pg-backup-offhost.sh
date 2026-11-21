#!/usr/bin/env bash
# =============================================================================
# PROOVRA — the off-host copy of the database backups (OPS-004).
#
# A backup on the host it protects does not survive that host. This runs in the
# aws-cli image beside the `pg-backup` service and copies the backup directory to
# an S3-compatible bucket, then VERIFIES the newest backup at the destination:
#
#   - all four artifacts are there: proovra-<stamp>.dump, .dump.sha256, .counts
#     and .schema (the restore drill needs every one of them);
#   - each has exactly the local size;
#   - the remote .dump.sha256 is byte-for-byte the local one.
#
# The full end-to-end proof (download the remote dump, check its SHA-256 and
# restore it) is pg-backup-offhost-verify.sh. The result goes in
# .offhost-status, which pg-backup-cycle.sh records as OFFHOST_COPY.
#
# The bucket must be separate from the evidence bucket and its credential, with
# versioning and a lifecycle rule for retention (docs/runbooks/disaster-recovery.md,
# "Off-host backup destination"). Object Lock is not recommended with the pinned
# aws-cli 2.17: it sends no Content-MD5 or checksum header on upload, which S3
# requires for objects under an Object Lock retention. This script never deletes anything remotely:
# `sync` without --delete, so a credential without s3:DeleteObject suffices and
# local retention (BACKUP_RETAIN) never removes an off-host copy.
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
  # Atomic: the cycle in the other container never reads half a line. That
  # container is another image and may run as another user, and this line is a
  # stamp and an outcome, not backup content: under the script's umask it would
  # be unreadable there, and the off-host result would go unrecorded.
  printf '%s %s\n' "$1" "$2" >"$BACKUP_DIR/.offhost-status.partial"
  chmod 0644 "$BACKUP_DIR/.offhost-status.partial"
  mv "$BACKUP_DIR/.offhost-status.partial" "$BACKUP_DIR/.offhost-status"
}

# The size `aws s3 ls` reports for exactly this object name, or nothing.
remote_size() {
  local name="$1"
  aws s3 ls "${URI%/}/${name}" 2>/dev/null | awk -v n="$name" '$4 == n {print $3}' | head -n 1
}

copy_once() {
  local newest stamp name f local_size remote remote_sha
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
  case "$URI" in
    s3://?*) ;;
    *)
      echo "pg-backup-offhost: FAILED — BACKUP_S3_URI must be s3://bucket[/prefix]" >&2
      report "$stamp" FAILED
      return 1
      ;;
  esac
  for f in "proovra-${stamp}.dump" "proovra-${stamp}.dump.sha256" "proovra-${stamp}.counts" "proovra-${stamp}.schema"; do
    if [ ! -s "$BACKUP_DIR/$f" ]; then
      echo "pg-backup-offhost: FAILED — the local backup is incomplete: $f is missing" >&2
      report "$stamp" FAILED
      return 1
    fi
  done
  if ! aws s3 sync "$BACKUP_DIR" "$URI" --exclude ".*" --exclude "*/*" --no-progress --only-show-errors; then
    echo "pg-backup-offhost: FAILED — the copy did not complete" >&2
    report "$stamp" FAILED
    return 1
  fi
  # Verify the newest backup at the destination: every artifact, every size.
  for f in "proovra-${stamp}.dump" "proovra-${stamp}.dump.sha256" "proovra-${stamp}.counts" "proovra-${stamp}.schema"; do
    local_size="$(wc -c <"$BACKUP_DIR/$f" | tr -d ' ')"
    remote="$(remote_size "$f")"
    if [ -z "$remote" ]; then
      echo "pg-backup-offhost: FAILED — $f is not at the destination" >&2
      report "$stamp" FAILED
      return 1
    fi
    if [ "$remote" != "$local_size" ]; then
      echo "pg-backup-offhost: FAILED — $f is $remote bytes at the destination and $local_size bytes here" >&2
      report "$stamp" FAILED
      return 1
    fi
  done
  remote_sha="$(aws s3 cp "${URI%/}/proovra-${stamp}.dump.sha256" - 2>/dev/null || true)"
  if [ "$remote_sha" != "$(cat "$BACKUP_DIR/proovra-${stamp}.dump.sha256")" ]; then
    echo "pg-backup-offhost: FAILED — the checksum file at the destination differs from the local one" >&2
    report "$stamp" FAILED
    return 1
  fi
  report "$stamp" SUCCEEDED
  echo "pg-backup-offhost: OK proovra-${stamp}.dump copied and verified (4 artifacts, sizes and checksum file match)"
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    copy_once || true
    sleep "$INTERVAL"
  done
fi
copy_once
