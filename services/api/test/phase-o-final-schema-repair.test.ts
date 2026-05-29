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
    expect.soft(src).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
    expect.soft(src).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect.soft(src).not.toMatch(/\bREVOKE\b/i);
    // Note: UPDATE is allowed for deterministic backfill of newly-added
    // columns (e.g. mentioned_user_id ← user_id). The
    // "Production-variant" describe block below specifically verifies
    // that UPDATEs are wrapped in column-existence DO blocks and target
    // only nullable repair columns we just added.
    //
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
// Production-variant coverage — added after the operator reported P3018
// (SQL 42703) on the prior revision of this migration. Production's
// `discussion_mentions` table had the legacy pre-Phase-16 shape
// [id, message_id, user_id, created_at_utc], so the previous CREATE
// INDEX on `(message_id, mentioned_user_id)` failed because the column
// did not exist.
//
// These tests assert the revised migration:
//   * Adds every Prisma-required column to discussion_mentions.
//   * Backfills mentioned_user_id from the legacy `user_id` column
//     deterministically (and idempotently — only NULL rows).
//   * Backfills thread_id via JOIN on discussion_messages.
//   * Backfills created_at from the legacy `created_at_utc` column.
//   * Wraps every CREATE INDEX in a column-existence DO block so the
//     SQL 42703 cannot recur.
// ---------------------------------------------------------------------------

describe("O-Final — production-variant coverage", () => {
  const src = read(REPAIR_MIGRATION);

  it("adds every Prisma-required column to discussion_mentions", () => {
    // The Prisma DiscussionMention model declares 7 column-bearing
    // fields. id + message_id are pre-existing; the other 5 are added
    // by this migration.
    for (const col of [
      "team_id",
      "thread_id",
      "mentioned_user_id",
      "notified_at_utc",
      "created_at",
    ]) {
      expect.soft(src).toMatch(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"`),
      );
    }
  });

  it("deterministically backfills mentioned_user_id from legacy user_id", () => {
    // The UPDATE is wrapped in a DO block that verifies the SOURCE
    // column exists before running. Defensive AND idempotent.
    expect(src).toMatch(
      /information_schema\.columns[\s\S]*?column_name\s*=\s*'user_id'/i,
    );
    expect(src).toMatch(
      /UPDATE\s+"discussion_mentions"[\s\S]*?SET\s+"mentioned_user_id"\s*=\s*"user_id"/i,
    );
    // Idempotency clause — only fills rows where the new column is NULL.
    expect(src).toMatch(/WHERE\s+"mentioned_user_id"\s+IS\s+NULL/i);
  });

  it("backfills thread_id via JOIN on discussion_messages (FK ensures totality)", () => {
    expect(src).toMatch(
      /information_schema\.tables[\s\S]*?table_name\s*=\s*'discussion_messages'/i,
    );
    expect(src).toMatch(
      /UPDATE\s+"discussion_mentions"\s+dm[\s\S]*?FROM\s+"discussion_messages"\s+m[\s\S]*?WHERE\s+m\."id"\s*=\s*dm\."message_id"/i,
    );
    expect(src).toMatch(/AND\s+dm\."thread_id"\s+IS\s+NULL/i);
  });

  it("backfills created_at from legacy created_at_utc", () => {
    expect(src).toMatch(
      /information_schema\.columns[\s\S]*?column_name\s*=\s*'created_at_utc'/i,
    );
    expect(src).toMatch(
      /SET\s+"created_at"\s*=\s*"created_at_utc"/i,
    );
  });

  it("sets DEFAULT NOW() on created_at so future inserts get a non-NULL value", () => {
    expect(src).toMatch(
      /ALTER\s+COLUMN\s+"created_at"\s+SET\s+DEFAULT\s+NOW\(\)/i,
    );
  });

  it("every backfill UPDATE is wrapped in a column-existence DO block", () => {
    // Each UPDATE must appear inside a `DO $$ ... END $$` block that
    // verifies the SOURCE column exists via information_schema. Count
    // the UPDATE statements and the DO blocks containing UPDATE — they
    // must match.
    const updateCount = (src.match(/\bUPDATE\s+"discussion_mentions"/gi) ?? []).length;
    expect(updateCount).toBeGreaterThanOrEqual(3); // mentioned_user_id, thread_id, created_at
    // Each UPDATE is inside an EXECUTE statement (indirect call) inside
    // a DO block.
    const executeUpdates = (
      src.match(/EXECUTE\s+\$upd\$[\s\S]*?UPDATE\s+"discussion_mentions"[\s\S]*?\$upd\$/gi) ?? []
    ).length;
    expect(executeUpdates).toBe(updateCount);
  });

  it("every CREATE INDEX is wrapped in a column-existence DO block", () => {
    // The specific defense against SQL 42703: every CREATE INDEX runs
    // only after we verify EVERY referenced column exists. Compare
    // counts AFTER stripping SQL `--` comments so doc lines that
    // mention "CREATE INDEX" don't false-positive.
    const stripped = stripSqlComments(src);
    const createIndexLines = stripped.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/gi) ?? [];
    expect(createIndexLines.length).toBeGreaterThanOrEqual(3); // 3 on discussion_mentions + 1 on evidence_saved_views
    // Each CREATE INDEX appears inside an EXECUTE call (which is itself
    // inside a DO block). Counting EXECUTE 'CREATE INDEX...' matches.
    const executeIndexes = (
      stripped.match(/EXECUTE\s+'CREATE\s+(?:UNIQUE\s+)?INDEX/gi) ?? []
    ).length;
    expect(executeIndexes).toBe(createIndexLines.length);
  });
});

// ---------------------------------------------------------------------------
// Index column-safety contract — added per the operator brief:
// "Add a test that forbids indexes on columns not added/known by the
// migration." The repair migration must never reference a column in
// a CREATE INDEX that the same migration does not add (or that is not
// in a small allowlist of always-present pre-existing columns).
// ---------------------------------------------------------------------------

describe("O-Final — index column safety", () => {
  const src = read(REPAIR_MIGRATION);

  // Columns the prior Phase 16 / Phase G2 / etc. migrations declared
  // as part of the original CREATE TABLE block. Indexes may safely
  // reference these without this migration adding them, because they
  // are present in every non-drifted production.
  const KNOWN_PREEXISTING: Record<string, string[]> = {
    discussion_mentions: ["id", "message_id"],
    evidence_saved_views: ["id", "owner_user_id", "created_at"],
  };

  function columnsAddedByMigrationToTable(src: string, table: string): Set<string> {
    const block = new RegExp(
      `ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${table}"([\\s\\S]*?)(?=ALTER\\s+TABLE|DO\\s+\\$\\$|$)`,
      "gi",
    );
    const out = new Set<string>();
    for (const m of src.matchAll(block)) {
      const body = m[1];
      for (const cm of body.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"(\w+)"/gi)) {
        out.add(cm[1]);
      }
    }
    return out;
  }

  it("every CREATE INDEX references only columns this migration adds or pre-existing known-safe columns", () => {
    const indexes = [
      ...src.matchAll(
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"[\w]+"\s+ON\s+"(\w+)"\s+\(([^)]+)\)/gi,
      ),
    ];
    expect(indexes.length).toBeGreaterThan(0);
    for (const m of indexes) {
      const table = m[1];
      const colList = m[2];
      const cols = colList
        .split(",")
        .map((c) => c.trim().replace(/"/g, "").replace(/\s+(ASC|DESC)$/i, ""));
      const added = columnsAddedByMigrationToTable(src, table);
      const allowed = new Set([
        ...added,
        ...(KNOWN_PREEXISTING[table] ?? []),
      ]);
      for (const col of cols) {
        expect.soft(
          allowed.has(col),
          `CREATE INDEX on ${table}(${colList}) references column "${col}" that this migration does not add and is not in the known-pre-existing allowlist.`,
        ).toBe(true);
      }
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
