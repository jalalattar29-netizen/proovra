#!/usr/bin/env bash
# =============================================================================
# PROOVRA — the off-host copy of the database backups (OPS-004).
#
# A backup on the host it protects does not survive that host. This runs in the
# aws-cli image beside the `pg-backup` service and copies each backup to an
# S3-compatible bucket, then VERIFIES what the bucket holds.
#
# IMMUTABLE KEYS (2026-11-26). The destination may refuse to overwrite an object
# (R2 bucket lock: ObjectLockedByBucketPolicy). The earlier `aws s3 sync` re-sent
# backups that were already there, the bucket refused, and every hourly run from
# 2026-11-22 15:23Z was FAILED although the newest backup itself had uploaded. So:
#
#   - every artifact is its own immutable key, proovra-<stamp>.{dump,dump.sha256,
#     counts,schema}; nothing is ever overwritten or deleted remotely;
#   - an ABSENT key is uploaded, then its content is verified by streaming it
#     back and comparing its SHA-256 with the local one;
#   - a PRESENT key is never re-sent: its content is verified the same way (size
#     alone is not identity). Equal content counts as copied; different content
#     is a CONFLICT, reported and left untouched, never "success";
#   - a verified key is noted in $BACKUP_DIR/.offhost-verified ("<name> <sha256>"),
#     so later runs do not download it again;
#   - the NEWEST backup is handled first and on its own: its four artifacts must
#     all verify for the run to be SUCCEEDED. A problem with an OLDER backup is
#     reported (.offhost-conflicts and the log) but never changes the newest
#     backup's recorded result.
#
# The full end-to-end proof (download the remote dump, check its SHA-256 and
# restore it in a throwaway server) is pg-backup-offhost-verify.sh. The result
# goes in .offhost-status, which pg-backup-cycle.sh records as OFFHOST_COPY.
#
# The bucket must be separate from the evidence bucket and its credential, with
# a retention rule (docs/runbooks/disaster-recovery.md, "Off-host backup
# destination"). The credential needs read and write, never delete.
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
LEDGER="$BACKUP_DIR/.offhost-verified"
CONFLICTS="$BACKUP_DIR/.offhost-conflicts"
ARTIFACTS=(dump dump.sha256 counts schema)

report() {
  # Atomic: the cycle in the other container never reads half a line. That
  # container is another image and may run as another user, and this line is a
  # stamp and an outcome, not backup content: under the script's umask it would
  # be unreadable there, and the off-host result would go unrecorded.
  printf '%s %s\n' "$1" "$2" >"$BACKUP_DIR/.offhost-status.partial"
  chmod 0644 "$BACKUP_DIR/.offhost-status.partial"
  mv "$BACKUP_DIR/.offhost-status.partial" "$BACKUP_DIR/.offhost-status"
}

remote() { printf '%s/%s' "${URI%/}" "$1"; }

# The size `aws s3 ls` reports for exactly this object name, or nothing.
remote_size() {
  local name="$1"
  aws s3 ls "$(remote "$name")" 2>/dev/null | awk -v n="$name" '$4 == n {print $3}' | head -n 1
}

# The SHA-256 of the remote object's CONTENT, streamed (nothing is written to
# disk); fails when the download fails.
remote_sha() {
  local out
  out="$(set -o pipefail; aws s3 cp "$(remote "$1")" - --only-show-errors 2>/dev/null | sha256sum)" || return 1
  printf '%s' "${out%% *}"
}

# The local SHA-256: the dump's own recorded checksum (pg-backup.sh wrote and
# proved it), the small artifacts hashed directly.
local_sha() {
  local stamp="$1" ext="$2"
  if [ "$ext" = "dump" ]; then
    cut -d' ' -f1 "$BACKUP_DIR/proovra-${stamp}.dump.sha256"
  else
    # Through stdin: with a path argument, sha256sum escapes some names and
    # prefixes the line with a backslash.
    sha256sum <"$BACKUP_DIR/proovra-${stamp}.${ext}" | cut -d' ' -f1
  fi
}

ledger_has() { [ -f "$LEDGER" ] && grep -qxF "$1 $2" "$LEDGER"; }
ledger_add() { printf '%s %s\n' "$1" "$2" >>"$LEDGER"; }

# Copy-or-verify ONE artifact. Prints nothing on success; returns
#   0 verified (already there with equal content, or uploaded and verified)
#   2 CONFLICT (a different object holds this key; left untouched)
#   1 FAILED (upload, download or post-upload verification failed)
copy_artifact() {
  local stamp="$1" ext="$2" name="proovra-${stamp}.${ext}" want size remote_len got uploaded=0
  want="$(local_sha "$stamp" "$ext")"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "pg-backup-offhost: FAILED — could not read the local checksum of $name" >&2; return 1; }
  ledger_has "$name" "$want" && return 0
  size="$(wc -c <"$BACKUP_DIR/$name" | tr -d ' ')"
  remote_len="$(remote_size "$name")"
  if [ -z "$remote_len" ]; then
    if ! aws s3 cp "$BACKUP_DIR/$name" "$(remote "$name")" --no-progress --only-show-errors; then
      echo "pg-backup-offhost: FAILED — $name did not upload" >&2
      return 1
    fi
    uploaded=1
    remote_len="$(remote_size "$name")"
  fi
  if [ "$remote_len" != "$size" ]; then
    if [ "$uploaded" = 1 ]; then
      echo "pg-backup-offhost: FAILED — $name is ${remote_len:-absent} bytes at the destination after upload and $size bytes here" >&2
      return 1
    fi
    echo "pg-backup-offhost: CONFLICT — $name already exists at the destination with $remote_len bytes (here $size); it is NOT overwritten" >&2
    return 2
  fi
  if ! got="$(remote_sha "$name")"; then
    echo "pg-backup-offhost: FAILED — $name could not be read back for verification" >&2
    return 1
  fi
  if [ "$got" != "$want" ]; then
    if [ "$uploaded" = 1 ]; then
      echo "pg-backup-offhost: FAILED — $name read back with a different SHA-256 after upload" >&2
      return 1
    fi
    echo "pg-backup-offhost: CONFLICT — $name already exists at the destination with different content (SHA-256 differs); it is NOT overwritten" >&2
    return 2
  fi
  ledger_add "$name" "$want"
  return 0
}

# Every artifact of one backup. Echoes VERIFIED, CONFLICT or FAILED.
copy_stamp() {
  local stamp="$1" ext rc worst=VERIFIED
  for ext in "${ARTIFACTS[@]}"; do
    if [ ! -s "$BACKUP_DIR/proovra-${stamp}.${ext}" ]; then
      echo "pg-backup-offhost: FAILED — the local backup is incomplete: proovra-${stamp}.${ext} is missing" >&2
      echo FAILED
      return
    fi
  done
  for ext in "${ARTIFACTS[@]}"; do
    rc=0
    copy_artifact "$stamp" "$ext" || rc=$?
    case "$rc" in
      0) ;;
      2) worst=CONFLICT
         printf '%s\n' "proovra-${stamp}.${ext}" >>"$CONFLICTS.partial" ;;
      *) [ "$worst" = CONFLICT ] || worst=FAILED ;;
    esac
  done
  echo "$worst"
}

prune_ledger() {
  # Only names still retained locally need remembering.
  [ -f "$LEDGER" ] || return 0
  local tmp="$LEDGER.partial" name sha
  : >"$tmp"
  while read -r name sha; do
    [ -e "$BACKUP_DIR/$name" ] && printf '%s %s\n' "$name" "$sha" >>"$tmp"
  done <"$LEDGER"
  mv "$tmp" "$LEDGER"
}

copy_once() {
  local stamps newest stamp result older_problems=0
  stamps="$(ls -1 "$BACKUP_DIR"/proovra-*.dump 2>/dev/null | sed -E 's#^.*/proovra-##; s#\.dump$##' | sort -r || true)"
  if [ -z "$stamps" ]; then
    echo "pg-backup-offhost: no backup to copy yet"
    return 0
  fi
  newest="$(printf '%s\n' "$stamps" | head -n 1)"
  if [ -z "$URI" ]; then
    echo "pg-backup-offhost: FAILED — BACKUP_S3_URI is not set" >&2
    report "$newest" FAILED
    return 1
  fi
  case "$URI" in
    s3://?*) ;;
    *)
      echo "pg-backup-offhost: FAILED — BACKUP_S3_URI must be s3://bucket[/prefix]" >&2
      report "$newest" FAILED
      return 1
      ;;
  esac
  rm -f "$CONFLICTS.partial"

  # The newest backup first, on its own: its result is the one recorded.
  result="$(copy_stamp "$newest")"
  if [ "$result" = VERIFIED ]; then
    report "$newest" SUCCEEDED
    echo "pg-backup-offhost: OK proovra-${newest}.dump copied and verified (4 artifacts, the SHA-256 of each object at the destination matches)"
  else
    report "$newest" FAILED
    echo "pg-backup-offhost: FAILED — proovra-${newest} is ${result} at the destination" >&2
  fi

  # Then the older retained backups, best effort; they never change the above.
  for stamp in $(printf '%s\n' "$stamps" | tail -n +2); do
    case "$(copy_stamp "$stamp")" in
      VERIFIED) ;;
      *) older_problems=$((older_problems + 1)) ;;
    esac
  done
  [ "$older_problems" -eq 0 ] || echo "pg-backup-offhost: WARNING — $older_problems older backup(s) are not verified at the destination (see above)" >&2

  if [ -s "$CONFLICTS.partial" ]; then
    chmod 0644 "$CONFLICTS.partial"
    mv "$CONFLICTS.partial" "$CONFLICTS"
  else
    rm -f "$CONFLICTS.partial" "$CONFLICTS"
  fi
  prune_ledger
  [ "$result" = VERIFIED ]
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    copy_once || true
    sleep "$INTERVAL"
  done
fi
copy_once
