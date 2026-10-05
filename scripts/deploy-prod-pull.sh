#!/usr/bin/env bash
# PRODUCTION API + WORKER DEPLOY — server-side, owner-run, on the Production host.
#
#   GHCR_OWNER=<owner> RELEASE_SHA=<40-hex commit> IMAGE_TAG=sha-<first 7 of it> \
#     ./scripts/deploy-prod-pull.sh [--plan]
#   GHCR_OWNER=<owner> ./scripts/deploy-prod-pull.sh --rollback [--plan]
#
#   --plan      validate and print what WOULD be deployed; change nothing.
#   --rollback  redeploy the release that was running before the last deploy
#               (recorded in $STATE_DIR/previous-release by that deploy).
#
# It pulls PREBUILT images (.github/workflows/deploy-images.yml) and recreates
# the containers. It does NOT build, does NOT run migrations and does NOT print
# any environment value. Migrations go FIRST, through the migration runbook
# (docs/operations/internal-grant-production-rollout.md); this script refuses to
# start an image whose schema requirements the database does not meet.
#
# IMMUTABILITY: the only tag CI publishes per commit is `sha-<7 hex>` (`main` and
# `latest` float). A tag can in principle be re-pushed, so the tag is never the
# proof: RELEASE_SHA is the full commit, the tag must be derived from it, and
# each pulled image's OCI `org.opencontainers.image.revision` label must equal it.
#
# ORDER: record the running release (rollback point) → check out the compose
# file at RELEASE_SHA → pull both images → verify revisions → runtime schema gate
# (from the NEW image, read-only) → recreate proovra-api, wait healthy + /readyz →
# recreate proovra-worker, wait healthy + /health → verify what is running.
#
# The whole body is ONE function, parsed before anything runs: `git checkout`
# below replaces this very file, and bash otherwise reads a script as it goes.

set -euo pipefail

main() {
  local MODE="deploy" PLAN_ONLY=0 arg
  for arg in "$@"; do
    case "${arg}" in
      --rollback) MODE="rollback" ;;
      --plan) PLAN_ONLY=1 ;;
      *) fail "unknown argument '${arg}' (expected --rollback and/or --plan)" ;;
    esac
  done

  local SCRIPT_DIR REPO_ROOT
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  cd "${REPO_ROOT}"

  local COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.prod.yml}"
  local STATE_DIR="${STATE_DIR:-${REPO_ROOT}/.deploy-state}"
  local API_READY_URL="${API_READY_URL:-http://127.0.0.1:8080/readyz}"
  local WORKER_HEALTH_URL="${WORKER_HEALTH_URL:-http://127.0.0.1:8090/health}"
  local HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
  local API_SVC="proovra-api" WORKER_SVC="proovra-worker"

  [[ "${GHCR_OWNER:-}" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]] ||
    fail "GHCR_OWNER is required and must be a lowercase GitHub owner (e.g. the repository owner)."

  if [ "${MODE}" = "rollback" ]; then
    [ -f "${STATE_DIR}/previous-release" ] ||
      fail "no recorded previous release at ${STATE_DIR}/previous-release — roll back by naming RELEASE_SHA + IMAGE_TAG explicitly."
    RELEASE_SHA="$(sed -n 's/^RELEASE_SHA=//p' "${STATE_DIR}/previous-release")"
    IMAGE_TAG="$(sed -n 's/^IMAGE_TAG=//p' "${STATE_DIR}/previous-release")"
  fi

  local SHA="${RELEASE_SHA:-}" TAG="${IMAGE_TAG:-}"
  validate_release "${SHA}" "${TAG}"
  export GHCR_OWNER IMAGE_TAG="${TAG}"

  local API_IMAGE="ghcr.io/${GHCR_OWNER}/proovra-api:${TAG}"
  local WORKER_IMAGE="ghcr.io/${GHCR_OWNER}/proovra-worker:${TAG}"

  echo "Selected release (${MODE}):"
  echo "  RELEASE_SHA  = ${SHA}"
  echo "  IMAGE_TAG    = ${TAG}"
  echo "  api image    = ${API_IMAGE}"
  echo "  worker image = ${WORKER_IMAGE}"
  echo "  compose file = ${COMPOSE_FILE} (checked out at ${SHA})"

  # --- the rollback point: what is running NOW ---------------------------------
  local CUR_SHA="" CUR_TAG="" CUR_REF CUR_CID
  CUR_CID="$(docker compose -f "${COMPOSE_FILE}" ps -q "${API_SVC}" 2>/dev/null || true)"
  if [ -n "${CUR_CID}" ]; then
    CUR_REF="$(docker inspect --format '{{.Config.Image}}' "${CUR_CID}")"
    CUR_TAG="${CUR_REF##*:}"
    CUR_SHA="$(image_revision "${CUR_REF}" || true)"
  fi
  if [[ "${CUR_SHA}" =~ ^[0-9a-f]{40}$ ]] && [ "${CUR_TAG}" = "sha-${CUR_SHA:0:7}" ]; then
    echo "Currently running: ${CUR_TAG} (${CUR_SHA}) — this is the rollback point."
  else
    echo "WARNING: the running ${API_SVC} is not an immutable release (tag '${CUR_TAG:-none}', revision '${CUR_SHA:-unknown}')."
    echo "         No rollback point can be recorded; a rollback must name RELEASE_SHA + IMAGE_TAG explicitly."
    CUR_SHA=""
  fi

  if [ "${PLAN_ONLY}" -eq 1 ]; then
    echo "PLAN ONLY — nothing pulled, checked out or restarted."
    return 0
  fi

  # A deploy records what it replaces; a rollback keeps that record (so a
  # second --rollback does not bounce back to the release that just failed).
  if [ "${MODE}" = "deploy" ] && [ -n "${CUR_SHA}" ] && [ "${CUR_SHA}" != "${SHA}" ]; then
    mkdir -p "${STATE_DIR}"
    printf 'RELEASE_SHA=%s\nIMAGE_TAG=%s\n' "${CUR_SHA}" "${CUR_TAG}" >"${STATE_DIR}/previous-release"
  fi
  ROLLBACK_HINT="GHCR_OWNER=${GHCR_OWNER} ./scripts/deploy-prod-pull.sh --rollback"

  # --- compose file at exactly the release commit -----------------------------
  git fetch --quiet --tags origin
  git diff --quiet HEAD -- ||
    fail "the server checkout has modified TRACKED files; refusing to overwrite them (review 'git status', then retry)."
  git cat-file -e "${SHA}^{commit}" 2>/dev/null ||
    fail "commit ${SHA} is not in the server checkout after 'git fetch' — is it pushed to origin?"
  git checkout --quiet --detach "${SHA}"

  # --- pull + prove the bytes are the release ---------------------------------
  docker compose -f "${COMPOSE_FILE}" pull "${API_SVC}" "${WORKER_SVC}"
  local ref rev
  for ref in "${API_IMAGE}" "${WORKER_IMAGE}"; do
    rev="$(image_revision "${ref}")"
    [ "${rev}" = "${SHA}" ] ||
      fail "${ref} carries revision '${rev}', not ${SHA} — the tag does not point at this release."
    echo "  verified ${ref} revision=${rev} digest=$(docker image inspect --format '{{join .RepoDigests ","}}' "${ref}")"
  done

  # --- the database must already have what this image reads -------------------
  echo "Runtime schema gate (read-only, from the new image)..."
  docker compose -f "${COMPOSE_FILE}" run --rm --no-deps -T --entrypoint node "${API_SVC}" scripts/runtime-schema-gate.mjs ||
    fail "the database does not meet ${TAG}'s schema requirements — apply the migrations first. Nothing was restarted."

  # --- API first, then worker -------------------------------------------------
  docker compose -f "${COMPOSE_FILE}" up -d --no-deps "${API_SVC}"
  wait_healthy "${API_SVC}" "${API_READY_URL}"
  docker compose -f "${COMPOSE_FILE}" up -d --no-deps "${WORKER_SVC}"
  wait_healthy "${WORKER_SVC}" "${WORKER_HEALTH_URL}"

  local svc want cid running
  for svc in "${API_SVC}" "${WORKER_SVC}"; do
    want="${API_IMAGE}"
    [ "${svc}" = "${WORKER_SVC}" ] && want="${WORKER_IMAGE}"
    cid="$(docker compose -f "${COMPOSE_FILE}" ps -q "${svc}")"
    running="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
    [ "${running}" = "${want}" ] || fail "${svc} is running '${running}', expected '${want}'."
  done

  mkdir -p "${STATE_DIR}"
  printf '%s %s %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${MODE}" "${CUR_TAG:-unknown}" "${TAG}" >>"${STATE_DIR}/history.log"
  echo ""
  echo "DEPLOY SUCCEEDED: ${API_SVC} + ${WORKER_SVC} at ${TAG} (${SHA})."
  if [ -n "${CUR_SHA}" ] && [ "${CUR_SHA}" != "${SHA}" ]; then
    echo "Rollback (code only; migrations are forward-only): ${ROLLBACK_HINT}"
  fi
}

ROLLBACK_HINT=""

fail() {
  echo "ERROR: $*" >&2
  if [ -n "${ROLLBACK_HINT}" ]; then
    echo "If containers were already recreated, the previous release is one command away: ${ROLLBACK_HINT}" >&2
  fi
  exit 1
}

validate_release() {
  local sha="$1" tag="$2"
  [ -n "${tag}" ] || fail "IMAGE_TAG is required (sha-<first 7 hex of RELEASE_SHA>)."
  case "${tag}" in
    latest | main | master | stable | prod | production)
      fail "IMAGE_TAG '${tag}' is a moving tag; deploy an immutable sha-<7 hex> release." ;;
  esac
  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA must be the full 40-hex commit SHA being deployed."
  [ "${tag}" = "sha-${sha:0:7}" ] ||
    fail "IMAGE_TAG '${tag}' does not name RELEASE_SHA; it must be exactly sha-${sha:0:7} (the tag CI publishes for that commit)."
}

image_revision() {
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$1"
}

wait_healthy() {
  local svc="$1" url="$2" cid status i
  cid="$(docker compose -f "${COMPOSE_FILE}" ps -q "${svc}")"
  [ -n "${cid}" ] || fail "${svc} has no container after 'up'."
  for ((i = 1; i <= HEALTH_TIMEOUT_S; i++)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}")"
    if [ "${status}" = "healthy" ] && curl -fsS --max-time 5 -o /dev/null "${url}"; then
      echo "  ${svc} healthy after ${i}s (${url} OK)."
      return 0
    fi
    [ "${status}" = "unhealthy" ] && break
    sleep 1
  done
  fail "${svc} did not become healthy within ${HEALTH_TIMEOUT_S}s (last health: ${status})."
}

main "$@"
