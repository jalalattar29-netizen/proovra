#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Dry-run helper for all unapplied R7 migrations.
#
# For each migration in the R7 series, this script:
#   1. Copies migration.sql to /tmp/<basename>.sql
#   2. Replaces the trailing COMMIT; with ROLLBACK; so the apply is observable
#      but no changes persist (a true dry-run — same statements run in the
#      same transaction, then rolled back).
#   3. Executes via `npx prisma db execute --file /tmp/<basename>.sql` against
#      the DATABASE_URL env var.
#
# Exit codes:
#   0 — every migration applied + rolled back cleanly
#   1 — any migration failed to parse / apply (output preserved for debugging)
#
# Usage:
#   DATABASE_URL=postgres://… services/api/scripts/dry-run-unapplied-migrations.sh
#
# This validates each remaining migration against the CURRENT live database
# state (whatever partial-apply prod is in) without persisting any change.
# Run it from the repo root (it locates prisma.config.ts via the services/api
# working directory).
# ---------------------------------------------------------------------------

set -uo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL must be set (export DATABASE_URL=postgres://… first)" >&2
  exit 1
fi

# Migrations to dry-run, in apply order.
MIGRATIONS=(
  "20270102000000_phase_r7_schema_catchup"
  "20270103000000_phase_r7_trust_schema_fix"
  "20270104000000_phase_r7_redaction_schema_fix"
  "20270105000000_phase_r7_reviewer_workspace_schema_fix"
  "20270106000000_phase_r7_governance_schema_fix"
  "20270107000000_phase_r7_capture_trust_schema_fix"
  "20270108000000_phase_r7_intelligence_schema_fix"
  "20270109000000_phase_r7_redaction_policy_unique"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIG_DIR="${REPO_ROOT}/services/api/prisma/migrations"
API_DIR="${REPO_ROOT}/services/api"

if [[ ! -d "$MIG_DIR" ]]; then
  echo "ERROR: cannot locate ${MIG_DIR}" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED=()

for m in "${MIGRATIONS[@]}"; do
  SRC="${MIG_DIR}/${m}/migration.sql"
  DRY="/tmp/${m}__dry-run.sql"
  if [[ ! -f "$SRC" ]]; then
    echo "  ✗ ${m} — source missing"
    FAIL=$((FAIL + 1))
    FAILED+=("$m (missing)")
    continue
  fi

  # Replace the trailing COMMIT; (and any whitespace around it) with ROLLBACK;
  # so the migration is exercised end-to-end but never persists.
  # sed pattern: every COMMIT; on its own line becomes ROLLBACK;
  sed -E 's/^[[:space:]]*COMMIT[[:space:]]*;[[:space:]]*$/ROLLBACK;/' "$SRC" > "$DRY"

  echo "→ ${m}"
  if (cd "$API_DIR" && npx --no-install prisma db execute --file "$DRY" --schema=prisma/schema.prisma > "/tmp/${m}__output.log" 2>&1); then
    echo "  ✓ apply + rollback OK"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAILED — see /tmp/${m}__output.log"
    tail -20 "/tmp/${m}__output.log" | sed 's/^/      /'
    FAIL=$((FAIL + 1))
    FAILED+=("$m")
  fi
done

echo
echo "==============================="
echo "Migration dry-run summary:"
echo "  passed: ${PASS}/${#MIGRATIONS[@]}"
echo "  failed: ${FAIL}/${#MIGRATIONS[@]}"
if (( FAIL > 0 )); then
  echo "  failed migrations:"
  for f in "${FAILED[@]}"; do echo "    - $f"; done
  exit 1
fi
echo "All migrations safe to apply against the current DB state."
