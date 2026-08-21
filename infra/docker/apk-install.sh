#!/bin/sh
#
# THE Alpine package-install authority for this repository's images.
#
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# A `deploy-images` run failed at `services/worker/Dockerfile:3` on
# `apk add --no-cache openssl ca-certificates`, reporting:
#
#     WARNING: fetching https://dl-cdn.alpinelinux.org/.../APKINDEX.tar.gz: ...
#     ERROR: unable to select packages:
#       ca-certificates (no such package)
#       openssl (no such package)
#
# The packages were not missing. When apk cannot fetch APKINDEX it still runs
# its solver — against an EMPTY package universe — so every requested package
# is reported as "no such package". The transport failure is a WARNING and the
# solver failure is the ERROR, which makes a CDN blip read like a bad package
# list. In the same build, a second stage installed `ca-certificates`
# successfully, because it fetched the index a moment earlier or later.
#
# A single unguarded `apk add` therefore turns any momentary registry hiccup
# into a failed release build. This helper is the bounded retry that makes the
# fetch survivable, and it is the ONE implementation — a second copy in a
# Dockerfile would drift from this one.
#
# WHAT IT DELIBERATELY DOES NOT DO
# ---------------------------------------------------------------------------
#   * It never disables TLS verification.
#   * It never rewrites repositories to http:// or to a third-party mirror.
#     It REFUSES to run if the repository list is not HTTPS, because a retry
#     loop over a plaintext mirror would dress up a supply-chain downgrade as
#     resilience.
#   * It never swallows a failure. After the final attempt it exits with apk's
#     own non-zero status, so the layer fails and the build stops.
#   * It never loops unboundedly. Attempts and backoff are both capped.
#
# USAGE
# ---------------------------------------------------------------------------
#     apk-install openssl ca-certificates
#
# Packages are explicit arguments — never a string this script re-splits — so
# a package name can never be re-interpreted as a flag or a second word.
#
# Tunable through the environment, with safe defaults:
#     APK_INSTALL_ATTEMPTS          (default 5)
#     APK_INSTALL_BACKOFF_SECONDS   (default 2, multiplied by attempt number)
#
# POSIX sh only: this runs under Alpine's BusyBox ash, which is not bash.

set -eu

ATTEMPTS="${APK_INSTALL_ATTEMPTS:-5}"
BACKOFF_SECONDS="${APK_INSTALL_BACKOFF_SECONDS:-2}"
REPOSITORIES_FILE="${APK_REPOSITORIES_FILE:-/etc/apk/repositories}"

log() {
  # stdout so it interleaves with the build log in order; BuildKit shows it
  # per-step, which is what makes an intermittent failure diagnosable later.
  echo "apk-install: $*"
}

fail() {
  echo "apk-install: $*" >&2
}

if [ "$#" -eq 0 ]; then
  fail "no packages requested"
  exit 2
fi

case "$ATTEMPTS" in
  ''|*[!0-9]*)
    fail "APK_INSTALL_ATTEMPTS must be a positive integer (got '$ATTEMPTS')"
    exit 2
    ;;
esac
if [ "$ATTEMPTS" -lt 1 ]; then
  fail "APK_INSTALL_ATTEMPTS must be at least 1 (got '$ATTEMPTS')"
  exit 2
fi

# HTTPS ONLY.
#
# Checked rather than assumed: the whole point of retrying a fetch is that the
# fetch is trustworthy. If some earlier layer has pointed apk at plaintext or a
# mirror, retrying is the wrong response and this refuses instead.
if [ -f "$REPOSITORIES_FILE" ]; then
  if grep -qiE '^[[:space:]]*(http|ftp)://' "$REPOSITORIES_FILE"; then
    fail "refusing to install: $REPOSITORIES_FILE contains a non-HTTPS repository"
    # Same pattern, same file, and the check above already matched — so this
    # cannot fail and needs no `|| true` guard. It names the offending lines so
    # whoever hits this can see what pointed apk at plaintext.
    grep -inE '^[[:space:]]*(http|ftp)://' "$REPOSITORIES_FILE" >&2
    exit 3
  fi
fi

attempt=1
while : ; do
  log "attempt ${attempt}/${ATTEMPTS}: apk add --no-cache $*"

  if apk add --no-cache "$@"; then
    log "succeeded on attempt ${attempt}"
    exit 0
  else
    status=$?
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    fail "giving up after ${ATTEMPTS} attempt(s); apk exited ${status}"
    # apk's OWN exit status, not a synthesised one, so whatever reads this
    # layer's failure sees what actually happened.
    exit "$status"
  fi

  # A half-fetched index is exactly the state this helper exists to survive,
  # and an attempt that reuses it fails the same way. `--no-cache` means there
  # is usually nothing here; removing it is cheap and covers the case where an
  # earlier layer populated it.
  rm -rf /var/cache/apk/* 2>/dev/null || true

  delay=$(( BACKOFF_SECONDS * attempt ))
  log "attempt ${attempt} failed (apk exit ${status}); retrying in ${delay}s"
  sleep "$delay"

  attempt=$(( attempt + 1 ))
done
