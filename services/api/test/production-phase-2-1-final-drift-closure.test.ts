/**
 * Phase 2.1 — Final Drift Closure regression test.
 *
 * Pins the bounded scope of `migration.sql` for
 * `20270809000000_phase_2_1_final_drift_closure`:
 *
 *   1. CREATE TABLE IF NOT EXISTS "redaction_policy_audits"  (plural;
 *      matches Prisma `@@map`). Legacy singular `redaction_policy_audit`
 *      is NOT touched.
 *   2. ALTER TABLE IF EXISTS "entitlements"
 *        ADD COLUMN IF NOT EXISTS "team_seats" INTEGER NOT NULL DEFAULT 0
 *   3. ALTER TABLE IF EXISTS "verification_packages"
 *        ADD COLUMN IF NOT EXISTS "package_type" VARCHAR(64)
 *   4. ALTER TABLE IF EXISTS "verification_packages"
 *        ADD COLUMN IF NOT EXISTS "trust_decision_snapshot" JSONB
 *
 * Hard rules pinned (consistent with the user's Phase 2.1 brief):
 *   - No DROP / RENAME / TRUNCATE / DELETE / SET NOT NULL / DROP NOT NULL
 *     in the DDL body (header comments are excluded from the check).
 *   - Every ALTER uses IF NOT EXISTS.
 *   - The CREATE TABLE uses IF NOT EXISTS.
 *   - Migration ID is allowlisted in PERMITTED_LATER_MIGRATIONS.
 *   - Prisma schema still declares each repaired field (proves the
 *     migration brings the DB up to the schema, not the other way).
 *
 * Style: source-contract (readFileSync), matching
 * `production-phase1-drift-stabilization.test.ts` and
 * `production-phase2-drift-remediation.test.ts`.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const MIGRATION_PATH =
  "services/api/prisma/migrations/20270809000000_phase_2_1_final_drift_closure/migration.sql";

const MIGRATION = readRepo(MIGRATION_PATH);

// Strip `-- line comments` so destructive-SQL guards run against
// EXECUTED SQL only (the header comment block intentionally enumerates
// the forbidden verbs for documentation; that should not trip the guard).
function ddlBody(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const DDL = ddlBody(MIGRATION);
const SCHEMA = readRepo("services/api/prisma/schema.prisma");
const ALLOWLIST_TEST = readRepo(
  "services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts",
);

// =============================================================================
// GROUP A — file presence + ID allowlist
// =============================================================================

describe("Phase 2.1 — file + allowlist", () => {
  it("migration file exists at the expected path", () => {
    expect(
      existsSync(
        fileURLToPath(new URL(`../../../${MIGRATION_PATH}`, import.meta.url)),
      ),
    ).toBe(true);
    expect(MIGRATION.length).toBeGreaterThan(800);
  });

  it("migration ID is appended to PERMITTED_LATER_MIGRATIONS", () => {
    expect(ALLOWLIST_TEST).toMatch(
      /"20270809000000_phase_2_1_final_drift_closure"/,
    );
  });

  it("header block enumerates the brief constraints", () => {
    expect(MIGRATION).toMatch(/Phase 2\.1/i);
    expect(MIGRATION).toMatch(/ADDITIVE-ONLY|ADD COLUMN IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/IDEMPOTENT/i);
  });
});

// =============================================================================
// GROUP B — Item 1: CREATE TABLE IF NOT EXISTS redaction_policy_audits (plural)
// =============================================================================

describe("Phase 2.1 — item 1: redaction_policy_audits plural table", () => {
  it("CREATE TABLE uses the Phase O-Final pg_tables guard + EXECUTE pattern (not bare IF NOT EXISTS)", () => {
    // Phase O safety gate forbids `CREATE TABLE IF NOT EXISTS` because it
    // silently skips the entire block when the table already exists,
    // hiding missed column evolution. The canonical safe pattern is a
    // DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_tables ...) THEN EXECUTE
    // $sql$ CREATE TABLE "redaction_policy_audits" ... $sql$; END IF; END $$;
    expect(DDL).toMatch(/DO\s+\$\$[\s\S]{0,200}pg_tables[\s\S]{0,200}redaction_policy_audits[\s\S]{0,200}EXECUTE\s+\$sql\$/i);
    expect(DDL).toMatch(/CREATE\s+TABLE\s+"redaction_policy_audits"/);
    // And the bare `CREATE TABLE IF NOT EXISTS` form is explicitly absent
    // (would trip the Phase O safety-gate CI test).
    expect(DDL).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"redaction_policy_audits"/i);
  });

  it("safety-net ALTER ADD COLUMN IF NOT EXISTS covers every required column", () => {
    // Defence-in-depth: if the table existed before but was missing a
    // column the schema declares, the per-column ALTER catches it.
    for (const col of [
      "policy_id",
      "team_id",
      "actor_user_id",
      "code",
      "payload",
      "policy_version_id",
      "occurred_at_utc",
      "created_at",
    ]) {
      expect(DDL).toMatch(
        new RegExp(
          `ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"redaction_policy_audits"[\\s\\S]{0,800}ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"`,
          "i",
        ),
      );
    }
  });

  it("legacy singular table is NOT referenced in any destructive verb", () => {
    // The migration may MENTION the singular table in the header comment
    // (excluded from DDL), but the DDL body must never DROP / RENAME /
    // ALTER / TRUNCATE / DELETE FROM / UPDATE it.
    expect(DDL).not.toMatch(/DROP\s+TABLE\s+["']?redaction_policy_audit["']?\b/i);
    expect(DDL).not.toMatch(/ALTER\s+TABLE\s+["']?redaction_policy_audit["']?\b/i);
    expect(DDL).not.toMatch(/RENAME[\s\S]{0,80}redaction_policy_audit\b/i);
    expect(DDL).not.toMatch(/TRUNCATE[\s\S]{0,40}redaction_policy_audit\b/i);
    expect(DDL).not.toMatch(/DELETE\s+FROM\s+["']?redaction_policy_audit["']?\b/i);
    expect(DDL).not.toMatch(/UPDATE\s+["']?redaction_policy_audit["']?\b/i);
  });

  it("plural table declares every column the Prisma model requires", () => {
    // Match Prisma model RedactionPolicyAudit:
    //   id, policy_id, team_id, actor_user_id, code, payload,
    //   policy_version_id, occurred_at_utc, created_at
    for (const col of [
      '"id"',
      '"policy_id"',
      '"team_id"',
      '"actor_user_id"',
      '"code"',
      '"payload"',
      '"policy_version_id"',
      '"occurred_at_utc"',
      '"created_at"',
    ]) {
      expect(DDL).toContain(col);
    }
  });

  it("plural-table indexes match the Prisma @@index declarations", () => {
    expect(DDL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"redaction_policy_audits_policy_created_idx"/i,
    );
    expect(DDL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"redaction_policy_audits_policy_version_idx"/i,
    );
    expect(DDL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"redaction_policy_audits_team_idx"/i,
    );
  });

  it("FK constraints are added through information_schema guards", () => {
    // Both FKs (policy + version) must be wrapped in a DO $$ block with
    // table-existence + constraint-existence guards so re-running is safe.
    expect(DDL).toMatch(/DO\s+\$\$[\s\S]{0,2000}information_schema\.table_constraints[\s\S]{0,2000}END\s+\$\$/i);
    expect(DDL).toMatch(/redaction_policy_audits_policy_fk/);
    expect(DDL).toMatch(/redaction_policy_audits_version_fk/);
  });

  it("Prisma model still maps to the plural table name", () => {
    expect(SCHEMA).toMatch(/@@map\("redaction_policy_audits"\)/);
  });
});

// =============================================================================
// GROUP C — Items 2-4: 3-column additive safety net
// =============================================================================

describe("Phase 2.1 — items 2-4: 3-column safety net", () => {
  it("entitlements.team_seats — INTEGER NOT NULL DEFAULT 0", () => {
    expect(DDL).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"entitlements"[\s\S]{0,200}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"team_seats"\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i,
    );
    // Prisma model still declares the field with @default(0).
    expect(SCHEMA).toMatch(
      /teamSeats\s+Int\s+@default\(0\)\s+@map\("team_seats"\)/,
    );
  });

  it("verification_packages.package_type — VARCHAR(64) NULL", () => {
    expect(DDL).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"verification_packages"[\s\S]{0,200}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"package_type"\s+VARCHAR\(64\)/i,
    );
    // Prisma model still declares the field as optional VarChar(64).
    expect(SCHEMA).toMatch(
      /packageType\s+String\?\s+@map\("package_type"\)\s+@db\.VarChar\(64\)/,
    );
  });

  it("verification_packages.trust_decision_snapshot — JSONB NULL", () => {
    expect(DDL).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"verification_packages"[\s\S]{0,200}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"trust_decision_snapshot"\s+JSONB/i,
    );
    // Prisma model still declares the field as optional Json.
    expect(SCHEMA).toMatch(
      /trustDecisionSnapshot\s+Json\?\s+@map\("trust_decision_snapshot"\)/,
    );
  });
});

// =============================================================================
// GROUP D — Bounded destructive-SQL guards (DDL body only)
// =============================================================================

describe("Phase 2.1 — destructive-SQL guards", () => {
  it("no DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT / DROP TYPE", () => {
    expect(DDL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(DDL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(DDL).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(DDL).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(DDL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(DDL).not.toMatch(/\bDROP\s+SCHEMA\b/i);
  });

  it("no ALTER COLUMN DROP NOT NULL / SET NOT NULL on existing columns", () => {
    expect(DDL).not.toMatch(/\bALTER\s+COLUMN\b[\s\S]{0,60}\bDROP\s+NOT\s+NULL\b/i);
    expect(DDL).not.toMatch(/\bALTER\s+COLUMN\b[\s\S]{0,60}\bSET\s+NOT\s+NULL\b/i);
  });

  it("no RENAME of any kind", () => {
    expect(DDL).not.toMatch(/\bRENAME\b/i);
  });

  it("no TRUNCATE / DELETE FROM / destructive UPDATE / REVOKE / GRANT", () => {
    expect(DDL).not.toMatch(/\bTRUNCATE\b/i);
    expect(DDL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(DDL).not.toMatch(/\bREVOKE\b/i);
    expect(DDL).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    // UPDATE only allowed in DEFAULT clauses, never as a free statement.
    expect(DDL).not.toMatch(/^\s*UPDATE\s+/im);
  });

  it("every ADD COLUMN uses IF NOT EXISTS", () => {
    const adds = DDL.match(/ADD\s+COLUMN\b[^;]*/gi) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(3);
    for (const a of adds) {
      expect(a).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    }
  });

  it("every CREATE INDEX uses IF NOT EXISTS", () => {
    const indexes = DDL.match(/CREATE\s+(UNIQUE\s+)?INDEX\b[^;]*/gi) ?? [];
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    for (const i of indexes) {
      expect(i).toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i);
    }
  });

  it("the only CREATE TABLE is wrapped in the Phase O-Final pg_tables guard", () => {
    // Phase O safety gate forbids bare `CREATE TABLE IF NOT EXISTS` — it
    // silently skips the entire block when the table already exists,
    // hiding missed column evolution. The safe alternative is a guarded
    // DO $$ ... pg_tables ... EXECUTE 'CREATE TABLE ...' END $$ block.
    // We pin BOTH: there is exactly one CREATE TABLE statement AND it
    // is NOT the bare IF NOT EXISTS form AND it is preceded by a
    // pg_tables existence check.
    const creates = DDL.match(/CREATE\s+TABLE\b[^;]*/gi) ?? [];
    expect(creates.length).toBe(1);
    expect(creates[0]).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    expect(DDL).toMatch(
      /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_tables[\s\S]{0,400}redaction_policy_audits[\s\S]{0,400}CREATE\s+TABLE\s+"redaction_policy_audits"/i,
    );
  });
});
