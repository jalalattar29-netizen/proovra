#!/usr/bin/env bash
# PROOVRA — the ONLY command the GitHub Actions release key may run on the host.
#
# Installed once by the owner (docs/operations/automatic-backend-release.md §2):
#
#   install -m 755 <this file> /opt/proovra/bin/proovra-release
#
# and bound to the dedicated release key in ~proovra/.ssh/authorized_keys:
#
#   command="/opt/proovra/bin/proovra-release",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA… proovra-release@github-actions
#
# sshd then runs this file whatever the client asks for; the request arrives in
# SSH_ORIGINAL_COMMAND and only these forms are accepted:
#
#   status
#   release  <40-hex commit on origin/main>
#   rollback <40-hex commit running now>
#
# It takes the host-wide release lock (one release at a time, also against a
# person running deploy-prod-pull.sh through this entry), fetches origin, and
# runs scripts/release/host-release.sh FROM THE COMMIT BEING RELEASED (from
# origin/main for status and rollback), so the release logic is always the
# reviewed, CI-tested file of that commit and never a copy left on the host.
# Nothing else — no shell, no port forwarding, no other command — is possible
# with that key.

set -Euo pipefail
umask 027

APP_DIR="${PROOVRA_APP_DIR:-/opt/proovra/app}"
LOCK_FILE="${PROOVRA_RELEASE_LOCK:-/opt/proovra/.release.lock}"
SHA40='^[0-9a-f]{40}$'

read -r -a REQ <<<"${SSH_ORIGINAL_COMMAND:-${*:-}}"
VERB="${REQ[0]:-}"
ARG="${REQ[1]:-}"
[ "${#REQ[@]}" -le 2 ] || { echo "PROOVRA_RELEASE result=USAGE"; echo "refused: too many words" >&2; exit 64; }

case "${VERB}" in
  status) [ -z "${ARG}" ] || { echo "PROOVRA_RELEASE result=USAGE"; exit 64; } ;;
  release | rollback) [[ "${ARG}" =~ ${SHA40} ]] || { echo "PROOVRA_RELEASE result=USAGE"; echo "refused: ${VERB} needs a 40-hex commit" >&2; exit 64; } ;;
  *) echo "PROOVRA_RELEASE result=USAGE"; echo "refused: allowed requests are 'status', 'release <sha>', 'rollback <sha>'" >&2; exit 64 ;;
esac

exec 9>>"${LOCK_FILE}" || { echo "PROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE"; echo "cannot open ${LOCK_FILE}" >&2; exit 10; }
if ! flock -w 1800 9; then
  echo "PROOVRA_RELEASE reason=another release holds ${LOCK_FILE} for more than 30 minutes"
  echo "PROOVRA_RELEASE result=LOCKED"
  exit 75
fi

cd "${APP_DIR}" || { echo "PROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE"; exit 10; }
if ! git fetch --quiet --tags origin </dev/null; then
  echo "PROOVRA_RELEASE reason=git fetch origin failed on the host"
  echo "PROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE"
  exit 10
fi

SOURCE_REF="origin/main"
if [ "${VERB}" = "release" ]; then
  if ! git merge-base --is-ancestor "${ARG}" origin/main 2>/dev/null; then
    echo "PROOVRA_RELEASE reason=${ARG} is not a commit on origin/main"
    echo "PROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE"
    exit 10
  fi
  SOURCE_REF="${ARG}"
fi

RUNNER="$(mktemp "${TMPDIR:-/tmp}/proovra-host-release.XXXXXX")"
trap 'rm -f "${RUNNER}"' EXIT
if ! git show "${SOURCE_REF}:scripts/release/host-release.sh" >"${RUNNER}"; then
  echo "PROOVRA_RELEASE reason=${SOURCE_REF} has no scripts/release/host-release.sh"
  echo "PROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE"
  exit 10
fi

PROOVRA_APP_DIR="${APP_DIR}" bash "${RUNNER}" "${VERB}" ${ARG:+"${ARG}"} </dev/null
exit $?
