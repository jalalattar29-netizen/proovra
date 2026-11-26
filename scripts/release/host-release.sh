#!/usr/bin/env bash
# PRODUCTION BACKEND RELEASE — the host side of .github/workflows/backend-release.yml.
#
# It is never run by hand with arguments from a person's memory. The GitHub
# Actions release job connects with a dedicated deploy key whose authorized_keys
# line forces the fixed entry point /opt/proovra/bin/proovra-release
# (infra/host/proovra-release-entry.sh). That entry point validates the request,
# takes the host-wide release lock, fetches origin and runs THIS file from the
# exact commit being released (or from origin/main for `status`/`rollback`):
#
#   host-release.sh status
#   host-release.sh release  <40-hex release SHA>
#   host-release.sh rollback <40-hex SHA expected to be running now>
#
# It wraps the established deploy script (scripts/deploy-prod-pull.sh) and adds
# exactly what an unattended release needs around it:
#
#   release:
#     1. preflight — clean checkout; the running API and worker are ONE immutable
#        release (same revision label, its sha-<7> images re-pulled and proven),
#        which is recorded as the rollback point BEFORE anything changes;
#        ahead of that (before the backup and before any image pull), proven disk and
#        inode headroom; when short, obsolete PROOVRA images are removed by
#        exact tag, and when still short the release is refused (nothing
#        changed);
#     2. a fresh database backup (scripts/ops/pg-backup.sh in the pinned pg17
#        backup image), then proven: the dump's checksum verifies and
#        pg_restore can read its table of contents;
#     3. deploy-prod-pull.sh --plan, then the deploy itself (worker, then API;
#        revision labels, runtime schema gate, health + /readyz of each);
#     4. verification of what actually runs: every container's image tag and
#        revision label, Docker health, the worker's /readyz inside each
#        container, the API's /readyz, and /health's revision, contract and
#        route epoch against the release commit's own release contract;
#        once verified, targeted retention removes obsolete PROOVRA API/worker
#        images (never one a container uses, the release or the rollback
#        pair); it only reports and can never fail or roll back the release;
#     5. on ANY failure after a service changed: deploy-prod-pull.sh --rollback
#        (API first) to the recorded point, then the same verification of the
#        rollback. A failure before anything changed restores the checkout and
#        restarts nothing.
#
# Output: human-readable progress plus machine lines `PROOVRA_RELEASE key=value`
# that the workflow parses. The final line is `PROOVRA_RELEASE result=<RESULT>`.
# No environment value is ever printed.
#
# Exit codes (the workflow maps each to a commit status; none is ever "success"
# unless the release was verified):
#   0   DEPLOYED                    release verified
#   10  REFUSED_BEFORE_CHANGE       nothing restarted (preflight, backup, plan, pull, schema gate)
#   20  FAILED_ROLLED_BACK          the release failed; the rollback is verified
#   30  FAILED_ROLLBACK_FAILED      the release failed and the rollback did not verify: operator needed
#   0   ROLLED_BACK                 (rollback) verified at the recorded release
#   40  ROLLBACK_REFUSED            (rollback) nothing changed
#   41  ROLLBACK_FAILED             (rollback) operator needed
#   0   STATUS                      (status) read-only report
#   64  usage
#
# The whole body is ONE function, parsed before anything runs. errexit is OFF on
# purpose: every step's result is checked explicitly and mapped to an outcome,
# so no failure can end the script without its PROOVRA_RELEASE result line.

set -Euo pipefail

main() {
  local VERB="${1:-}" ARG="${2:-}"
  local APP_DIR="${PROOVRA_APP_DIR:-/opt/proovra/app}"
  local COMPOSE_FILE="infra/docker/docker-compose.prod.yml"
  local ENV_FILE="${APP_DIR}/.env"
  local STATE_DIR="${APP_DIR}/.deploy-state"
  local API_LOCAL="${PROOVRA_API_LOCAL:-http://127.0.0.1:8080}"
  local WEB_HEALTH="${PROOVRA_WEB_HEALTH_URL:-https://www.proovra.com/api/health}"
  local API_SVC="proovra-api" WORKER_SVC="proovra-worker"
  local SHA40='^[0-9a-f]{40}$'

  cd "${APP_DIR}" || { mark result=REFUSED_BEFORE_CHANGE; mark reason=app_dir_missing; return 10; }

  # GHCR owner = the owner of the repository this checkout tracks, lowercased.
  local ORIGIN_URL OWNER
  ORIGIN_URL="$(git remote get-url origin)"
  OWNER="$(printf '%s' "${ORIGIN_URL}" | sed -nE 's#^(git@github\.com:|https://github\.com/|ssh://git@github\.com/)([^/]+)/[^/]+$#\2#p' | tr '[:upper:]' '[:lower:]')"
  [[ "${OWNER}" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]] || {
    echo "ERROR: cannot derive the GHCR owner from the origin remote." >&2
    mark result=REFUSED_BEFORE_CHANGE; mark reason=owner_unreadable; return 10; }

  compose() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"; }

  # Container IDs of services. The prod compose file refuses to PARSE without
  # GHCR_OWNER and IMAGE_TAG (`${…:?}`), and those are exported only once a
  # release is chosen; `ps` selects containers by project and service labels,
  # never by image, so before that a placeholder tag satisfies the parse. Only
  # `ps` ever sees the placeholder (never pull/up/run). A failure is REPORTED,
  # never read as "no containers" (2026-11-24: a hidden parse error read the
  # live release as "none" and refused the first automatic release).
  ps_ids() {
    local out err rc=0
    err="$(mktemp)"
    out="$(
      export GHCR_OWNER="${GHCR_OWNER:-${OWNER}}" IMAGE_TAG="${IMAGE_TAG:-sha-0000000}"
      compose ps -q "$@" 2>"${err}"
    )" || rc=$?
    if [ "${rc}" -ne 0 ]; then
      sed 's/^/  compose ps: /' "${err}" >&2
      rm -f "${err}"
      return 1
    fi
    rm -f "${err}"
    # Container IDs only: a warning on stdout is never read as a container.
    printf '%s\n' "${out}" | grep -E '^[[:alnum:]][[:alnum:]_.-]*$' || true
  }

  # --- facts about what runs now ------------------------------------------------
  # "<revision> <image ref>" of every container of a service, one per line.
  running_of() {
    local svc="$1" cid img rev cids
    cids="$(ps_ids "${svc}")" || return 1
    for cid in ${cids}; do
      img="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
      rev="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${cid}" 2>/dev/null || true)"
      echo "${rev:-unknown} ${img}"
    done
  }
  # The single revision a service runs, or "mixed"/"none"/"unreadable".
  revision_of() {
    local out lines
    out="$(running_of "$1")" || { echo unreadable; return 0; }
    lines="$(printf '%s\n' "${out}" | awk 'NF {print $1}' | sort -u)"
    if [ -z "${lines}" ]; then echo none
    elif [ "$(printf '%s\n' "${lines}" | wc -l | tr -d ' ')" != 1 ]; then echo mixed
    else echo "${lines}"; fi
  }

  read_epoch_from() {
    # route epoch / contract version stated by a commit's own release contract
    git show "$1:packages/shared/src/release-contract.ts" 2>/dev/null |
      sed -nE "s/^export const $2 = ([0-9]+);.*/\\1/p" | head -n 1
  }

  # Proves what runs is SHA: every container's image tag and revision label,
  # Docker health, worker readiness inside each container, API readiness and
  # /health revision + contract + route epoch.
  verify_running() {
    local sha="$1" tag="sha-${1:0:7}" svc cid img rev health ok=0 epoch contract
    for svc in "${WORKER_SVC}" "${API_SVC}"; do
      local cids
      if ! cids="$(ps_ids "${svc}")"; then echo "  VERIFY FAIL: ${svc} containers unreadable"; ok=1; continue; fi
      if [ -z "${cids}" ]; then echo "  VERIFY FAIL: ${svc} has no container"; ok=1; continue; fi
      for cid in ${cids}; do
        img="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
        rev="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${cid}" 2>/dev/null || true)"
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}")"
        if [ "${img}" != "ghcr.io/${OWNER}/${svc}:${tag}" ] || [ "${rev}" != "${sha}" ] || [ "${health}" != healthy ]; then
          echo "  VERIFY FAIL: ${svc} ${cid:0:12} image=${img} revision=${rev:-none} health=${health}"; ok=1
        else
          echo "  verified ${svc} ${cid:0:12} image=${img} revision=${rev} health=${health}"
        fi
        if [ "${svc}" = "${WORKER_SVC}" ]; then
          if docker exec "${cid}" sh -c 'wget -qO- "http://localhost:${WORKER_PORT:-8090}/readyz" >/dev/null' </dev/null; then
            echo "  verified ${svc} ${cid:0:12} /readyz OK"
          else
            echo "  VERIFY FAIL: ${svc} ${cid:0:12} /readyz not ready"; ok=1
          fi
        fi
      done
    done
    if curl -fsS --max-time 10 -o /dev/null "${API_LOCAL}/readyz"; then
      echo "  verified ${API_SVC} ${API_LOCAL}/readyz OK"
    else
      echo "  VERIFY FAIL: ${API_LOCAL}/readyz not ready"; ok=1
    fi
    epoch="$(read_epoch_from "${sha}" PRESENTATION_CONTRACT_ROUTE_EPOCH)"
    contract="$(read_epoch_from "${sha}" PRESENTATION_CONTRACT_VERSION)"
    local headers body live_rev live_epoch live_contract
    headers="$(mktemp)"
    body="$(curl -fsS --max-time 10 -D "${headers}" "${API_LOCAL}/health" || true)"
    live_rev="$(printf '%s' "${body}" | sed -nE 's/.*"revision":"([0-9a-f]{40})".*/\1/p')"
    live_epoch="$(tr -d '\r' <"${headers}" | sed -nE 's/^[Xx]-[Pp]roovra-[Rr]oute-[Ee]poch: *([0-9]+).*/\1/p' | head -n 1)"
    live_contract="$(tr -d '\r' <"${headers}" | sed -nE 's/^[Xx]-[Pp]roovra-[Cc]ontract: *([0-9]+).*/\1/p' | head -n 1)"
    rm -f "${headers}"
    if [ "${live_rev}" = "${sha}" ] && [ -n "${epoch}" ] && [ "${live_epoch}" = "${epoch}" ] && [ -n "${contract}" ] && [ "${live_contract}" = "${contract}" ]; then
      echo "  verified /health revision=${live_rev} route-epoch=${live_epoch} contract=${live_contract}"
    else
      echo "  VERIFY FAIL: /health revision=${live_rev:-unreadable} route-epoch=${live_epoch:-unreadable} (want ${epoch:-unreadable}) contract=${live_contract:-unreadable} (want ${contract:-unreadable})"; ok=1
    fi
    mark "verified_epoch=${live_epoch:-unreadable}"
    return "${ok}"
  }

  # --- disk headroom and image retention ---------------------------------------
  # 2026-11-25: a release ran on a root filesystem with almost no space left.
  # The backup and the image pull took the last of it, the release's own
  # verification could no longer write its header file, and the automatic
  # rollback died in `git checkout` ("Out of diskspace"), leaving the release
  # tracked files empty. Every release adds an API and a worker image (about
  # 7 GB), and nothing ever removed the old ones.
  #
  # So, before the backup and any image pull, the release proves headroom on
  # every filesystem it writes to. Needed:
  #   * the backup filesystem: two copies of a dump (pg-backup.sh's own rule),
  #     sized from the previous release's proven backup;
  #   * the Docker filesystem: each candidate or rollback image NOT already on
  #     the host, at 1.5 x its unpacked size (compressed download + extraction);
  #   * every one of those, plus the checkout's: PROOVRA_RELEASE_MARGIN_MB for
  #     the checkout, logs, the verification's temp files and a rollback;
  #   * free inodes: at least PROOVRA_RELEASE_MIN_FREE_INODES.
  # If that is short, obsolete PROOVRA images are removed (below), and if it is
  # still short the release is refused before anything changed.
  local MARGIN_MB="${PROOVRA_RELEASE_MARGIN_MB:-2048}"
  local MIN_FREE_INODES="${PROOVRA_RELEASE_MIN_FREE_INODES:-200000}"
  local BACKUP_HOST_DIR="${PROOVRA_BACKUP_DIR:-/opt/proovra/backups/postgres}"
  local DEFAULT_BACKUP_MB="${PROOVRA_RELEASE_BACKUP_ESTIMATE_MB:-2048}"
  local DEFAULT_IMAGE_MB="${PROOVRA_RELEASE_IMAGE_ESTIMATE_MB:-6144}"

  # "<mount> <free KiB> <free inodes or ->" of the filesystem holding a path
  # (its nearest existing ancestor). "-": the filesystem has no inode limit.
  fs_facts() {
    local p="$1" k i
    while [ ! -e "${p}" ] && [ "${p}" != / ] && [ "${p}" != . ]; do p="$(dirname "${p}")"; done
    k="$(df -Pk "${p}" 2>/dev/null | awk 'NR==2 {print $6, $4}')"
    i="$(df -Pi "${p}" 2>/dev/null | awk 'NR==2 {print ($2 == 0 ? "-" : $4)}')"
    [[ "${k}" =~ ^[^[:space:]]+\ [0-9]+$ ]] && [[ "${i}" =~ ^([0-9]+|-)$ ]] || return 1
    echo "${k} ${i}"
  }

  # Bytes of an image on the host, or nothing when it is not here.
  image_bytes() { docker image inspect --format '{{.Size}}' "$1" 2>/dev/null | grep -E '^[0-9]+$' | head -n 1; }

  # The rollback tag recorded on the host now (the pair to restore if THIS
  # release fails before it records its own), or nothing.
  recorded_rollback_tag() {
    [ -f "${STATE_DIR}/previous-release" ] && sed -n 's/^IMAGE_TAG=//p' "${STATE_DIR}/previous-release" | grep -E '^sha-[0-9a-f]{7}$' | head -n 1
    return 0
  }

  # Targeted retention: removes `sha-<7>` tags of OUR API and worker images
  # only, one exact tag at a time, without force. Kept: every image any
  # container uses (running or stopped), the refs passed in (the candidate
  # release and the rollback pair) and the rollback pair recorded on the host.
  # Never touched: other repositories, `latest` or any other tag, untagged
  # images, volumes, backups, build cache. A tag whose image another tag still
  # holds is only untagged (Docker frees the space once no tag holds it).
  # Usage: prune_obsolete_images <mark-key> <keep-ref>...
  prune_obsolete_images() {
    local key="$1"; shift
    local keep=" " cids cid id ref svc repo listing tag removed=0 kept=0 failed=0 rb
    if ! cids="$(docker ps -aq)"; then
      echo "  retention: the containers could not be listed; nothing removed"
      mark "${key}=skipped (containers unreadable)"; return 1
    fi
    for cid in ${cids}; do
      id="$(docker inspect --format '{{.Image}}' "${cid}" 2>/dev/null)"
      [[ "${id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
        echo "  retention: the image of container ${cid:0:12} is unreadable; nothing removed"
        mark "${key}=skipped (container image unreadable)"; return 1; }
      keep+="${id} "
    done
    rb="$(recorded_rollback_tag)"
    [ -n "${rb}" ] && set -- "$@" "ghcr.io/${OWNER}/${API_SVC}:${rb}" "ghcr.io/${OWNER}/${WORKER_SVC}:${rb}"
    for ref in "$@"; do
      id="$(docker image inspect --format '{{.Id}}' "${ref}" 2>/dev/null)"
      [[ "${id}" =~ ^sha256:[0-9a-f]{64}$ ]] && keep+="${id} "
    done
    for svc in "${API_SVC}" "${WORKER_SVC}"; do
      repo="ghcr.io/${OWNER}/${svc}"
      if ! listing="$(docker image ls --no-trunc --format '{{.Tag}} {{.ID}}' "${repo}")"; then
        echo "  retention: the ${svc} images could not be listed"; failed=$((failed + 1)); continue
      fi
      while read -r tag id; do
        [[ "${tag}" =~ ^sha-[0-9a-f]{7}$ ]] && [[ "${id}" =~ ^sha256:[0-9a-f]{64}$ ]] || continue
        case "${keep}" in *" ${id} "*) kept=$((kept + 1)); continue ;; esac
        if docker image rm "${repo}:${tag}" </dev/null >/dev/null; then
          echo "  retention: removed ${repo}:${tag}"; removed=$((removed + 1))
        else
          echo "  retention: could not remove ${repo}:${tag} (left in place)"; failed=$((failed + 1))
        fi
      done <<<"${listing}"
    done
    mark "${key}=removed ${removed}, kept ${kept}, failed ${failed}"
    [ "${failed}" -eq 0 ]
  }

  # Proves headroom for a release of <tag> with rollback pair <rollback tag>.
  # Prints one line per filesystem and marks the free space. 0: enough;
  # 1: short (HEADROOM_SHORT says where); 2: the facts are unreadable.
  headroom_ok() {
    local tag="$1" rb_tag="$2" docker_root backup_kb=0 image_kb=0 b svc ref t sib
    local -A need=() free=() inodes=()
    HEADROOM_SHORT=""
    docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
    [ -n "${docker_root}" ] || docker_root=/var/lib/docker
    b="$(ls -1t "${STATE_DIR}"/backup-proof-*.txt 2>/dev/null | head -n 1)"
    b="${b:+$(tail -n 1 "${b}" 2>/dev/null)}"
    [[ "${b}" =~ ^[0-9]+$ ]] || b=$((DEFAULT_BACKUP_MB * 1048576))
    backup_kb=$((2 * b / 1024))
    for svc in "${API_SVC}" "${WORKER_SVC}"; do
      for t in "${tag}" "${rb_tag}"; do
        ref="ghcr.io/${OWNER}/${svc}:${t}"
        [ -n "$(image_bytes "${ref}")" ] && continue
        sib="$(image_bytes "ghcr.io/${OWNER}/${svc}:${rb_tag}")"
        [ -n "${sib}" ] || sib=$((DEFAULT_IMAGE_MB * 1048576))
        image_kb=$((image_kb + sib * 3 / 2 / 1024))
      done
    done
    local p facts m k i
    for p in "${APP_DIR}:0" "${BACKUP_HOST_DIR}:${backup_kb}" "${docker_root}:${image_kb}"; do
      facts="$(fs_facts "${p%:*}")" || { HEADROOM_SHORT="free space of ${p%:*} unreadable"; return 2; }
      read -r m k i <<<"${facts}"
      need[$m]=$(( ${need[$m]:-0} + ${p##*:} ))
      free[$m]="${k}"; inodes[$m]="${i}"
    done
    local rc=0 want
    for m in "${!need[@]}"; do
      want=$(( need[$m] + MARGIN_MB * 1024 ))
      echo "  disk ${m}: $(( free[$m] / 1024 )) MB free, $(( want / 1024 )) MB needed; inodes free ${inodes[$m]} (minimum ${MIN_FREE_INODES})"
      mark "disk_free_mb=${m} $(( free[$m] / 1024 ))"
      if [ "${free[$m]}" -lt "${want}" ]; then
        HEADROOM_SHORT+="${m} has $(( free[$m] / 1024 )) MB free and needs $(( want / 1024 )) MB; "; rc=1
      fi
      if [ "${inodes[$m]}" != - ] && [ "${inodes[$m]}" -lt "${MIN_FREE_INODES}" ]; then
        HEADROOM_SHORT+="${m} has ${inodes[$m]} free inodes and needs ${MIN_FREE_INODES}; "; rc=1
      fi
    done
    HEADROOM_SHORT="${HEADROOM_SHORT%; }"
    return "${rc}"
  }

  status_report() {
    local svc
    for svc in "${API_SVC}" "${WORKER_SVC}"; do
      running_of "${svc}" | while read -r rev img; do
        mark "running_${svc#proovra-}=${rev} ${img}"
        # Image-reference drift: the container runs the right revision but was
        # created from a moving tag (2026-11-26: `IMAGE_TAG=latest` + compose
        # pull/up by hand). Reported, never "fixed" by recreating a healthy
        # container: the next release normalises it.
        if [[ "${rev}" =~ ^[0-9a-f]{40}$ ]] && [ "${img##*:}" != "sha-${rev:0:7}" ]; then
          mark "image_drift_${svc#proovra-}=${img##*:} (runs ${rev:0:7}; want sha-${rev:0:7})"
        fi
      done
      mark "revision_${svc#proovra-}=$(revision_of "${svc}")"
    done
    if [ -f "${STATE_DIR}/previous-release" ]; then
      mark "previous_release=$(sed -n 's/^RELEASE_SHA=//p' "${STATE_DIR}/previous-release")"
    else
      mark "previous_release=none"
    fi
    mark "checkout=$(git rev-parse HEAD)"
  }

  case "${VERB}" in
    status)
      status_report
      mark result=STATUS
      return 0
      ;;
    release)
      [[ "${ARG}" =~ ${SHA40} ]] || { echo "usage: host-release.sh release <40-hex sha>" >&2; return 64; }
      do_release "${ARG}"
      return $?
      ;;
    rollback)
      [[ "${ARG}" =~ ${SHA40} ]] || { echo "usage: host-release.sh rollback <40-hex sha running now>" >&2; return 64; }
      do_rollback "${ARG}"
      return $?
      ;;
    *)
      echo "usage: host-release.sh status | release <sha> | rollback <sha running now>" >&2
      return 64
      ;;
  esac
}

mark() { echo "PROOVRA_RELEASE $*"; }

# ---------------------------------------------------------------------------
do_release() {
  local SHA="$1" TAG="sha-${1:0:7}"
  local PREV_HEAD R0 W0 R0_TAG
  echo "== PROOVRA backend release ${SHA} (${TAG}) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mark "release=${SHA}"

  refuse() {
    echo "REFUSED: $*" >&2
    mark "reason=$*"
    if [ -n "${PREV_HEAD:-}" ] && [ "$(git rev-parse HEAD)" != "${PREV_HEAD}" ] && git diff --quiet HEAD --; then
      git checkout --quiet --detach "${PREV_HEAD}" && echo "  checkout restored to ${PREV_HEAD}"
    fi
    mark result=REFUSED_BEFORE_CHANGE
    return 10
  }

  # --- 1. preflight + rollback point ------------------------------------------
  git diff --quiet HEAD -- || { refuse "the host checkout has modified tracked files"; return 10; }
  [ -r "${ENV_FILE}" ] || { refuse "the env file ${ENV_FILE} is not readable"; return 10; }
  git cat-file -e "${SHA}^{commit}" 2>/dev/null || { refuse "commit ${SHA} is not in the host checkout"; return 10; }
  git merge-base --is-ancestor "${SHA}" origin/main || { refuse "commit ${SHA} is not on origin/main"; return 10; }

  R0="$(revision_of "${API_SVC}")"
  W0="$(revision_of "${WORKER_SVC}")"
  mark "running_api=${R0}"
  mark "running_worker=${W0}"
  if [ "${R0}" = "${SHA}" ] && [ "${W0}" = "${SHA}" ]; then
    echo "Already running ${SHA}; verifying only."
    if verify_running "${SHA}"; then mark result=DEPLOYED; mark already_running=true; return 0; fi
    refuse "already running ${SHA} but it does not verify"; return 10
  fi
  [[ "${R0}" =~ ^[0-9a-f]{40}$ ]] && [ "${R0}" = "${W0}" ] ||
    { refuse "the running API (${R0}) and worker (${W0}) are not one immutable release; no usable rollback point"; return 10; }
  git merge-base --is-ancestor "${R0}" "${SHA}" ||
    { refuse "the running release ${R0} is not an ancestor of ${SHA}; never deploy over a newer or diverged release"; return 10; }
  R0_TAG="sha-${R0:0:7}"

  # --- 1b. disk headroom, before the backup and before any image pull ---------
  echo "== Disk headroom"
  local hr=0 keep_refs=(
    "ghcr.io/${OWNER}/${API_SVC}:${TAG}" "ghcr.io/${OWNER}/${WORKER_SVC}:${TAG}"
    "ghcr.io/${OWNER}/${API_SVC}:${R0_TAG}" "ghcr.io/${OWNER}/${WORKER_SVC}:${R0_TAG}"
  )
  headroom_ok "${TAG}" "${R0_TAG}" || hr=$?
  [ "${hr}" -ne 2 ] || { refuse "cannot read the free disk space: ${HEADROOM_SHORT}"; return 10; }
  if [ "${hr}" -eq 1 ]; then
    echo "  short: ${HEADROOM_SHORT}"
    echo "  removing obsolete PROOVRA images (never a running, candidate or rollback image)"
    ( prune_obsolete_images retention_before "${keep_refs[@]}" ) || true
    hr=0
    headroom_ok "${TAG}" "${R0_TAG}" || hr=$?
    [ "${hr}" -eq 0 ] ||
      { refuse "insufficient disk space, and removing obsolete PROOVRA images did not free enough: ${HEADROOM_SHORT}"; return 10; }
  fi

  local svc ref rev
  for svc in proovra-api proovra-worker; do
    ref="ghcr.io/${OWNER}/${svc}:${R0_TAG}"
    docker pull -q "${ref}" </dev/null >/dev/null || { refuse "rollback image ${ref} cannot be pulled"; return 10; }
    rev="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${ref}")"
    [ "${rev}" = "${R0}" ] || { refuse "rollback image ${ref} carries revision '${rev}', not ${R0}"; return 10; }
    echo "  rollback image proven: ${ref} revision=${rev}"
  done
  mkdir -p "${STATE_DIR}" &&
    printf 'RELEASE_SHA=%s\nIMAGE_TAG=%s\n' "${R0}" "${R0_TAG}" >"${STATE_DIR}/previous-release" &&
    printf 'RELEASE_SHA=%s\nIMAGE_TAG=%s\nRECORDED_AT=%s\nFOR_RELEASE=%s\n' "${R0}" "${R0_TAG}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SHA}" \
      >"${STATE_DIR}/rollback-point-${SHA:0:12}.env" &&
    [ "$(sed -n 's/^RELEASE_SHA=//p' "${STATE_DIR}/previous-release")" = "${R0}" ] ||
    { refuse "the rollback point could not be recorded in ${STATE_DIR}"; return 10; }
  mark "rollback_point=${R0}"
  # Which containers run now: "nothing changed" is decided by container identity.
  local CIDS0
  CIDS0="$(ps_ids "${API_SVC}" "${WORKER_SVC}")" && [ -n "${CIDS0}" ] ||
    { refuse "the running containers could not be listed"; return 10; }
  CIDS0="$(printf '%s\n' "${CIDS0}" | sort | tr '\n' ' ')"

  # Compose interpolation needs these exported even for the backup service.
  export GHCR_OWNER="${OWNER}" RELEASE_SHA="${SHA}" IMAGE_TAG="${TAG}"
  PREV_HEAD="$(git rev-parse HEAD)"
  git checkout --quiet --detach "${SHA}" || { refuse "could not check out ${SHA}"; return 10; }

  # --- 2. backup, then prove it ----------------------------------------------
  echo "== Database backup (pg-backup.sh, pinned pg17 image)"
  local started backup_out
  started="$(date -u +%Y%m%dT%H%M%SZ)"
  if ! backup_out="$(compose --profile backup run --rm --no-deps -T --entrypoint bash pg-backup /ops/pg-backup.sh </dev/null 2>&1)"; then
    printf '%s\n' "${backup_out}" | tail -n 20
    refuse "the database backup failed"; return 10
  fi
  printf '%s\n' "${backup_out}" | tail -n 5
  local dump
  dump="$(printf '%s\n' "${backup_out}" | sed -nE 's#^pg-backup: OK /backups/(proovra-[0-9TZ]+\.dump) .*#\1#p' | tail -n 1)"
  [ -n "${dump}" ] || { refuse "the backup did not report a dump"; return 10; }
  # Stamps are UTC YYYYMMDDTHHMMSSZ, so they compare as strings.
  [[ ! "${dump#proovra-}" < "${started}" ]] ||
    { refuse "the reported dump ${dump} is older than this release"; return 10; }
  # Proven inside the backup image (the files are root-owned, mode 600).
  if ! compose --profile backup run --rm --no-deps -T --entrypoint bash pg-backup -c \
      "set -e; cd /backups; sha256sum -c '${dump}.sha256' >/dev/null; pg_restore --list '${dump}' >/dev/null; test -s '${dump%.dump}.counts'; test -s '${dump%.dump}.schema'; stat -c '%s' '${dump}'" \
      </dev/null >"${STATE_DIR}/backup-proof-${SHA:0:12}.txt" 2>&1; then
    tail -n 5 "${STATE_DIR}/backup-proof-${SHA:0:12}.txt"
    refuse "the backup ${dump} did not verify (checksum, archive table of contents, counts, schema)"; return 10
  fi
  mark "backup=${dump}"
  mark "backup_bytes=$(tail -n 1 "${STATE_DIR}/backup-proof-${SHA:0:12}.txt")"
  echo "  backup verified: ${dump} (checksum OK, pg_restore --list OK, counts + schema present)"

  # --- 3. the established deploy ------------------------------------------------
  export WEB_HEALTH_URL="${WEB_HEALTH}"
  echo "== deploy-prod-pull.sh --plan"
  bash scripts/deploy-prod-pull.sh --plan || { refuse "deploy-prod-pull.sh --plan refused"; return 10; }
  echo "== deploy-prod-pull.sh (worker, then API)"
  local deploy_rc=0
  bash scripts/deploy-prod-pull.sh || deploy_rc=$?

  # --- 4. verify ---------------------------------------------------------------
  if [ "${deploy_rc}" -eq 0 ]; then
    echo "== Verifying the running release"
    if verify_running "${SHA}"; then
      # Retention after a VERIFIED release only reports: in a subshell, its
      # result ignored, never a rollback. Kept: what runs now (the candidate)
      # and the rollback pair just recorded.
      echo "== Image retention"
      ( prune_obsolete_images retention "${keep_refs[@]}" ) ||
        echo "  retention did not complete; the release stands (obsolete images can be removed later)"
      local after
      after="$( (fs_facts "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)") 2>/dev/null )" &&
        mark "disk_free_after_mb=${after%% *} $(( $(echo "${after}" | awk '{print $2}') / 1024 ))" || true
      mark result=DEPLOYED
      return 0
    fi
    echo "The deploy script succeeded but the running release does not verify."
  else
    echo "deploy-prod-pull.sh exited ${deploy_rc}."
  fi

  # --- 5. nothing changed? then nothing to roll back --------------------------
  local CIDS1
  CIDS1="$(ps_ids "${API_SVC}" "${WORKER_SVC}" | sort | tr '\n' ' ')"
  if [ -n "${CIDS0}" ] && [ "${CIDS1}" = "${CIDS0}" ] &&
     [ "$(revision_of "${API_SVC}")" = "${R0}" ] && [ "$(revision_of "${WORKER_SVC}")" = "${R0}" ]; then
    refuse "the deploy stopped before any service changed (deploy-prod-pull exit ${deploy_rc})"; return 10
  fi

  echo "== Rolling back to ${R0} (API first)"
  mark "rollback_started=${R0}"
  local rb_rc=0
  bash scripts/deploy-prod-pull.sh --rollback || rb_rc=$?
  if [ "${rb_rc}" -eq 0 ] && verify_running "${R0}"; then
    mark "rolled_back_to=${R0}"
    mark result=FAILED_ROLLED_BACK
    return 20
  fi
  mark result=FAILED_ROLLBACK_FAILED
  return 30
}

# ---------------------------------------------------------------------------
do_rollback() {
  local EXPECT="$1" R TARGET
  echo "== PROOVRA backend rollback on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -f "${STATE_DIR}/previous-release" ] || { mark "reason=no recorded rollback point"; mark result=ROLLBACK_REFUSED; return 40; }
  TARGET="$(sed -n 's/^RELEASE_SHA=//p' "${STATE_DIR}/previous-release")"
  R="$(revision_of "${API_SVC}")"
  mark "running_api=${R}"
  mark "rollback_target=${TARGET}"
  if [ "${R}" != "${EXPECT}" ] || [ "$(revision_of "${WORKER_SVC}")" != "${EXPECT}" ]; then
    mark "reason=the running release is not ${EXPECT}"; mark result=ROLLBACK_REFUSED; return 40
  fi
  [ "${TARGET}" != "${EXPECT}" ] || { mark "reason=the recorded rollback point is the running release"; mark result=ROLLBACK_REFUSED; return 40; }
  git diff --quiet HEAD -- || { mark "reason=the host checkout has modified tracked files"; mark result=ROLLBACK_REFUSED; return 40; }
  export GHCR_OWNER="${OWNER}" WEB_HEALTH_URL="${WEB_HEALTH}"
  local rc=0
  bash scripts/deploy-prod-pull.sh --rollback || rc=$?
  if [ "${rc}" -eq 0 ] && verify_running "${TARGET}"; then
    mark "rolled_back_to=${TARGET}"
    mark result=ROLLED_BACK
    return 0
  fi
  mark result=ROLLBACK_FAILED
  return 41
}

main "$@"
