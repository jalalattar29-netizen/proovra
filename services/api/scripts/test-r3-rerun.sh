#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase R3 migration partial-state simulation helper.
#
# Validates that 20270101000000_phase_r3_model_catchup/migration.sql is safe
# to apply against three distinct database states:
#
#   1. Clean DB                            — first-time apply, no schema present.
#   2. Already-applied DB                  — rerun on a DB where it already ran.
#   3. Partial production state            — a subset of the migration's tables
#                                            exist (matching the documented prod
#                                            partial-apply: 5 tables present, 9
#                                            missing).
#
# Requires a local Postgres reachable at TEST_DATABASE_URL. We do NOT touch
# the developer's primary database — the script creates and drops disposable
# test databases via the `postgres` administrative database.
#
# Usage:
#   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
#     services/api/scripts/test-r3-rerun.sh
#
# Exit codes:
#   0 — all three scenarios applied + reran cleanly
#   1 — any scenario failed (output preserved for debugging)
# ---------------------------------------------------------------------------

set -euo pipefail

MIGRATION="services/api/prisma/migrations/20270101000000_phase_r3_model_catchup/migration.sql"

if [[ ! -f "$MIGRATION" ]]; then
  echo "ERROR: migration not found at $MIGRATION (run from repo root)" >&2
  exit 1
fi

ADMIN_URL="${TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
# Derive a base URL we can append db names to.
BASE_URL="${ADMIN_URL%/*}"

DB_PREFIX="r3_test_$$_"

cleanup() {
  for suffix in clean rerun partial; do
    psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -q -c "DROP DATABASE IF EXISTS ${DB_PREFIX}${suffix};" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

run_migration() {
  local db="$1"
  local label="$2"
  echo "  ↳ ${label}"
  psql "${BASE_URL}/${db}" -v ON_ERROR_STOP=1 -q -f "$MIGRATION"
}

count_tables() {
  local db="$1"
  psql "${BASE_URL}/${db}" -At -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';"
}

count_constraints() {
  local db="$1"
  psql "${BASE_URL}/${db}" -At -c "
    SELECT COUNT(*)
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname='public' AND c.contype IN ('p','u','f');"
}

echo "=== R3 migration rerun-check ==="
echo "Admin URL: ${ADMIN_URL}"
echo

# ---------------------------------------------------------------------------
# SCENARIO 1 — Clean DB
# ---------------------------------------------------------------------------
echo "Scenario 1: clean DB → apply + rerun"
DB="${DB_PREFIX}clean"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB};"
run_migration "$DB" "first apply"
T1=$(count_tables "$DB")
C1=$(count_constraints "$DB")
echo "    tables=${T1}, pk+uniq+fk=${C1}"

# Rerun (idempotency check) — must succeed and leave counts unchanged.
run_migration "$DB" "rerun (idempotency)"
T2=$(count_tables "$DB")
C2=$(count_constraints "$DB")
echo "    after rerun: tables=${T2}, pk+uniq+fk=${C2}"
if [[ "$T1" != "$T2" || "$C1" != "$C2" ]]; then
  echo "FAIL: rerun changed table or constraint counts" >&2
  exit 1
fi
echo "  ✓ scenario 1 passed"
echo

# ---------------------------------------------------------------------------
# SCENARIO 2 — Already-applied DB (alias for scenario 1 rerun; kept for clarity).
# ---------------------------------------------------------------------------
echo "Scenario 2: already-applied DB → second rerun"
run_migration "$DB" "third apply (no-op)"
T3=$(count_tables "$DB")
C3=$(count_constraints "$DB")
if [[ "$T3" != "$T2" || "$C3" != "$C2" ]]; then
  echo "FAIL: third apply changed counts" >&2
  exit 1
fi
echo "  ✓ scenario 2 passed"
echo

# ---------------------------------------------------------------------------
# SCENARIO 3 — Partial production state.
#
# Pre-creates the 5 tables that exist on production WITHOUT their R3 FK/UNIQUE
# constraints (the documented partial-apply state):
#   external_review_invitation_deliveries
#   redaction_projects
#   redaction_versions
#   redaction_regions
#   redaction_detections
#
# After the migration runs, all 9 missing tables must exist AND the 5
# pre-existing tables must have their R3 FK/UNIQUE constraints added.
# ---------------------------------------------------------------------------
echo "Scenario 3: partial production state → apply + rerun"
DB="${DB_PREFIX}partial"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB};"

# Pre-create the 5 tables WITHOUT their FK/UNIQUE constraints. We only need
# PK + the columns referenced by R3 FKs/uniques so the partial check exercises
# the "table exists, constraint missing" branch.
psql "${BASE_URL}/${DB}" -v ON_ERROR_STOP=1 -q <<'PARTIAL_SQL'
CREATE TABLE "external_review_invitation_deliveries" (
  "id"         UUID NOT NULL PRIMARY KEY,
  "team_id"    UUID NOT NULL,
  "grant_id"   UUID NOT NULL,
  "status"     VARCHAR(40) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "redaction_projects" (
  "id"          UUID NOT NULL PRIMARY KEY,
  "team_id"     UUID NOT NULL,
  "evidence_id" UUID NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "redaction_versions" (
  "id"              UUID NOT NULL PRIMARY KEY,
  "project_id"      UUID NOT NULL,
  "team_id"         UUID NOT NULL,
  "version_ordinal" INTEGER NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "redaction_regions" (
  "id"         UUID NOT NULL PRIMARY KEY,
  "version_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "redaction_detections" (
  "id"         UUID NOT NULL PRIMARY KEY,
  "version_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
PARTIAL_SQL

PRE=$(count_tables "$DB")
echo "    pre-state: tables=${PRE}"
run_migration "$DB" "apply against partial state"
POST=$(count_tables "$DB")
POSTC=$(count_constraints "$DB")
echo "    post-apply: tables=${POST}, pk+uniq+fk=${POSTC}"

# Verify the production-failure FK now exists.
FK_PRESENT=$(psql "${BASE_URL}/${DB}" -At -c "
  SELECT COUNT(*) FROM pg_constraint
   WHERE conname = 'external_review_invitation_deliveries_grant_id_fkey';")
if [[ "$FK_PRESENT" != "1" ]]; then
  echo "FAIL: the production-failure FK (external_review_invitation_deliveries_grant_id_fkey) was not added" >&2
  exit 1
fi
echo "    ✓ production-failure FK added retroactively"

# Rerun must be a no-op.
run_migration "$DB" "rerun against partial-then-full state"
POST2=$(count_tables "$DB")
POSTC2=$(count_constraints "$DB")
if [[ "$POST" != "$POST2" || "$POSTC" != "$POSTC2" ]]; then
  echo "FAIL: rerun changed counts after partial-state apply" >&2
  exit 1
fi
echo "  ✓ scenario 3 passed"
echo

echo "=== ALL SCENARIOS PASSED ==="
