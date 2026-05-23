#!/usr/bin/env bash
# PHASE 37.99 — Live cross-tenant runtime probe runner.
#
# Two modes:
#
#   1. AUTO (default): the harness launches a testcontainers Postgres.
#      Requires Docker daemon running. Run:
#        ./scripts/run-live-tenant-probe.sh
#
#   2. EXPLICIT TEST_DATABASE_URL: the operator supplies the DB URL.
#      Run:
#        TEST_DATABASE_URL=postgres://localhost:5432/proovra_integration_test \
#          ./scripts/run-live-tenant-probe.sh
#
# The script:
#   - refuses to use DATABASE_URL (production safety),
#   - requires AUTH_JWT_SECRET (test JWT mint uses the same secret as the API),
#   - runs `prisma migrate deploy` only when an explicit TEST_DATABASE_URL
#     is supplied (testcontainers mode runs migrations internally),
#   - runs the probe via `pnpm --filter proovra-api run test:tenant:live`.

set -euo pipefail

if [[ -z "${AUTH_JWT_SECRET:-}" ]]; then
  echo "ERROR: AUTH_JWT_SECRET is required to mint test JWTs." >&2
  echo "  Set it to the same value the API uses in this environment." >&2
  exit 1
fi

export RUN_LIVE_INTEGRATION=1

# Reject production-looking DATABASE_URL leakage.
if [[ -n "${DATABASE_URL:-}" && -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "WARNING: DATABASE_URL is set but TEST_DATABASE_URL is not." >&2
  echo "  The harness will NOT use DATABASE_URL. Running testcontainers mode." >&2
fi

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  # Explicit DB — apply migrations against it.
  echo "Using explicit TEST_DATABASE_URL. Applying migrations..."
  DATABASE_URL="${TEST_DATABASE_URL}" \
    pnpm --filter proovra-api exec prisma migrate deploy
fi

echo "Launching cross-tenant runtime probe..."
pnpm --filter proovra-api run test:tenant:live
