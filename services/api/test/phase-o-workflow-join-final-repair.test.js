/**
 * Phase O — Final workflow join-table repair contract.
 *
 * Asserts the migration closes EXACTLY the 5 remaining CRITICAL
 * findings on `evidence_workflow_instance_evidence`:
 *
 *   1. MISSING_COLUMN  id uuid
 *   2. NAMING_DRIFT    workflowInstanceId → workflow_instance_id
 *   3. NAMING_DRIFT    evidenceId         → evidence_id
 *   4. MISSING_COLUMN  step_instance_id uuid
 *   5. NAMING_DRIFT    createdAt          → created_at
 *
 * And that NO destructive SQL ships in this migration.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel) {
    return readFileSync(REPO_ROOT + rel, "utf8");
}
function exists(rel) {
    return existsSync(REPO_ROOT + rel);
}
function stripSqlComments(src) {
    return src
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
}
const MIGRATION = "services/api/prisma/migrations/20261008000000_phase_o_workflow_join_table_final_repair/migration.sql";
// ---------------------------------------------------------------------------
// 1. Existence + additive-only contract
// ---------------------------------------------------------------------------
describe("Phase O — workflow join-table final repair: contract", () => {
    it("ships at the documented path", () => {
        expect(exists(MIGRATION)).toBe(true);
        expect(statSync(REPO_ROOT + MIGRATION).size).toBeGreaterThan(500);
    });
    it("contains no destructive SQL", () => {
        const src = stripSqlComments(read(MIGRATION));
        expect.soft(src).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
        expect.soft(src).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
        expect.soft(src).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect.soft(src).not.toMatch(/\bTRUNCATE\b/i);
        expect.soft(src).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
        expect.soft(src).not.toMatch(/\bREVOKE\b/i);
    });
    it("contains no TYPE_TBD", () => {
        expect(read(MIGRATION)).not.toMatch(/TYPE_TBD/);
    });
    it("does NOT add a PRIMARY KEY in this phase", () => {
        const src = stripSqlComments(read(MIGRATION));
        expect.soft(src).not.toMatch(/\bADD\s+CONSTRAINT[\s\S]{0,200}PRIMARY\s+KEY\b/i);
        expect.soft(src).not.toMatch(/\bADD\s+PRIMARY\s+KEY\b/i);
    });
    it("does NOT add a UNIQUE constraint or unique index in this phase", () => {
        // The Prisma model declares `@@unique([workflowInstanceId, evidenceId])`,
        // but production may carry duplicate rows from the legacy camelCase
        // shape. Adding the unique index would error mid-migration.
        const src = stripSqlComments(read(MIGRATION));
        expect.soft(src).not.toMatch(/\bCREATE\s+UNIQUE\s+INDEX\b/i);
        expect.soft(src).not.toMatch(/\bADD\s+CONSTRAINT[\s\S]{0,200}UNIQUE\b/i);
    });
    it("every ADD COLUMN uses IF NOT EXISTS", () => {
        const bare = stripSqlComments(read(MIGRATION)).match(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi);
        expect(bare).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// 2. Closes EXACTLY the 5 CRITICAL findings
// ---------------------------------------------------------------------------
describe("Phase O — workflow join-table final repair: 5-finding coverage", () => {
    const src = read(MIGRATION);
    it("adds id UUID (nullable, with DEFAULT gen_random_uuid)", () => {
        expect(src).toMatch(/ALTER\s+TABLE\s+IF\s+EXISTS\s+"evidence_workflow_instance_evidence"[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"id"\s+UUID/i);
        expect(src).toMatch(/ALTER\s+COLUMN\s+"id"\s+SET\s+DEFAULT\s+gen_random_uuid\(\)/i);
    });
    it("adds workflow_instance_id UUID and backfills from workflowInstanceId", () => {
        expect(src).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"workflow_instance_id"\s+UUID/);
        expect(src).toMatch(/column_name\s*=\s*'workflowInstanceId'/);
        expect(src).toMatch(/SET\s+"workflow_instance_id"\s*=\s*"workflowInstanceId"/);
    });
    it("adds evidence_id UUID and backfills from evidenceId", () => {
        expect(src).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"evidence_id"\s+UUID/);
        expect(src).toMatch(/column_name\s*=\s*'evidenceId'/);
        expect(src).toMatch(/SET\s+"evidence_id"\s*=\s*"evidenceId"/);
    });
    it("adds step_instance_id UUID (no backfill — no source column)", () => {
        expect(src).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"step_instance_id"\s+UUID/);
        // No backfill block for step_instance_id; it's optional in Prisma.
        expect(src).not.toMatch(/SET\s+"step_instance_id"\s*=/);
    });
    it("adds created_at TIMESTAMPTZ(6) and backfills from createdAt", () => {
        expect(src).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"created_at"\s+TIMESTAMPTZ\(6\)/);
        expect(src).toMatch(/column_name\s*=\s*'createdAt'/);
        expect(src).toMatch(/SET\s+"created_at"\s*=\s*"createdAt"/);
        expect(src).toMatch(/ALTER\s+COLUMN\s+"created_at"\s+SET\s+DEFAULT\s+NOW\(\)/i);
    });
    it("backfills id with gen_random_uuid() only where id is NULL", () => {
        expect(src).toMatch(/SET\s+"id"\s*=\s*gen_random_uuid\(\)[\s\S]*?WHERE\s+"id"\s+IS\s+NULL/i);
    });
});
// ---------------------------------------------------------------------------
// 3. Backfill safety — every UPDATE is in a guarded DO block
// ---------------------------------------------------------------------------
describe("Phase O — workflow join-table final repair: backfill safety", () => {
    const src = read(MIGRATION);
    const stripped = stripSqlComments(src);
    it("every UPDATE on the join table is inside an EXECUTE inside a DO block", () => {
        const updates = stripped.match(/UPDATE\s+"evidence_workflow_instance_evidence"/gi) ?? [];
        expect(updates.length).toBeGreaterThanOrEqual(4); // id, workflow_instance_id, evidence_id, created_at
        const executeUpdates = (stripped.match(/EXECUTE\s+\$upd\$[\s\S]*?UPDATE\s+"evidence_workflow_instance_evidence"[\s\S]*?\$upd\$/gi) ?? []).length;
        expect(executeUpdates).toBe(updates.length);
    });
    it("every camelCase→snake_case backfill DO block checks BOTH source and target columns exist", () => {
        // Each backfill block uses a paired `column_name='<src>'` and
        // `column_name='<dst>'` check in the same DO block.
        for (const [src_col, dst_col] of [
            ["workflowInstanceId", "workflow_instance_id"],
            ["evidenceId", "evidence_id"],
            ["createdAt", "created_at"],
        ]) {
            const re = new RegExp(`column_name\\s*=\\s*'${src_col}'[\\s\\S]*?column_name\\s*=\\s*'${dst_col}'`, "i");
            expect.soft(stripped, `paired existence check for ${src_col} ↔ ${dst_col}`).toMatch(re);
        }
    });
    it("backfills are idempotent — only fill rows where target is still NULL", () => {
        // For the id backfill:
        expect(stripped).toMatch(/SET\s+"id"\s*=\s*gen_random_uuid\(\)[\s\S]*?WHERE\s+"id"\s+IS\s+NULL/i);
        // For the camelCase→snake_case backfills:
        for (const dst of ["workflow_instance_id", "evidence_id", "created_at"]) {
            const re = new RegExp(`WHERE\\s+"${dst}"\\s+IS\\s+NULL\\s+AND\\s+"[A-Za-z]+"\\s+IS\\s+NOT\\s+NULL`, "i");
            expect.soft(stripped, `idempotent backfill for ${dst}`).toMatch(re);
        }
    });
});
// ---------------------------------------------------------------------------
// 4. Index safety — only non-unique guarded indexes
// ---------------------------------------------------------------------------
describe("Phase O — workflow join-table final repair: index safety", () => {
    const src = read(MIGRATION);
    const stripped = stripSqlComments(src);
    it("every CREATE INDEX is wrapped in a column-existence DO block", () => {
        const createIndexes = stripped.match(/CREATE\s+INDEX/gi) ?? [];
        expect(createIndexes.length).toBeGreaterThan(0);
        const executeIndexes = (stripped.match(/EXECUTE\s+'CREATE\s+INDEX/gi) ?? []).length;
        expect(executeIndexes).toBe(createIndexes.length);
    });
    it("indexes reference only columns this migration ADDs", () => {
        // Parse every CREATE INDEX and assert the referenced column is
        // one we ADD COLUMN'd in this migration.
        const addedCols = new Set();
        for (const m of stripped.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"(\w+)"/g)) {
            addedCols.add(m[1]);
        }
        for (const m of stripped.matchAll(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"[\w_]+"\s+ON\s+"[\w_]+"\s+\(([^)]+)\)/gi)) {
            const cols = m[1]
                .split(",")
                .map((c) => c.trim().replace(/^"|"$/g, "").replace(/\s+(ASC|DESC).*$/i, ""));
            for (const c of cols) {
                expect.soft(addedCols.has(c), `Index references column "${c}" not added by this migration`).toBe(true);
            }
        }
    });
});
// ---------------------------------------------------------------------------
// 5. The Phase O migration-safety gate continues to bless this migration
//    (zero CRITICAL findings).
// ---------------------------------------------------------------------------
describe("Phase O — workflow join-table final repair: passes the migration safety gate", () => {
    it("audit findings on this migration have zero CRITICAL", async () => {
        const audit = (await import(REPO_ROOT + "services/api/scripts/full-migration-audit.mjs"));
        const sql = read(MIGRATION);
        const { findings } = audit.detectFindings(sql);
        const crit = findings.filter((f) => f.risk === "CRITICAL");
        expect(crit, `Migration must have zero CRITICAL findings.`).toEqual([]);
    });
});
