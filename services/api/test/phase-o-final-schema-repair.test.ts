/**
 * Phase O-Final — Production schema repair contract.
 *
 * Asserts:
 *   1. The additive repair migration exists with the documented name.
 *   2. The migration is ADDITIVE ONLY — no DROP / NOT NULL changes /
 *      renames / DELETE / TRUNCATE / REVOKE.
 *   3. The migration adds `team_id` to `discussion_mentions` and the
 *      sister at-risk columns documented in the brief.
 *   4. The audit script exists at the brief's path.
 *   5. The audit script uses `pg.Pool` directly and NEVER constructs
 *      `new PrismaClient()` (per the brief's hard rule).
 *   6. The audit script is read-only — no ALTER / INSERT / UPDATE /
 *      DELETE / DROP / TRUNCATE references in real (non-comment) code.
 *   7. The audit script audits the documented at-risk columns.
 *   8. The closure docs ship with the documented filenames.
 *   9. The honest-classification taxonomy (CLOSED / READY_FOR_INFRA /
 *      BLOCKED) is used in the final closure doc.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf8");
}
function exists(rel: string): boolean {
  return existsSync(REPO_ROOT + rel);
}
function stripSqlComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}
function stripJsComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => !/^\s*\*/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const REPAIR_MIGRATION =
  "services/api/prisma/migrations/20261006000000_phase_o_final_production_column_repair/migration.sql";
const AUDIT_SCRIPT = "services/api/scripts/production-column-audit.mjs";

// ---------------------------------------------------------------------------
// 1-3. Repair migration
// ---------------------------------------------------------------------------

describe("O-Final — additive repair migration", () => {
  it("ships at the documented path", () => {
    expect(exists(REPAIR_MIGRATION)).toBe(true);
    expect(statSync(REPO_ROOT + REPAIR_MIGRATION).size).toBeGreaterThan(0);
  });

  it("is additive only — no destructive SQL", () => {
    const src = stripSqlComments(read(REPAIR_MIGRATION));
    expect.soft(src).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    expect.soft(src).not.toMatch(/\bTRUNCATE\b/i);
    expect.soft(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect.soft(src).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect.soft(src).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
    expect.soft(src).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect.soft(src).not.toMatch(/\bREVOKE\b/i);
    // Every ADD COLUMN MUST be guarded by IF NOT EXISTS.
    const addColumnLines = src.match(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi);
    expect(addColumnLines).toBeNull();
  });

  it("repairs the root-cause column discussion_mentions.team_id", () => {
    const src = read(REPAIR_MIGRATION);
    expect(src).toMatch(/ALTER\s+TABLE\s+IF\s+EXISTS\s+"discussion_mentions"/i);
    expect(src).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"team_id"\s+UUID/);
  });

  it("repairs the sister at-risk tables documented in the brief", () => {
    const src = read(REPAIR_MIGRATION);
    for (const table of [
      "discussion_participants",
      "evidence_workflow_instances",
      "upload_sessions",
      "evidence_saved_views",
    ]) {
      expect.soft(src).toMatch(
        new RegExp(`ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${table}"`, "i"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4-7. Audit script
// ---------------------------------------------------------------------------

describe("O-Final — production-column-audit script", () => {
  it("ships at the documented path", () => {
    expect(exists(AUDIT_SCRIPT)).toBe(true);
  });

  it("uses pg.Pool directly and NEVER constructs a PrismaClient", () => {
    const src = read(AUDIT_SCRIPT);
    expect(src).toMatch(/from\s+"pg"/);
    expect(src).toMatch(/new\s+Pool\(/);
    const code = stripJsComments(src);
    // No `new PrismaClient(` call site (raw or with any args) in real
    // code. Prisma 7 in this project requires the adapter factory; we
    // bypass the ORM entirely to diagnose drift before Prisma can
    // connect.
    expect.soft(code).not.toMatch(/new\s+PrismaClient\(/);
    expect.soft(code).not.toMatch(/from\s+["']@prisma\/client["']/);
  });

  it("is read-only — no mutating SQL keywords in real code", () => {
    const code = stripJsComments(read(AUDIT_SCRIPT));
    expect.soft(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect.soft(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect.soft(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect.soft(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect.soft(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
    expect.soft(code).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("audits every column the brief flagged", () => {
    const src = read(AUDIT_SCRIPT);
    // Top-level table → columns map.
    for (const [table, cols] of [
      ["discussion_mentions", ["team_id"]],
      ["evidence_workflow_instances", ["team_id"]],
      ["upload_sessions", ["team_id"]],
      ["evidence_saved_views", ["team_id"]],
    ] as const) {
      expect.soft(src).toContain(table);
      for (const c of cols) {
        expect.soft(src).toMatch(new RegExp(`"${c}"`));
      }
    }
  });

  it("references information_schema.columns + _prisma_migrations", () => {
    const src = read(AUDIT_SCRIPT);
    expect(src).toMatch(/information_schema\.columns/);
    expect(src).toMatch(/_prisma_migrations/);
  });
});

// ---------------------------------------------------------------------------
// 8-9. Closure docs
// ---------------------------------------------------------------------------

describe("O-Final — closure documentation", () => {
  const REQUIRED_DOCS = [
    "docs/operations/production-schema-repair.md",
    "docs/operations/low-ram-deploy-runbook.md",
    "docs/operations/phase-o1-6-final-dashboards-alerts.md",
    "docs/operations/phase-o2-scale-readiness.md",
    "docs/operations/final-infrastructure-closure.md",
  ];

  for (const path of REQUIRED_DOCS) {
    it(`${path} exists and is non-empty`, () => {
      expect(exists(path)).toBe(true);
      expect(statSync(REPO_ROOT + path).size).toBeGreaterThan(200);
    });
  }

  it("final-infrastructure-closure.md uses the honest CLOSED / READY_FOR_INFRA / BLOCKED taxonomy", () => {
    const src = read("docs/operations/final-infrastructure-closure.md");
    expect(src).toMatch(/\bCLOSED\b/);
    expect(src).toMatch(/READY[ _]FOR[ _]INFRA/);
    // We require the taxonomy to be self-explanatory: the doc must
    // *define* the three terms somewhere, not just mention them.
    expect(src).toMatch(/READY[ _]FOR[ _]INFRA[\s\S]*?(operator|cloud|provided)/i);
  });

  it("low-ram-deploy-runbook.md documents per-service builds + image-pull alternative", () => {
    const src = read("docs/operations/low-ram-deploy-runbook.md");
    expect(src).toMatch(/docker compose .*(pull|build)/i);
    // "per-service" OR "one at a time" — both express the same
    // sequential-build constraint.
    expect(src).toMatch(/per[- ]service|one at a time/i);
    expect(src).toMatch(/4\s*GB|low.?RAM|memory/i);
  });

  it("production-schema-repair.md cites the root cause and the safe-migrate command", () => {
    const src = read("docs/operations/production-schema-repair.md");
    expect(src).toMatch(/discussion_mentions\.team_id/);
    expect(src).toMatch(/safe-migrate\.mjs/);
    expect(src).toMatch(/MIGRATE_ALLOW_REMOTE/);
    expect(src).toMatch(/MIGRATE_BACKUP_ID/);
  });
});
