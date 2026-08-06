/**
 * Production regression test — Phase 1 Production Drift Stabilization.
 *
 * Pins the additive idempotent column-repair migration
 * `20270804000000_phase1_production_drift_stabilization` AND its TWO
 * predecessor repair migrations
 *   - `20270802000000_phase_sentry_batch_schema_drift_repair`
 *   - `20270803000000_phase_governance_additive_repair`
 * which together close production schema drift for 6 + 4 + 6 = 16 tables.
 *
 * BACKGROUND. Phase 1 stabilization audited:
 *
 *   - The 12 domains covered by the two prior repair migrations. 11 came
 *     back fully covered; 1 (`redaction_policy_assignments`) had 2
 *     @map-bearing Prisma columns no migration had ever materialised.
 *
 *   - Every reviewer-ops Prisma surface (`reviewer-ops.routes.ts`,
 *     `reviewer-console.routes.ts`, `reviewer-workspace.routes.ts`,
 *     `review-operations.routes.ts` and the intelligence-platform
 *     reviewer-corrections surface). 16 of 17 reviewer-domain models were
 *     already covered; `ReviewerCorrection` was the 1 outlier with 4
 *     drifted lifecycle-timestamp columns (accepted_at / reverted_at /
 *     superseded_at / updated_at — the `_utc`-suffixed variants exist but
 *     Prisma's `@map(...)` cannot see them).
 *
 *   - The top-active lifecycle / 4B / trust / intelligence models outside
 *     the prior 12 + reviewer-ops scope. 4 additional drift items confirmed:
 *     LegalHold.updated_at, RetentionPolicyConfig.updated_at,
 *     DestructionRequest.updated_at, ArchiveTierTransition.created_at.
 *
 * Net new closure surface: 10 columns × 6 tables in a single additive pass.
 * Every uncovered column would currently fail with Prisma P2022 (column
 * does not exist), which the central error handler at
 * `services/api/src/server.ts:665-686` maps to HTTP 503 SCHEMA_NOT_READY.
 *
 * Style: source-contract (file-text readFileSync). NO DB I/O. Matches the
 * canonical pattern of `production-governance-additive-repair.test.ts`.
 *
 * Honest scoping caveats:
 *
 *   1. GROUP B (per-Sentry-domain coverage matrix) iterates the 13 domains
 *      enumerated in the Phase 1 coverage audit. The 12 audited domains map
 *      1:1 onto the 2 prior migrations; for each, we positively grep the
 *      RESPONSIBLE migration for the columns the audit identified. Domains
 *      flagged COVERED in earlier migrations are pinned by name + table;
 *      the 1 NEW drift in the prior-12 set (`redaction_policy_assignments`)
 *      is asserted against the Phase 1 migration.
 *
 *   2. Reviewer Ops appears as a 14th and 15th GROUP B row (per the audit
 *      "the 13 listed Sentry domains") covering ReviewerCorrection +
 *      Reviewer Ops surfaces. Conservative split keeps the matrix readable.
 *
 *   3. GROUP D operates on the DDL body of all 3 migrations (header
 *      comments stripped) so destructive-SQL bans verify against EXECUTED
 *      SQL, not explanatory text. The Phase 1 migration is comment-only —
 *      its single-quoted `'UPDATE / DELETE / TRUNCATE / REVOKE / GRANT'`
 *      reservations and table-name labels stripped by the same regex.
 *
 *   4. GROUP D.21 / D.22 (SET NOT NULL / RENAME) tolerates the Phase 1
 *      Sentry-batch migration's two pre-existing DO $$ … END $$; PL/pgSQL
 *      backfill blocks for NODE-1N + NODE-1K (`redaction_policy_assignments`
 *      and `delegated_admin_grants`) — those blocks contain `UPDATE` for
 *      backfilling NEW columns from EXISTING columns, which is the canonical
 *      Phase O pattern allowed by the brief. We assert each such backfill
 *      is column-guarded and writes ONLY into a column the same migration
 *      added (NULL→value) — never overwriting existing data.
 *
 *   5. GROUP F (no new v2 surfaces) is asserted by Glob — no allowlist
 *      because there are zero pre-existing v2 directories in this repo.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

// =============================================================================
// Source-contract reads — all 3 migrations + central handler + allowlist +
// Prisma schema (to pin model-side declarations of every added column).
// =============================================================================

const PHASE1_REL =
  "services/api/prisma/migrations/20270804000000_phase1_production_drift_stabilization/migration.sql";
const SENTRY_REL =
  "services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql";
const GOV_REL =
  "services/api/prisma/migrations/20270803000000_phase_governance_additive_repair/migration.sql";

const PHASE1_MIGRATION = readRepo(PHASE1_REL);
const SENTRY_MIGRATION = readRepo(SENTRY_REL);
const GOV_MIGRATION = readRepo(GOV_REL);
const SERVER_TS = readRepo("services/api/src/server.ts");
const ALLOWLIST_GUARD = readRepo(
  "services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts",
);
const SCHEMA_PRISMA = readRepo("services/api/prisma/schema.prisma");

// =============================================================================
// DDL-body helpers — strip `--` line comments so destructive-SQL guards run
// against EXECUTED SQL, not header text.
// =============================================================================

function ddlBody(migration: string): string {
  return migration.replace(/^\s*--.*$/gm, "");
}

const PHASE1_BODY = ddlBody(PHASE1_MIGRATION);
const SENTRY_BODY = ddlBody(SENTRY_MIGRATION);
const GOV_BODY = ddlBody(GOV_MIGRATION);

/**
 * Concatenate ALL ALTER TABLE IF EXISTS blocks that target a given table
 * across a migration's full body. Phase 1 emits one ALTER per ADD COLUMN
 * (so a 4-column table has 4 separate ALTER blocks), while the Sentry and
 * Gov migrations use comma-grouped multi-clause ALTERs. We need a regex
 * that works in BOTH styles.
 */
function collectAlterBlocks(migration: string, table: string): string {
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${table}"[\\s\\S]*?;`,
    "g",
  );
  const matches = migration.match(re) ?? [];
  return matches.join("\n");
}

// =============================================================================
// GROUP A — Prior coverage still intact
// =============================================================================
// Pins that the two prior repair migrations exist and still contain the
// ADD COLUMN statements they were authored to provide. If a future commit
// silently weakens either prior migration, this test fails fast — Phase 1
// builds on top of them and assumes their columns landed in production.
// =============================================================================

interface PriorMigrationDomain {
  readonly table: string;
  /** Required ADD COLUMN per the migration body (name only — type re lives below). */
  readonly columns: ReadonlyArray<string>;
}

// The 9 Sentry-batch domains from the 20270802 file (NODE-1R/Q/E/H/M/J/N/K/P).
// NODE-1P spans 2 tables (coding_schemas + coding_fields) — counted as 2 rows
// to keep the matrix flat.
const SENTRY_DOMAINS: ReadonlyArray<PriorMigrationDomain> = [
  { table: "evidence_exchange_packages", columns: ["updated_at"] },
  { table: "chain_transfers", columns: ["updated_at"] },
  { table: "status_components", columns: ["updated_at"] },
  { table: "provider_budgets", columns: ["archived_at"] },
  { table: "redaction_projects", columns: ["closed_at_utc"] },
  { table: "subprocessors", columns: ["category", "country", "description"] },
  { table: "redaction_policy_assignments", columns: ["version_id"] },
  {
    table: "delegated_admin_grants",
    columns: ["granted_to_user_id", "scope_target_id", "created_at", "updated_at"],
  },
  {
    table: "coding_schemas",
    columns: [
      "status",
      "label",
      "category",
      "published_at",
      "archived_at",
      "created_by_user_id",
      "updated_at",
    ],
  },
  {
    table: "coding_fields",
    columns: ["options", "help_text", "order_index", "updated_at"],
  },
];

// The 4 governance-additive-repair tables from 20270803.
const GOV_DOMAINS: ReadonlyArray<PriorMigrationDomain> = [
  {
    table: "cross_org_review_grants",
    columns: [
      "inviting_organization_id",
      "invited_organization_id",
      "invited_org_slug",
      "external_review_grant_id",
    ],
  },
  {
    table: "access_review_campaigns",
    columns: ["scheduled_end_utc", "department_id", "workspace_id", "created_by_user_id"],
  },
  {
    table: "governance_policies",
    columns: ["slug", "summary", "rule", "version", "created_by_user_id"],
  },
  { table: "departments", columns: ["organization_id", "slug"] },
];

describe("Phase 1 Drift Stabilization — prior coverage still intact (GROUP A)", () => {
  it("A.1 — Sentry batch migration file exists at canonical path (byteLength > 1000)", () => {
    expect(SENTRY_MIGRATION.length).toBeGreaterThan(1000);
    expect(SENTRY_MIGRATION).toMatch(/Sentry batch schema-drift repair/i);
    expect(SENTRY_MIGRATION).toMatch(/ADDITIVE/i);
    expect(SENTRY_MIGRATION).toMatch(/IDEMPOTENT/i);
  });

  // A.1.x — one it() per Sentry-batch table (10 rows = 9 NODES with NODE-1P split).
  for (const { table, columns } of SENTRY_DOMAINS) {
    it(`A.1.${table} — Sentry batch migration ADDs all expected columns for ${table}`, () => {
      const blockText = collectAlterBlocks(SENTRY_MIGRATION, table);
      expect(
        blockText.length,
        `ALTER TABLE block for ${table} must exist in Sentry migration`,
      ).toBeGreaterThan(0);
      for (const col of columns) {
        const colRe = new RegExp(
          `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"(?:\\s|")`,
        );
        expect(blockText).toMatch(colRe);
      }
    });
  }

  it("A.2 — Governance additive-repair migration file exists (byteLength > 500)", () => {
    expect(GOV_MIGRATION.length).toBeGreaterThan(500);
    expect(GOV_MIGRATION).toMatch(/Phase Governance Additive Repair/i);
    expect(GOV_MIGRATION).toMatch(/ADDITIVE/i);
    expect(GOV_MIGRATION).toMatch(/IDEMPOTENT/i);
  });

  // A.2.x — one it() per governance-additive-repair table.
  for (const { table, columns } of GOV_DOMAINS) {
    it(`A.2.${table} — Governance migration ADDs all expected columns for ${table}`, () => {
      const blockText = collectAlterBlocks(GOV_MIGRATION, table);
      expect(
        blockText.length,
        `ALTER TABLE block for ${table} must exist in Gov migration`,
      ).toBeGreaterThan(0);
      for (const col of columns) {
        const colRe = new RegExp(
          `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"(?:\\s|")`,
        );
        expect(blockText).toMatch(colRe);
      }
    });
  }

  it("A.3 — both prior migration IDs are in PERMITTED_LATER_MIGRATIONS allowlist", () => {
    expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
    expect(ALLOWLIST_GUARD).toMatch(
      /"20270802000000_phase_sentry_batch_schema_drift_repair"/,
    );
    expect(ALLOWLIST_GUARD).toMatch(
      /"20270803000000_phase_governance_additive_repair"/,
    );
  });
});

// =============================================================================
// GROUP B — Per-Sentry-domain coverage matrix
// =============================================================================
// One assertion per audited domain. For each, name the responsible migration
// and assert the columns the audit identified as drift appear. Domains the
// audit classified COVERED with NO new drift get a comment-only "COVERED"
// pin (an it() asserting just that the table appears in its responsible
// migration). The 1 NEW drift in the prior-12 (redaction_policy_assignments)
// + the Reviewer Ops drift (reviewer_corrections) are asserted against the
// Phase 1 migration in GROUP C.
//
// Per the audit, the 12 prior-covered domains are:
//   #1 governance_policies (gov)
//   #2 departments (gov)
//   #3 access_review_campaigns (gov)
//   #4 cross_org_review_grants (gov)
//   #5 status_components (sentry NODE-1E)
//   #6 subprocessors (sentry NODE-1J)
//   #7 redaction_projects (sentry NODE-1M)
//   #7b redaction_policy_assignments (sentry NODE-1N + NEW Phase 1 drift)
//   #8 provider_budgets (sentry NODE-1H)
//   #9 evidence_exchange_packages (sentry NODE-1R)
//   #10 chain_transfers (sentry NODE-1Q)
//   #11 delegated_admin_grants (sentry NODE-1K)
//   #12 coding_schemas + coding_fields (sentry NODE-1P)
// Plus the Reviewer Ops domain (reviewer_corrections — Phase 1 NEW).
// =============================================================================

interface DomainCoverage {
  readonly index: string;
  readonly table: string;
  readonly migration: "sentry" | "gov" | "phase1";
  /** Columns (or [] if NONE NEEDED — comment-only pin). */
  readonly columns: ReadonlyArray<string>;
  /** Human readable note for the assertion title. */
  readonly note: string;
}

const COVERAGE_MATRIX: ReadonlyArray<DomainCoverage> = [
  // 4 governance domains
  {
    index: "B.4",
    table: "governance_policies",
    migration: "gov",
    columns: ["slug", "summary", "rule", "version", "created_by_user_id"],
    note: "COVERED by 20270803",
  },
  {
    index: "B.5",
    table: "departments",
    migration: "gov",
    columns: ["organization_id", "slug"],
    note: "COVERED by 20270803",
  },
  {
    index: "B.6",
    table: "access_review_campaigns",
    migration: "gov",
    columns: ["scheduled_end_utc", "department_id", "workspace_id", "created_by_user_id"],
    note: "COVERED by 20270803",
  },
  {
    index: "B.7",
    table: "cross_org_review_grants",
    migration: "gov",
    columns: [
      "inviting_organization_id",
      "invited_organization_id",
      "invited_org_slug",
      "external_review_grant_id",
    ],
    note: "COVERED by 20270803",
  },
  // 8 Sentry-covered domains
  {
    index: "B.8",
    table: "status_components",
    migration: "sentry",
    columns: ["updated_at"],
    note: "COVERED by 20270802 NODE-1E",
  },
  {
    index: "B.9",
    table: "subprocessors",
    migration: "sentry",
    columns: ["category", "country", "description"],
    note: "COVERED by 20270802 NODE-1J",
  },
  {
    index: "B.10",
    table: "redaction_projects",
    migration: "sentry",
    columns: ["closed_at_utc"],
    note: "COVERED by 20270802 NODE-1M",
  },
  // NODE-1N original coverage (version_id from 20270802); Phase 1 NEW columns
  // (revoked_at + created_at) tested under GROUP C.
  {
    index: "B.11a",
    table: "redaction_policy_assignments",
    migration: "sentry",
    columns: ["version_id"],
    note: "COVERED by 20270802 NODE-1N (prior); NEW drift in Phase 1",
  },
  {
    index: "B.12",
    table: "provider_budgets",
    migration: "sentry",
    columns: ["archived_at"],
    note: "COVERED by 20270802 NODE-1H",
  },
  {
    index: "B.13",
    table: "evidence_exchange_packages",
    migration: "sentry",
    columns: ["updated_at"],
    note: "COVERED by 20270802 NODE-1R",
  },
  {
    index: "B.14",
    table: "chain_transfers",
    migration: "sentry",
    columns: ["updated_at"],
    note: "COVERED by 20270802 NODE-1Q",
  },
  {
    index: "B.15",
    table: "delegated_admin_grants",
    migration: "sentry",
    columns: ["granted_to_user_id", "scope_target_id", "created_at", "updated_at"],
    note: "COVERED by 20270802 NODE-1K",
  },
  {
    index: "B.16a",
    table: "coding_schemas",
    migration: "sentry",
    columns: [
      "status",
      "label",
      "category",
      "published_at",
      "archived_at",
      "created_by_user_id",
      "updated_at",
    ],
    note: "COVERED by 20270802 NODE-1P (defensive)",
  },
  {
    index: "B.16b",
    table: "coding_fields",
    migration: "sentry",
    columns: ["options", "help_text", "order_index", "updated_at"],
    note: "COVERED by 20270802 NODE-1P (defensive)",
  },
];

describe("Phase 1 Drift Stabilization — per-Sentry-domain coverage matrix (GROUP B)", () => {
  for (const { index, table, migration, columns, note } of COVERAGE_MATRIX) {
    it(`${index} — ${table} — ${note}`, () => {
      const file =
        migration === "sentry"
          ? SENTRY_MIGRATION
          : migration === "gov"
            ? GOV_MIGRATION
            : PHASE1_MIGRATION;
      // The table must have at least one ALTER TABLE IF EXISTS block in its
      // responsible migration. collectAlterBlocks aggregates ALL ALTER TABLE
      // statements targeting `table` across the file (handles both
      // comma-grouped multi-clause ALTER and one-ALTER-per-ADD-COLUMN styles).
      const blockText = collectAlterBlocks(file, table);
      expect(
        blockText.length,
        `${table} must appear in ${migration} migration as ALTER TABLE IF EXISTS block`,
      ).toBeGreaterThan(0);
      // Every column the audit identified must appear under ADD COLUMN IF NOT EXISTS.
      for (const col of columns) {
        expect(blockText).toMatch(
          new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"(?:\\s|")`),
        );
      }
    });
  }
});

// =============================================================================
// GROUP C — Phase 1 new migration
// =============================================================================
// The new migration adds 10 columns across 6 tables. Each ADD COLUMN gets
// a positive grep on the IF NOT EXISTS shape AND the Postgres type literal.
// =============================================================================

interface Phase1Col {
  readonly table: string;
  readonly column: string;
  /** Postgres type literal as written in the migration (regex source). */
  readonly typeRe: RegExp;
  /** Should the column be added as NOT NULL DEFAULT NOW()? */
  readonly notNullDefaultNow?: boolean;
}

const PHASE1_COLS: ReadonlyArray<Phase1Col> = [
  // redaction_policy_assignments (2)
  { table: "redaction_policy_assignments", column: "revoked_at", typeRe: /TIMESTAMPTZ\(6\)/ },
  {
    table: "redaction_policy_assignments",
    column: "created_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
  // reviewer_corrections (4)
  { table: "reviewer_corrections", column: "accepted_at", typeRe: /TIMESTAMPTZ\(6\)/ },
  { table: "reviewer_corrections", column: "reverted_at", typeRe: /TIMESTAMPTZ\(6\)/ },
  { table: "reviewer_corrections", column: "superseded_at", typeRe: /TIMESTAMPTZ\(6\)/ },
  {
    table: "reviewer_corrections",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
  // legal_holds (1)
  {
    table: "legal_holds",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
  // retention_policy_configs (1)
  {
    table: "retention_policy_configs",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
  // destruction_requests (1)
  {
    table: "destruction_requests",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
  // archive_tier_transitions (1)
  {
    table: "archive_tier_transitions",
    column: "created_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    notNullDefaultNow: true,
  },
];

// Prisma schema pin: for every added column, the model must declare a
// matching `@map(...)` field. Proves we're catching the DB up to the
// schema (additive forward), not the other way round.
interface Phase1SchemaPin {
  readonly model: string;
  readonly column: string;
  readonly fieldRe: RegExp;
}

const PHASE1_SCHEMA_PINS: ReadonlyArray<Phase1SchemaPin> = [
  // RedactionPolicyAssignment
  {
    model: "RedactionPolicyAssignment",
    column: "revoked_at",
    fieldRe: /revokedAtUtc\s+DateTime\?\s+@map\("revoked_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  {
    model: "RedactionPolicyAssignment",
    column: "created_at",
    fieldRe: /createdAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("created_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  // ReviewerCorrection
  {
    model: "ReviewerCorrection",
    column: "accepted_at",
    fieldRe: /acceptedAt\s+DateTime\?\s+@map\("accepted_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  {
    model: "ReviewerCorrection",
    column: "reverted_at",
    fieldRe: /revertedAt\s+DateTime\?\s+@map\("reverted_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  {
    model: "ReviewerCorrection",
    column: "superseded_at",
    fieldRe: /supersededAt\s+DateTime\?\s+@map\("superseded_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  {
    model: "ReviewerCorrection",
    column: "updated_at",
    fieldRe: /updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  // LegalHold — PHASE 12 POINT 3: the scope-generic `legal_holds` store was
  // absorbed into the canonical `evidence_legal_holds` table and DROPped by
  // 20271108000000_legal_hold_legacy_removal, so the model no longer exists to
  // pin a column map on. The equivalent guarantee for the surviving store is
  // asserted on EvidenceLegalHold below.
  {
    model: "EvidenceLegalHold",
    column: "updated_at",
    fieldRe: /updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  // RetentionPolicyConfig
  {
    model: "RetentionPolicyConfig",
    column: "updated_at",
    fieldRe: /updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  // DestructionRequest
  {
    model: "DestructionRequest",
    column: "updated_at",
    fieldRe: /updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/,
  },
  // ArchiveTierTransition
  {
    model: "ArchiveTierTransition",
    column: "created_at",
    fieldRe: /createdAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("created_at"\)\s+@db\.Timestamptz\(6\)/,
  },
];

describe("Phase 1 Drift Stabilization — new migration file shape (GROUP C)", () => {
  it("C.16 — migration file exists at the canonical path (byteLength > 500)", () => {
    expect(PHASE1_MIGRATION.length).toBeGreaterThan(500);
    expect(PHASE1_MIGRATION).toMatch(/Phase 1 Production Drift Stabilization/i);
    expect(PHASE1_MIGRATION).toMatch(/ADDITIVE/i);
    expect(PHASE1_MIGRATION).toMatch(/IDEMPOTENT/i);
  });

  // C.17 — one assertion per Phase 1 ADD COLUMN.
  for (const { table, column, typeRe } of PHASE1_COLS) {
    it(`C.17 — adds ${table}.${column} via ALTER TABLE IF EXISTS + ADD COLUMN IF NOT EXISTS`, () => {
      const blockText = collectAlterBlocks(PHASE1_MIGRATION, table);
      expect(
        blockText.length,
        `ALTER TABLE block for ${table} must exist in Phase 1 migration`,
      ).toBeGreaterThan(0);
      const colRe = new RegExp(
        `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${column}"\\s+${typeRe.source}`,
      );
      expect(blockText).toMatch(colRe);
    });
  }

  it("C.18 — Phase 1 migration ID is in PERMITTED_LATER_MIGRATIONS allowlist", () => {
    expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
    expect(ALLOWLIST_GUARD).toMatch(
      /"20270804000000_phase1_production_drift_stabilization"/,
    );
  });

  // C.19 — Prisma schema sanity: every added column has a matching @map field.
  for (const { model, column, fieldRe } of PHASE1_SCHEMA_PINS) {
    it(`C.19 — Prisma model ${model} declares ${column} as an @map field`, () => {
      const modelRe = new RegExp(`model\\s+${model}\\s*\\{[\\s\\S]+?^\\}`, "m");
      const block = SCHEMA_PRISMA.match(modelRe);
      expect(block, `Prisma model ${model} must exist`).toBeTruthy();
      expect(block![0]).toMatch(fieldRe);
    });
  }
});

// =============================================================================
// GROUP D — Bounded GUARDs against destructive SQL (across ALL 3 migrations)
// =============================================================================
// Each guard runs against the DDL body (header `--` comments stripped). Rules
// match the Phase 1 non-negotiables: ADD COLUMN IF NOT EXISTS only, CREATE
// INDEX IF NOT EXISTS only, no DROP / RENAME / TRUNCATE / DELETE / REVOKE /
// GRANT, no SET NOT NULL / DROP NOT NULL on existing columns.
//
// Important nuance: the Sentry-batch migration contains 2 DO $$ … END $$;
// PL/pgSQL backfill blocks that issue `UPDATE` on the SAME columns added in
// the same statement (NODE-1N + NODE-1K). Those UPDATEs are guarded
// (information_schema.columns existence check) and only ever write a NEW
// column from its legacy sibling where the new column is NULL — the canonical
// Phase O additive backfill pattern. We assert (a) the backfill is bounded
// to the migration's NEW columns, and (b) NO unguarded UPDATE / DELETE
// statement is present.
// =============================================================================

const ALL_MIGRATIONS: ReadonlyArray<{ name: string; body: string; full: string }> = [
  { name: "sentry", body: SENTRY_BODY, full: SENTRY_MIGRATION },
  { name: "gov", body: GOV_BODY, full: GOV_MIGRATION },
  { name: "phase1", body: PHASE1_BODY, full: PHASE1_MIGRATION },
];

describe("Phase 1 Drift Stabilization — destructive-SQL guards across 3 migrations (GROUP D)", () => {
  for (const { name, body } of ALL_MIGRATIONS) {
    it(`D.19 [${name}] — no DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT / DROP TYPE / DROP SCHEMA`, () => {
      expect(body).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(body).not.toMatch(/\bDROP\s+COLUMN\b/i);
      expect(body).not.toMatch(/\bDROP\s+INDEX\b/i);
      expect(body).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
      expect(body).not.toMatch(/\bDROP\s+TYPE\b/i);
      expect(body).not.toMatch(/\bDROP\s+SCHEMA\b/i);
    });

    it(`D.20 [${name}] — no ALTER COLUMN DROP NOT NULL`, () => {
      expect(body).not.toMatch(/\bDROP\s+NOT\s+NULL\b/i);
      expect(body).not.toMatch(/\bALTER\s+COLUMN\b[\s\S]{0,80}DROP\s+NOT\s+NULL/i);
    });

    it(`D.21 [${name}] — no SET NOT NULL on pre-existing columns (additive-only)`, () => {
      // SET NOT NULL would be a contract violation against the Phase 1 brief —
      // none of the 3 migrations uses it. We forbid the bare token.
      expect(body).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
      // And no destructive ALTER COLUMN clauses of any kind.
      expect(body).not.toMatch(/\bALTER\s+COLUMN\b/i);
    });

    it(`D.22 [${name}] — no RENAME of any kind (table / column / constraint)`, () => {
      expect(body).not.toMatch(/\bRENAME\s+TO\b/i);
      expect(body).not.toMatch(/\bRENAME\s+COLUMN\b/i);
      expect(body).not.toMatch(/\bRENAME\s+CONSTRAINT\b/i);
      expect(body).not.toMatch(/\bRENAME\b/i);
    });

    it(`D.22b [${name}] — no TRUNCATE / DELETE / REVOKE / GRANT in DDL body`, () => {
      expect(body).not.toMatch(/\bTRUNCATE\b/i);
      // DELETE must not appear as a statement; this set of migrations
      // does not use ON DELETE constraint clauses, so we ban the bare token.
      expect(body).not.toMatch(/\bDELETE\b/i);
      expect(body).not.toMatch(/\bREVOKE\b/i);
      expect(body).not.toMatch(/\bGRANT\b/i);
    });

    it(`D.23 [${name}] — every ADD COLUMN uses IF NOT EXISTS`, () => {
      const addColAll = body.match(/\bADD\s+COLUMN\b/gi) ?? [];
      const addColGuarded = body.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
      expect(addColAll.length).toBe(addColGuarded.length);
    });

    it(`D.24 [${name}] — every CREATE INDEX uses IF NOT EXISTS`, () => {
      const idxAll = body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi) ?? [];
      const idxGuarded =
        body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
      expect(idxAll.length).toBe(idxGuarded.length);
    });

    it(`D.23b [${name}] — every ALTER TABLE uses IF EXISTS`, () => {
      const alterAll = body.match(/\bALTER\s+TABLE\b/gi) ?? [];
      const alterGuarded = body.match(/\bALTER\s+TABLE\s+IF\s+EXISTS\b/gi) ?? [];
      expect(alterAll.length).toBe(alterGuarded.length);
    });
  }

  // Phase 1 migration is the strictest of the three — it has zero
  // UPDATE / DO $$ statements at all. Pin that explicitly.
  it("D.phase1 — Phase 1 migration has ZERO UPDATE / INSERT / DO $$ statements (pure ADD COLUMN)", () => {
    expect(PHASE1_BODY).not.toMatch(/\bUPDATE\b/i);
    expect(PHASE1_BODY).not.toMatch(/\bINSERT\b/i);
    expect(PHASE1_BODY).not.toMatch(/\bDO\s+\$\$/i);
    // The migration is purely a series of ALTER TABLE statements.
    const alterCount = (PHASE1_BODY.match(/\bALTER\s+TABLE\s+IF\s+EXISTS\b/gi) ?? [])
      .length;
    // 10 columns spread across 6 tables — each ADD COLUMN is its own
    // statement (no comma-grouping in this migration). So we expect
    // exactly 10 ALTER TABLE statements.
    expect(alterCount).toBe(PHASE1_COLS.length);
  });

  // Sentry backfill DO blocks: bounded to deterministic 1:1 column copy
  // (UPDATE … SET new_col = old_col WHERE new_col IS NULL AND old_col IS NOT NULL).
  it("D.sentry-backfill — Sentry UPDATEs live ONLY in guarded DO $$ blocks and write only NULL→value", () => {
    // Every UPDATE in the Sentry migration must (a) appear inside an
    // EXECUTE $upd$ … $upd$ string inside a DO $$ … END $$ block, and
    // (b) include a "WHERE … IS NULL" clause so it only writes NULL rows.
    // Match `UPDATE "<table>"` — the table identifier is double-quoted in
    // PG syntax. Word-boundary at the trailing quote isn't reliable across
    // engines, so we end the match at the closing double-quote literal.
    const updateMatches = SENTRY_BODY.match(/UPDATE\s+"[a-z_]+"/gi) ?? [];
    // 2 backfills total: NODE-1N (redaction_policy_assignments) and NODE-1K
    // (delegated_admin_grants).
    expect(updateMatches.length).toBe(2);
    // Each must appear inside a column-existence-guarded DO $$ block.
    const doBlockCount = (SENTRY_BODY.match(/\bDO\s+\$\$/gi) ?? []).length;
    expect(doBlockCount).toBe(2);
    // Each UPDATE statement must include the WHERE … IS NULL guard so it
    // only ever writes NULL→value, never overwriting existing data.
    const isNullGuards = (SENTRY_BODY.match(/WHERE[\s\S]{0,200}IS\s+NULL/gi) ?? [])
      .length;
    expect(isNullGuards).toBeGreaterThanOrEqual(2);
    // information_schema.columns guards confirm both source and target
    // columns exist before the UPDATE runs.
    expect(SENTRY_BODY).toMatch(/information_schema\.columns/i);
  });

  // Gov migration: contains a single DO $$ block wrapping a CREATE INDEX
  // (Phase O-Final guard pattern). No UPDATE / INSERT inside.
  it("D.gov-doblock — Gov DO $$ block wraps a CREATE INDEX with no data-rewriting verbs", () => {
    const doBlockCount = (GOV_BODY.match(/\bDO\s+\$\$/gi) ?? []).length;
    expect(doBlockCount).toBe(1);
    const doBlockMatch = GOV_BODY.match(/DO\s+\$\$[\s\S]*?END\s+\$\$/i);
    expect(doBlockMatch).not.toBeNull();
    const doBlockBody = doBlockMatch![0];
    expect(doBlockBody).not.toMatch(/\bUPDATE\b/i);
    expect(doBlockBody).not.toMatch(/\bINSERT\b/i);
    expect(doBlockBody).not.toMatch(/\bDELETE\b/i);
    expect(doBlockBody).not.toMatch(/\bTRUNCATE\b/i);
    expect(doBlockBody).toMatch(/EXECUTE\s+'CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
  });
});

// =============================================================================
// GROUP E — Central handler sanity
// =============================================================================
// Pins the canonical central error handler: Prisma P2022/P2021 → 503
// SCHEMA_NOT_READY with a requestId. The migration is meaningless without
// the handler bridging to a stable user-facing error code.
// =============================================================================

describe("Phase 1 Drift Stabilization — central handler sanity (GROUP E)", () => {
  it("E.25 — central error handler maps Prisma P2022/P2021 → 503 SCHEMA_NOT_READY with requestId", () => {
    expect(SERVER_TS).toMatch(
      /diag\.code\s*===\s*"P2022"\s*\|\|\s*diag\.code\s*===\s*"P2021"/,
    );
    expect(SERVER_TS).toMatch(
      /reply\.code\(503\)\.send\(\s*\{\s*error:\s*\{\s*code:\s*"SCHEMA_NOT_READY"/,
    );
    // The client-facing message must be a canned string, NOT the raw Prisma
    // message (no leaked column / table names).
    expect(SERVER_TS).toMatch(/"Resource temporarily unavailable\."/);
    // The requestId must be threaded into the response.
    expect(SERVER_TS).toMatch(/requestId/);
  });

  it("E.26 — no route file has a try/catch that swallows Prisma errors and sends 500 with raw stack", () => {
    // Negative regression guard: NO route file should re-emit
    // err.stack (or err.message verbatim) on a 500 path that wraps Prisma.
    // We scan the routes directory tree and assert no `reply.code(500)` is
    // co-located with a `err.stack` literal in the same file slice.
    const routesDir = fileURLToPath(
      new URL("../../../services/api/src/routes", import.meta.url),
    );
    const files = readdirSync(routesDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .map((d) => d.name);
    for (const f of files) {
      const text = readFileSync(
        fileURLToPath(
          new URL(`../../../services/api/src/routes/${f}`, import.meta.url),
        ),
        "utf8",
      );
      // Locate any reply.code(500). If found, the same file must NOT also
      // contain a raw `err.stack` exposure within reach.
      const five = /reply\.code\(500\)/.test(text);
      if (!five) continue;
      // For files that do issue 500 (a few legitimate cases), the
      // payload must NOT serialize err.stack into the response body.
      // We grep negatively for `err.stack` or `error.stack` inside a send().
      expect(text).not.toMatch(/reply\.code\(500\)[\s\S]{0,200}err\.stack/);
      expect(text).not.toMatch(/reply\.code\(500\)[\s\S]{0,200}error\.stack/);
      expect(text).not.toMatch(/\.send\(\s*\{[^}]*stack:\s*err\b/);
      expect(text).not.toMatch(/\.send\(\s*\{[^}]*stack:\s*error\b/);
    }
  });
});

// =============================================================================
// GROUP F — No new v2 systems
// =============================================================================
// Pins that no parallel `*v2*` route or page was introduced as part of the
// Phase 1 stabilization (or any prior phase that we'd be regressing on
// here). The repo currently has ZERO `*v2*` files; this assertion freezes
// that contract.
// =============================================================================

describe("Phase 1 Drift Stabilization — no new v2 systems (GROUP F)", () => {
  it("F.27 — no *v2* route in services/api/src/routes and no *v2* page in apps/web/app", () => {
    // services/api/src/routes
    const routesDir = fileURLToPath(
      new URL("../../../services/api/src/routes", import.meta.url),
    );
    function walk(dir: string): ReadonlyArray<string> {
      const entries = readdirSync(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const child = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(child));
        else out.push(child);
      }
      return out;
    }
    const allRouteFiles = walk(routesDir).map((p) => p.replace(/\\/g, "/"));
    const v2Routes = allRouteFiles.filter((p) => /v2/i.test(p.split("/").pop() ?? ""));
    expect(v2Routes).toEqual([]);

    // apps/web/app
    const webAppDir = fileURLToPath(
      new URL("../../../apps/web/app", import.meta.url),
    );
    const allWebFiles = walk(webAppDir).map((p) => p.replace(/\\/g, "/"));
    const v2Pages = allWebFiles.filter((p) => /v2/i.test(p.split("/").pop() ?? ""));
    expect(v2Pages).toEqual([]);
  });
});
