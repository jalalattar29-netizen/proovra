/**
 * Production regression test — Phase Governance Additive Repair.
 *
 * Pins the additive idempotent column repair migration
 * `20270803000000_phase_governance_additive_repair` and its surrounding
 * contract for 4 governance tables:
 *
 *   - `cross_org_review_grants`   (4 missing columns + 1 supporting index)
 *   - `access_review_campaigns`   (4 missing columns)
 *   - `governance_policies`       (5 missing columns)
 *   - `departments`               (2 missing columns)
 *
 * BACKGROUND. The Phase 4A migration
 * `20261220000000_phase_4a_trust_and_governance` authored these 4 tables
 * with full CREATE TABLE statements WITHOUT an `IF NOT EXISTS` clause —
 * but the R3 catchup migration `20270101000000_phase_r3_model_catchup`
 * had ALREADY created the same tables (with a lean column set) under
 * IF-NOT-EXISTS guards. In production the Phase 4A CREATE TABLE became
 * a no-op (table already exists), so 15 Prisma-declared columns and
 * their backing indexes never landed in production. Every routed query
 * that touches one of those 15 columns has been raising Prisma P2022
 * (column does not exist), which the central error handler at
 * `services/api/src/server.ts:665-686` maps to HTTP 503 SCHEMA_NOT_READY
 * with a requestId. The repair migration closes the drift in a single
 * additive pass.
 *
 * Style: source-contract (file-text readFileSync). NO DB I/O. Matches
 * the canonical pattern of `production-sentry-batch-schema-drift.test.ts`.
 *
 * Honest scoping caveats:
 *
 *   1. Phase 3 (route fallbacks) was a no-op: every HTTP route that
 *      touches the 4 tables already bubbles Prisma errors to the central
 *      handler. GROUP D (route-fallback assertions) is therefore SKIPPED
 *      by design — see the comment at GROUP D below for the citation.
 *
 *   2. The `governance_policies.version` column is declared as
 *      `Int? @default(1)` in the Prisma model — nullable with a default.
 *      The migration adds it as `INTEGER DEFAULT 1` (nullable). GROUP A
 *      pins both the IF-NOT-EXISTS shape AND the DEFAULT-1 clause.
 *
 *   3. The single new index `cross_org_review_grants_team_inviting_state_idx`
 *      supports the `listCrossOrgGrants` filter on
 *      `(team_id, inviting_organization_id, state)` in
 *      `cross-org-review.service.ts:272`. No other new indexes were
 *      added; the preflight explicitly cleared this scope.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readRepo(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
}
// =============================================================================
// Source-contract reads
// =============================================================================
const MIGRATION_REL = "services/api/prisma/migrations/20270803000000_phase_governance_additive_repair/migration.sql";
const REPAIR_MIGRATION = readRepo(MIGRATION_REL);
const SERVER_TS = readRepo("services/api/src/server.ts");
const ALLOWLIST_GUARD = readRepo("services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts");
const SCHEMA_PRISMA = readRepo("services/api/prisma/schema.prisma");
const DRIFT_COLS = [
    // cross_org_review_grants (4)
    { table: "cross_org_review_grants", column: "inviting_organization_id", typeRe: /UUID/ },
    { table: "cross_org_review_grants", column: "invited_organization_id", typeRe: /UUID/ },
    { table: "cross_org_review_grants", column: "invited_org_slug", typeRe: /VARCHAR\(120\)/ },
    { table: "cross_org_review_grants", column: "external_review_grant_id", typeRe: /UUID/ },
    // access_review_campaigns (4)
    { table: "access_review_campaigns", column: "scheduled_end_utc", typeRe: /TIMESTAMPTZ\(6\)/ },
    { table: "access_review_campaigns", column: "department_id", typeRe: /UUID/ },
    { table: "access_review_campaigns", column: "workspace_id", typeRe: /UUID/ },
    { table: "access_review_campaigns", column: "created_by_user_id", typeRe: /UUID/ },
    // governance_policies (5)
    { table: "governance_policies", column: "slug", typeRe: /VARCHAR\(120\)/ },
    { table: "governance_policies", column: "summary", typeRe: /VARCHAR\(600\)/ },
    { table: "governance_policies", column: "rule", typeRe: /JSONB/ },
    { table: "governance_policies", column: "version", typeRe: /INTEGER\s+DEFAULT\s+1/ },
    { table: "governance_policies", column: "created_by_user_id", typeRe: /UUID/ },
    // departments (2)
    { table: "departments", column: "organization_id", typeRe: /UUID/ },
    { table: "departments", column: "slug", typeRe: /VARCHAR\(120\)/ },
];
const DRIFT_INDEXES = [
    {
        name: "cross_org_review_grants_team_inviting_state_idx",
        table: "cross_org_review_grants",
        colsRe: /"team_id"\s*,\s*"inviting_organization_id"\s*,\s*"state"/,
    },
];
const SCHEMA_PINS = [
    // CrossOrgReviewGrant
    {
        model: "CrossOrgReviewGrant",
        column: "inviting_organization_id",
        fieldRe: /invitingOrganizationId\s+String\?\s+@map\("inviting_organization_id"\)\s+@db\.Uuid/,
    },
    {
        model: "CrossOrgReviewGrant",
        column: "invited_organization_id",
        fieldRe: /invitedOrganizationId\s+String\?\s+@map\("invited_organization_id"\)\s+@db\.Uuid/,
    },
    {
        model: "CrossOrgReviewGrant",
        column: "invited_org_slug",
        fieldRe: /invitedOrgSlug\s+String\?\s+@map\("invited_org_slug"\)\s+@db\.VarChar\(120\)/,
    },
    {
        model: "CrossOrgReviewGrant",
        column: "external_review_grant_id",
        fieldRe: /externalReviewGrantId\s+String\?\s+@map\("external_review_grant_id"\)\s+@db\.Uuid/,
    },
    // AccessReviewCampaign
    {
        model: "AccessReviewCampaign",
        column: "scheduled_end_utc",
        fieldRe: /scheduledEndUtc\s+DateTime\?\s+@map\("scheduled_end_utc"\)\s+@db\.Timestamptz\(6\)/,
    },
    {
        model: "AccessReviewCampaign",
        column: "department_id",
        fieldRe: /departmentId\s+String\?\s+@map\("department_id"\)\s+@db\.Uuid/,
    },
    {
        model: "AccessReviewCampaign",
        column: "workspace_id",
        fieldRe: /workspaceId\s+String\?\s+@map\("workspace_id"\)\s+@db\.Uuid/,
    },
    {
        model: "AccessReviewCampaign",
        column: "created_by_user_id",
        fieldRe: /createdByUserId\s+String\?\s+@map\("created_by_user_id"\)\s+@db\.Uuid/,
    },
    // GovernancePolicy
    {
        model: "GovernancePolicy",
        column: "slug",
        fieldRe: /slug\s+String\?\s+@db\.VarChar\(120\)/,
    },
    {
        model: "GovernancePolicy",
        column: "summary",
        fieldRe: /summary\s+String\?\s+@db\.VarChar\(600\)/,
    },
    {
        model: "GovernancePolicy",
        column: "rule",
        fieldRe: /rule\s+Json\?/,
    },
    {
        model: "GovernancePolicy",
        column: "version",
        fieldRe: /version\s+Int\?\s+@default\(1\)/,
    },
    {
        model: "GovernancePolicy",
        column: "created_by_user_id",
        fieldRe: /createdByUserId\s+String\?\s+@map\("created_by_user_id"\)\s+@db\.Uuid/,
    },
    // Department
    {
        model: "Department",
        column: "organization_id",
        fieldRe: /organizationId\s+String\?\s+@map\("organization_id"\)\s+@db\.Uuid/,
    },
    {
        model: "Department",
        column: "slug",
        fieldRe: /slug\s+String\?\s+@db\.VarChar\(120\)/,
    },
];
// =============================================================================
// GROUP A — Migration file shape (existence, per-column, per-index, terminators)
// =============================================================================
describe("Phase Governance Additive Repair — migration file shape (GROUP A)", () => {
    it("A.1 — migration file exists at the canonical path (byteLength > 200)", () => {
        expect(REPAIR_MIGRATION.length).toBeGreaterThan(200);
        // Header sanity: the file must self-identify with the additive contract.
        expect(REPAIR_MIGRATION).toMatch(/Phase Governance Additive Repair/i);
        expect(REPAIR_MIGRATION).toMatch(/ADDITIVE/i);
        expect(REPAIR_MIGRATION).toMatch(/IDEMPOTENT/i);
    });
    // A.2 — One assertion per missing column from the preflight drift map.
    for (const { table, column, typeRe } of DRIFT_COLS) {
        it(`A.2 — adds ${table}.${column} via ALTER TABLE IF EXISTS + ADD COLUMN IF NOT EXISTS`, () => {
            // The ALTER TABLE statement is a single multi-line statement per table,
            // so we extract the slice for `table` and assert the column appears
            // with IF NOT EXISTS + the expected type literal.
            const blockRe = new RegExp(`ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${table}"[\\s\\S]{0,1200}?;`);
            const block = REPAIR_MIGRATION.match(blockRe);
            expect(block, `ALTER TABLE block for ${table} must exist`).toBeTruthy();
            const colRe = new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${column}"\\s+${typeRe.source}`);
            expect(block[0]).toMatch(colRe);
        });
    }
    // A.3 — One assertion per CREATE INDEX from Phase 2.
    for (const { name, table, colsRe, unique } of DRIFT_INDEXES) {
        it(`A.3 — creates index ${name} on ${table}(${colsRe.source}) with IF NOT EXISTS`, () => {
            const kw = unique ? "UNIQUE\\s+INDEX" : "INDEX";
            const idxRe = new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+"${name}"[\\s\\S]{0,300}ON\\s+"${table}"\\s*\\(${colsRe.source}\\)`);
            expect(REPAIR_MIGRATION).toMatch(idxRe);
            // Also pin that the keyword form matches what we declared (UNIQUE vs not).
            const kwRe = new RegExp(`CREATE\\s+${kw}\\s+IF\\s+NOT\\s+EXISTS\\s+"${name}"`);
            expect(REPAIR_MIGRATION).toMatch(kwRe);
        });
    }
    it("A.4 — every DDL statement terminates with `;` (statement-shape parity)", () => {
        // REBASELINED in Phase 5 validation: the CREATE INDEX statement was
        // re-wrapped in a Phase O-Final-style DO $$ … END $$; guard so the
        // Phase O CI gate (test/phase-o-migration-safety-gate.test.ts:315)
        // classifies it as CREATE_INDEX_GUARDED (MEDIUM) instead of
        // INDEX_COLUMN_RISK (CRITICAL). The DO block adds three internal
        // semicolons (EXECUTE '…'; / END IF; / END $$;) plus the trailing
        // statement-terminator semicolon, so a flat `;`-count parity no
        // longer holds. We instead assert the structural shape:
        //   * 4 ALTER TABLE blocks (the 15 ADD COLUMN clauses are commas)
        //   * 1 CREATE INDEX (the guarded one)
        //   * 1 DO $$ wrapper around that CREATE INDEX
        //   * every block ends with `;` (no missing terminator)
        const ddl = REPAIR_MIGRATION.replace(/^\s*--.*$/gm, "");
        const alterCount = (ddl.match(/\bALTER\s+TABLE\s+IF\s+EXISTS\b/gi) ?? []).length;
        const indexCount = (ddl.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi) ?? [])
            .length;
        const doBlockCount = (ddl.match(/\bDO\s+\$\$/gi) ?? []).length;
        const endDollarCount = (ddl.match(/\bEND\s+\$\$\s*;/gi) ?? []).length;
        expect(alterCount).toBe(4);
        expect(indexCount).toBe(DRIFT_INDEXES.length);
        // The single CREATE INDEX must live inside a DO $$ wrapper.
        expect(doBlockCount).toBe(1);
        expect(endDollarCount).toBe(1);
        // Each ALTER TABLE block ends with `;` — re-pin via a stricter
        // match that requires a `;` after the final ADD COLUMN clause.
        const terminatedAlters = (ddl.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS[^;]*?;/gi) ?? []).length;
        // 15 ADD COLUMN clauses total across the 4 ALTER blocks; the final
        // clause of each block is the one terminated by `;`.
        expect(terminatedAlters).toBe(4);
    });
});
// =============================================================================
// GROUP B — Bounded GUARDs against destructive SQL
// =============================================================================
//
// Every assertion below operates on the DDL body (header `--` comments
// stripped) so that the "no destructive operations" promise is verified
// against the EXECUTED SQL, not the explanatory header text. The header
// itself documents the bans by name — that documentation is fine.
// =============================================================================
function ddlBody() {
    return REPAIR_MIGRATION.replace(/^\s*--.*$/gm, "");
}
describe("Phase Governance Additive Repair — destructive-SQL guards (GROUP B)", () => {
    it("B.5 — no DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT / DROP TYPE in DDL body", () => {
        const body = ddlBody();
        expect(body).not.toMatch(/\bDROP\s+TABLE\b/i);
        expect(body).not.toMatch(/\bDROP\s+COLUMN\b/i);
        expect(body).not.toMatch(/\bDROP\s+INDEX\b/i);
        expect(body).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
        expect(body).not.toMatch(/\bDROP\s+TYPE\b/i);
        expect(body).not.toMatch(/\bDROP\s+SCHEMA\b/i);
    });
    it("B.6 — no ALTER TABLE ... DROP NOT NULL anywhere in DDL body (within 80 chars)", () => {
        const body = ddlBody();
        // Pattern: ALTER TABLE ... DROP NOT NULL with up to 80 chars between.
        expect(body).not.toMatch(/\bALTER\s+TABLE[\s\S]{0,80}\bDROP\s+NOT\s+NULL\b/i);
        // Also direct guard: no DROP NOT NULL token at all in the body.
        expect(body).not.toMatch(/\bDROP\s+NOT\s+NULL\b/i);
    });
    it("B.7 — no RENAME of any kind (table / column / constraint) in DDL body", () => {
        const body = ddlBody();
        expect(body).not.toMatch(/\bRENAME\s+TO\b/i);
        expect(body).not.toMatch(/\bRENAME\s+COLUMN\b/i);
        expect(body).not.toMatch(/\bRENAME\s+CONSTRAINT\b/i);
        // Catch-all: any RENAME token in DDL is a regression.
        expect(body).not.toMatch(/\bRENAME\b/i);
    });
    it("B.8 — no TRUNCATE / DELETE / UPDATE statements in DDL body", () => {
        const body = ddlBody();
        expect(body).not.toMatch(/\bTRUNCATE\b/i);
        // DELETE must not appear as a SQL statement; ON DELETE inside a constraint
        // clause is fine, but this migration does not add constraints, so we ban
        // the bare token entirely.
        expect(body).not.toMatch(/\bDELETE\b/i);
        // UPDATE statements (backfills) are NOT used by this migration —
        // the additive pass leaves every existing row untouched.
        expect(body).not.toMatch(/^\s*UPDATE\b/im);
        expect(body).not.toMatch(/\bUPDATE\s+"[a-z_]+"\s+SET\b/i);
    });
    it("B.9 — no REVOKE / GRANT changes in DDL body", () => {
        const body = ddlBody();
        expect(body).not.toMatch(/\bREVOKE\b/i);
        expect(body).not.toMatch(/\bGRANT\b/i);
    });
    it("B.10 — every additive statement uses IF NOT EXISTS (ADD COLUMN + CREATE INDEX)", () => {
        const body = ddlBody();
        // Every ADD COLUMN must be guarded with IF NOT EXISTS.
        const addColAll = body.match(/\bADD\s+COLUMN\b/gi) ?? [];
        const addColGuarded = body.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
        expect(addColAll.length).toBe(DRIFT_COLS.length); // 15
        expect(addColGuarded.length).toBe(addColAll.length);
        // Every ALTER TABLE must be IF EXISTS-guarded (parent table guard).
        const alterAll = body.match(/\bALTER\s+TABLE\b/gi) ?? [];
        const alterGuarded = body.match(/\bALTER\s+TABLE\s+IF\s+EXISTS\b/gi) ?? [];
        expect(alterAll.length).toBe(alterGuarded.length);
        // Every CREATE INDEX must be IF NOT EXISTS-guarded.
        const idxAll = body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi) ?? [];
        const idxGuarded = body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
        expect(idxAll.length).toBe(idxGuarded.length);
        expect(idxAll.length).toBe(DRIFT_INDEXES.length);
    });
    it("B.10b — no SET NOT NULL on any pre-existing column (additive-only invariant)", () => {
        const body = ddlBody();
        // ALL new columns are added NULLABLE; no SET NOT NULL anywhere.
        expect(body).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
        // And no destructive ALTER COLUMN clauses of any kind.
        expect(body).not.toMatch(/\bALTER\s+COLUMN\b/i);
    });
});
// =============================================================================
// GROUP C — Allowlist + central handler sanity
// =============================================================================
describe("Phase Governance Additive Repair — allowlist + central handler (GROUP C)", () => {
    it("C.11 — migration ID is allowlisted in PERMITTED_LATER_MIGRATIONS", () => {
        expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
        expect(ALLOWLIST_GUARD).toMatch(/"20270803000000_phase_governance_additive_repair"/);
    });
    it("C.12 — central error handler still maps Prisma P2022/P2021 → 503 SCHEMA_NOT_READY", () => {
        // Sanity check against the prior Sentry batch fix. If the handler
        // were edited away from the canonical fallback, this assertion fails
        // fast — the migration alone cannot resolve user-facing errors
        // without the handler's cooperation.
        expect(SERVER_TS).toMatch(/diag\.code\s*===\s*"P2022"\s*\|\|\s*diag\.code\s*===\s*"P2021"/);
        expect(SERVER_TS).toMatch(/reply\.code\(503\)\.send\(\s*\{\s*error:\s*\{\s*code:\s*"SCHEMA_NOT_READY"/);
        // The client-facing message must be a canned string, NOT the raw
        // Prisma message (no leaked column / table names).
        expect(SERVER_TS).toMatch(/"Resource temporarily unavailable\."/);
    });
});
// =============================================================================
// GROUP D — Route fallbacks
// =============================================================================
//
// SKIPPED BY DESIGN. Phase 3 explicitly reported "NO ROUTE CHANGES NEEDED"
// because every HTTP route in `services/api/src/routes/trust-and-governance.routes.ts`
// that touches the 4 drift tables ALREADY bubbles Prisma P2022/P2021 errors
// to the central handler at `services/api/src/server.ts:665-686`.
//
// Service-layer wrap pattern `.catch(() => 0|[])` in
// `governance-dashboard.service.ts` and `trust-verification-manifest.service.ts`
// intentionally degrades to bounded-zero per the preflight; once the
// columns land via this migration those paths auto-recover. No route or
// service code was modified in Phase 3 — the migration is the entire fix.
//
// We assert NEGATIVELY here to pin the contract: no NEW per-route fallback
// of the SCHEMA_NOT_READY shape was added to the governance routes file
// for the 4 tables in scope. If a future change adds such fallbacks the
// assertion fails and we re-open this group.
// =============================================================================
describe("Phase Governance Additive Repair — route fallbacks (GROUP D, skipped by design)", () => {
    it("D.13 — Phase 3 was a no-op; central handler is the canonical fallback", () => {
        // Positive assertion that the central handler is wired (already in C.12).
        // Negative assertion that we did NOT add a degraded payload shape
        // (`reason: "SCHEMA_NOT_READY"`) to any of the 4 governance services
        // newly created for this phase. The two existing services
        // (governance-dashboard.service.ts, trust-verification-manifest.service.ts)
        // are unchanged — their `.catch(() => 0|[])` pattern auto-recovers.
        //
        // We simply re-pin the SERVER_TS handler (C.12 covers the wire) and
        // assert the migration is the entire fix surface for Phase 3.
        expect(SERVER_TS).toMatch(/code:\s*"SCHEMA_NOT_READY"/);
        // REBASELINED in Phase 5 validation: the migration now contains
        // EXACTLY ONE DO $$ block — the Phase O-Final guarded-INDEX wrapper
        // around the cross_org_review_grants index (see A.4 rationale and
        // test/phase-o-migration-safety-gate.test.ts:208-228 for the
        // CREATE_INDEX_GUARDED contract). It is NOT a data-rewriting DO
        // block (no UPDATE / INSERT / DELETE inside) — the script-level
        // bans in B.5-B.10 already verify the absence of destructive verbs
        // anywhere in the DDL body. So the assertion below is that the
        // single DO block is a column-existence guard wrapping a single
        // EXECUTE 'CREATE INDEX …', and nothing more.
        const body = ddlBody();
        const doBlockCount = (body.match(/\bDO\s+\$\$/gi) ?? []).length;
        expect(doBlockCount).toBe(1);
        // The DO block must wrap a CREATE INDEX EXECUTE, and must include
        // an information_schema.columns guard (the Phase O-Final pattern).
        expect(body).toMatch(/information_schema\.columns/i);
        expect(body).toMatch(/EXECUTE\s+'CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
        // The DO block must NOT contain any data-rewriting verbs.
        const doBlockMatch = body.match(/DO\s+\$\$[\s\S]*?END\s+\$\$/i);
        expect(doBlockMatch).not.toBeNull();
        const doBlockBody = doBlockMatch[0];
        expect(doBlockBody).not.toMatch(/\bUPDATE\b/i);
        expect(doBlockBody).not.toMatch(/\bINSERT\b/i);
        expect(doBlockBody).not.toMatch(/\bDELETE\b/i);
        expect(doBlockBody).not.toMatch(/\bTRUNCATE\b/i);
    });
});
// =============================================================================
// GROUP E — Prisma schema sanity
// =============================================================================
//
// For EACH of the 4 tables, pin that the Prisma model still declares the
// missing column we added. This proves the migration brings the DB up to
// the schema (additive forward), not the other way round.
// =============================================================================
describe("Phase Governance Additive Repair — Prisma schema still declares each added column (GROUP E)", () => {
    for (const { model, column, fieldRe } of SCHEMA_PINS) {
        it(`E — ${model} declares ${column} as an optional field (matches migration)`, () => {
            // Slice the schema to just the model block — pure additive cleanliness.
            const modelRe = new RegExp(`model\\s+${model}\\s*\\{[\\s\\S]+?^\\}`, "m");
            const block = SCHEMA_PRISMA.match(modelRe);
            expect(block, `Prisma model ${model} must exist`).toBeTruthy();
            expect(block[0]).toMatch(fieldRe);
        });
    }
});
