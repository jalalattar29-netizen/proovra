#!/usr/bin/env bash
# Usage:
#   GHCR_OWNER=your-org ./scripts/deploy-prod-pull.sh                            # latest from main
#   GHCR_OWNER=your-org IMAGE_TAG=sha-abc1234 ./scripts/deploy-prod-pull.sh      # pinned rollback
#
# Server-side production deploy.
# This script does NOT build Docker images, does NOT copy node_modules,
# does NOT run tsc, and does NOT run prisma generate.
# It only pulls prebuilt images from GHCR and restarts containers.

set -euo pipefail

# --- 2. Resolve repo root (script lives at <repo>/scripts/deploy-prod-pull.sh) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

print_rollback_instructions() {
    local out="${1:-/dev/stdout}"
    cat >"${out}" <<EOF

ROLLBACK INSTRUCTIONS:

  To roll back to a previous build:
    1. Find the sha tag you want (e.g. from GitHub Container Registry UI or the prior deploy log).
    2. Re-run this script with that tag pinned:
         IMAGE_TAG=sha-<short-sha> GHCR_OWNER=${GHCR_OWNER:-your-org} ./scripts/deploy-prod-pull.sh
    3. Verify health (the script does this automatically).
  Notes:
    - sha tags are immutable: a tag always points to the same image bytes, so rollback is byte-for-byte.
    - \`latest\` is mutable; do not rely on it for rollback.
    - Database migrations are NOT rolled back by this script. If the new build ran migrations that the
      previous build cannot tolerate, you must restore the DB separately. R7 migrations in this repo
      are additive only (no DROP, no destructive RENAME), so forward-only rollback is safe.

EOF
}

on_failure() {
    local exit_code=$?
    echo "" >&2
    echo "DEPLOY FAILED (exit ${exit_code})" >&2
    print_rollback_instructions /dev/stderr
    exit 1
}
trap on_failure ERR

# --- 3. Verify env vars and print resolved values ---
if [ -z "${GHCR_OWNER:-}" ]; then
    echo "ERROR: GHCR_OWNER is required (e.g. GHCR_OWNER=your-org)." >&2
    exit 1
fi
export GHCR_OWNER
export IMAGE_TAG="${IMAGE_TAG:-latest}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.prod.yml}"
API_HEALTH_URL="${API_HEALTH_URL:-http://localhost:8080/healthz}"

echo "Resolved deploy configuration:"
echo "  REPO_ROOT      = ${REPO_ROOT}"
echo "  GHCR_OWNER     = ${GHCR_OWNER}"
echo "  IMAGE_TAG      = ${IMAGE_TAG}"
echo "  COMPOSE_FILE   = ${COMPOSE_FILE}"
echo "  API_HEALTH_URL = ${API_HEALTH_URL}"

if [ ! -f "${COMPOSE_FILE}" ]; then
    echo "ERROR: compose file not found at ${COMPOSE_FILE}" >&2
    exit 1
fi

# --- 4. Sync compose file + ops scripts from git ---
# IMPORTANT: only the compose file and ops scripts are pulled from git here.
# Application code lives INSIDE the image we pull from GHCR. We reset the
# server-side checkout so the compose file on disk matches the build that
# produced the image being deployed.
echo ""
echo "Syncing compose file and ops scripts from origin/main..."
git fetch --tags origin
git reset --hard origin/main

# --- 5. Pull prebuilt images ---
echo ""
echo "Pulling images for api and worker (tag=${IMAGE_TAG})..."
docker compose -f "${COMPOSE_FILE}" pull api worker

# --- 6. Bring up api + worker ---
echo ""
echo "Starting api and worker..."
docker compose -f "${COMPOSE_FILE}" up -d api worker

# --- 7. Health checks ---
echo ""
echo "Polling API health at ${API_HEALTH_URL} (up to 60s)..."
HEALTH_OK=0
for i in $(seq 1 60); do
    if curl -fsS "${API_HEALTH_URL}" >/dev/null 2>&1; then
        HEALTH_OK=1
        echo "API healthy after ${i}s."
        break
    fi
    sleep 1
done
if [ "${HEALTH_OK}" -ne 1 ]; then
    echo "ERROR: API did not become healthy within 60s." >&2
    docker compose -f "${COMPOSE_FILE}" ps >&2 || true
    exit 1
fi

echo ""
echo "Container status:"
PS_OUT="$(docker compose -f "${COMPOSE_FILE}" ps)"
echo "${PS_OUT}"

# Verify api and worker each show healthy or running.
for svc in api worker; do
    if ! echo "${PS_OUT}" | grep -E "^${svc}([[:space:]]|-)" | grep -Eq "healthy|running|Up"; then
        echo "ERROR: service '${svc}' is not healthy/running in docker compose ps." >&2
        exit 1
    fi
done

# --- 8. Print the image digest that is now running ---
echo ""
echo "Live image digests:"
for svc in api worker; do
    CID="$(docker compose -f "${COMPOSE_FILE}" ps -q "${svc}" || true)"
    if [ -n "${CID}" ]; then
        DIGEST="$(docker inspect --format '{{.Image}}' "${CID}")"
        echo "  ${svc}: ${DIGEST}"
    else
        echo "  ${svc}: <no container id>"
    fi
done

# --- 9. Success: print rollback instructions for the deploy log ---
echo ""
echo "DEPLOY SUCCEEDED (GHCR_OWNER=${GHCR_OWNER}, IMAGE_TAG=${IMAGE_TAG})."
print_rollback_instructions /dev/stdout

trap - ERR
exit 0
