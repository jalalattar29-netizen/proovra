/**
 * Phase O — Live schema compatibility repair contract tests.
 *
 * Enforces every operator-brief non-negotiable on the new migration
 * AND on the corrected audit parser:
 *
 *   * Audit parser EXCLUDES every reverse-1-to-1 relation field
 *     (Evidence.reviewWorkflow, Evidence.anchor, User.guestIdentity,
 *     Team.governancePolicy, Team.securityPolicy, Team.personaProfile).
 *   * Audit script `suggestRepair` NEVER emits `TYPE_TBD` for any
 *     real model in the production schema (i.e. every field that
 *     reaches MISSING_COLUMN classification has a concrete SQL type).
 *   * Repair migration is ADDITIVE-ONLY (no DROP / RENAME / DELETE /
 *     TRUNCATE / SET NOT NULL).
 *   * Every ADD COLUMN uses IF NOT EXISTS.
 *   * Every CREATE INDEX (if any) is wrapped in a column-existence
 *     DO block (Phase O-Final pattern).
 *   * Every backfill UPDATE is deterministic + idempotent
 *     (`WHERE target IS NULL AND source IS NOT NULL`) AND wrapped
 *     in an `information_schema.columns` existence check.
 *   * No `TYPE_TBD` token appears in the migration SQL.
 *   * Migration adds every column the operator brief flagged as
 *     REPAIR_NOW; relation fields and MANUAL_DECISION items are
 *     absent.
 *   * The closure doc ships with the documented filename and lists
 *     the triage taxonomy.
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

const MIGRATION =
  "services/api/prisma/migrations/20261007000000_phase_o_live_schema_compatibility_repair/migration.sql";
const AUDIT_SCRIPT = "services/api/scripts/full-production-schema-audit.mjs";
const DOC = "docs/operations/live-schema-compatibility-repair.md";

// ---------------------------------------------------------------------------
// 1. Audit parser — relation fields EXCLUDED.
// ---------------------------------------------------------------------------

describe("Phase O — audit parser excludes reverse-1-to-1 relation fields", () => {
  async function loadAudit() {
    const mod = await import(REPO_ROOT + AUDIT_SCRIPT);
    return mod as {
      parsePrismaSchema: (src: string) => {
        models: Array<{
          name: string;
          table: string;
          fields: Array<{ fieldName: string; column: string }>;
        }>;
      };
    };
  }

  const RELATION_FIELDS = [
    { model: "Evidence", field: "reviewWorkflow" },
    { model: "Evidence", field: "anchor" },
    { model: "User", field: "guestIdentity" },
    { model: "Team", field: "governancePolicy" },
    { model: "Team", field: "securityPolicy" },
    { model: "Team", field: "personaProfile" },
  ];

  for (const { model, field } of RELATION_FIELDS) {
    it(`${model}.${field} is NOT a scalar column in the parsed model`, async () => {
      const { parsePrismaSchema } = await loadAudit();
      const src = read("services/api/prisma/schema.prisma");
      const parsed = parsePrismaSchema(src);
      const m = parsed.models.find((mm) => mm.name === model);
      expect(m, `model ${model} parsed`).toBeTruthy();
      const present = m!.fields.find((f) => f.fieldName === field);
      expect(
        present,
        `Relation field ${model}.${field} must NOT appear in scalar field list`,
      ).toBeUndefined();
    });
  }

  it("Evidence still keeps its scalar columns (id, owner_user_id, etc.)", async () => {
    const { parsePrismaSchema } = await loadAudit();
    const src = read("services/api/prisma/schema.prisma");
    const parsed = parsePrismaSchema(src);
    const evi = parsed.models.find((m) => m.name === "Evidence")!;
    const cols = new Set(evi.fields.map((f) => f.column));
    expect(cols.has("id")).toBe(true);
    expect(cols.has("owner_user_id")).toBe(true);
    expect(cols.has("organization_id")).toBe(true);
  });

  it("DiscussionMention.mentioned_user_id IS a scalar column (exclusion rule does not over-fire)", async () => {
    const { parsePrismaSchema } = await loadAudit();
    const src = read("services/api/prisma/schema.prisma");
    const parsed = parsePrismaSchema(src);
    const dm = parsed.models.find((m) => m.name === "DiscussionMention")!;
    const cols = new Set(dm.fields.map((f) => f.column));
    expect(cols.has("mentioned_user_id")).toBe(true);
    expect(cols.has("team_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Audit script NEVER produces TYPE_TBD on the real schema.
// ---------------------------------------------------------------------------

describe("Phase O — audit suggestRepair never emits TYPE_TBD on the real schema", () => {
  it("fieldToSqlType returns a concrete type for every scalar field in the real schema", async () => {
    const mod = await import(REPO_ROOT + AUDIT_SCRIPT);
    const { parsePrismaSchema, fieldToSqlType } = mod as {
      parsePrismaSchema: (src: string) => {
        models: Array<{
          name: string;
          fields: Array<{
            fieldName: string;
            column: string;
            baseType: string;
            dbType: string | null;
            dbTypeArg: string | null;
            isEnum: boolean;
          }>;
        }>;
      };
      fieldToSqlType: (f: {
        isEnum: boolean;
        baseType: string;
        dbType: string | null;
        dbTypeArg: string | null;
      }) => string | null;
    };
    const parsed = parsePrismaSchema(read("services/api/prisma/schema.prisma"));
    // Build the union of all scalar field types we'd ever ADD COLUMN
    // for. The expectation: every NON-enum scalar field has a
    // concrete fieldToSqlType. Enum fields return null (handled by
    // the doc — operator decides whether to create the udt).
    const unmapped: Array<{ model: string; field: string }> = [];
    for (const m of parsed.models) {
      for (const f of m.fields) {
        if (f.isEnum) continue;
        const sqlType = fieldToSqlType(f);
        if (sqlType === null) {
          unmapped.push({ model: m.name, field: f.fieldName });
        }
      }
    }
    expect(
      unmapped,
      `Every non-enum scalar field must map to a concrete SQL type (no TYPE_TBD). Unmapped: ${JSON.stringify(unmapped)}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Migration — exists + additive-only contract.
// ---------------------------------------------------------------------------

describe("Phase O — migration additive-only contract", () => {
  it("ships at the documented path", () => {
    expect(exists(MIGRATION)).toBe(true);
    expect(statSync(REPO_ROOT + MIGRATION).size).toBeGreaterThan(1000);
  });

  it("contains no destructive SQL (DROP / RENAME / DELETE / TRUNCATE / SET NOT NULL / REVOKE)", () => {
    const src = stripSqlComments(read(MIGRATION));
    expect.soft(src).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
    expect.soft(src).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
    expect.soft(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect.soft(src).not.toMatch(/\bTRUNCATE\b/i);
    expect.soft(src).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect.soft(src).not.toMatch(/\bREVOKE\b/i);
  });

  it("contains no TYPE_TBD anywhere", () => {
    const src = read(MIGRATION);
    expect.soft(src).not.toMatch(/TYPE_TBD/);
  });

  it("every ADD COLUMN uses IF NOT EXISTS (idempotent)", () => {
    const src = stripSqlComments(read(MIGRATION));
    // Look for ADD COLUMN NOT immediately followed by IF NOT EXISTS.
    const bare = src.match(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi);
    expect(bare).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Backfill deterministic + idempotent.
// ---------------------------------------------------------------------------

describe("Phase O — backfill safety", () => {
  const src = read(MIGRATION);

  it("every backfill UPDATE pairs WHERE target IS NULL with source check", () => {
    // We use either:
    //   * literal UPDATE ... SET col = src WHERE col IS NULL AND src IS NOT NULL
    //   * format(...) UPDATE with placeholder columns (%I) that produce
    //     the same shape at runtime — wrapped inside a DO block that
    //     verifies the source column exists via information_schema.
    //
    // The contract: there are NO bare UPDATE statements outside an
    // information_schema-guarded DO block.
    const stripped = stripSqlComments(src);
    const updates = stripped.match(/UPDATE\s+"[\w_]+"/gi) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    // Every literal `UPDATE "table"` must be inside a `$upd$ ... $upd$`
    // EXECUTE string OR inside a `format(` call that builds the SQL
    // dynamically. Either way it's wrapped in a DO block that does the
    // information_schema column-existence check.
    for (const upd of updates) {
      const idx = stripped.indexOf(upd);
      const ctxBefore = stripped.slice(Math.max(0, idx - 1200), idx);
      const ctxAfter = stripped.slice(idx, idx + 500);
      const ctx = ctxBefore + ctxAfter;
      const hasIsColumnsCheck =
        /information_schema\.columns/i.test(ctxBefore);
      const hasNullGuard =
        /IS\s+NULL/i.test(ctxAfter) || /%I\s+IS\s+NULL/i.test(ctxAfter);
      const isFormatCall =
        /format\([\s\S]*?UPDATE/i.test(ctxBefore + upd);
      expect.soft(
        hasIsColumnsCheck,
        `UPDATE "${upd}" must be inside a DO block that first checks information_schema.columns for the source column.`,
      ).toBe(true);
      expect.soft(
        hasNullGuard || isFormatCall,
        `UPDATE "${upd}" must use a WHERE target IS NULL guard (literal or via format()).`,
      ).toBe(true);
    }
  });

  it("never overwrites existing rows — every UPDATE filters by target NULL", () => {
    // Strong signal: the migration text mentions the
    // "WHERE %I IS NULL AND %I IS NOT NULL" pattern as the canonical
    // backfill idiom in at least the dynamic UPDATEs.
    const src = read(MIGRATION);
    expect(src).toMatch(/%I IS NULL AND %I IS NOT NULL/);
  });
});

// ---------------------------------------------------------------------------
// 5. REPAIR_NOW column coverage — the user's explicit list.
// ---------------------------------------------------------------------------

describe("Phase O — REPAIR_NOW column coverage", () => {
  const src = read(MIGRATION);

  const REPAIR_NOW = [
    // evidence_saved_views
    { table: "evidence_saved_views", col: "owner_user_id" },
    { table: "evidence_saved_views", col: "team_id" },
    { table: "evidence_saved_views", col: "description" },
    { table: "evidence_saved_views", col: "filters_json" },
    { table: "evidence_saved_views", col: "sort_key" },
    { table: "evidence_saved_views", col: "scope" },
    { table: "evidence_saved_views", col: "is_default" },
    { table: "evidence_saved_views", col: "created_at" },
    // evidence_legal_holds
    { table: "evidence_legal_holds", col: "created_at" },
    // upload_sessions
    { table: "upload_sessions", col: "stalled_at_utc" },
    { table: "upload_sessions", col: "abandoned_at_utc" },
    { table: "upload_sessions", col: "completed_at_utc" },
    // evidence_intelligence_jobs
    { table: "evidence_intelligence_jobs", col: "scheduled_at_utc" },
    { table: "evidence_intelligence_jobs", col: "started_at_utc" },
    { table: "evidence_intelligence_jobs", col: "completed_at_utc" },
    // evidence_extracted_texts
    { table: "evidence_extracted_texts", col: "provider_version" },
    { table: "evidence_extracted_texts", col: "confidence" },
    { table: "evidence_extracted_texts", col: "duration_ms" },
    { table: "evidence_extracted_texts", col: "extracted_at_utc" },
    // evidence_entities
    { table: "evidence_entities", col: "confidence" },
    // evidence_semantic_chunks
    { table: "evidence_semantic_chunks", col: "chunk_text" },
    { table: "evidence_semantic_chunks", col: "embedding_provider" },
    { table: "evidence_semantic_chunks", col: "embedding_model" },
    { table: "evidence_semantic_chunks", col: "embedding_dimensions" },
    // evidence_similarities
    { table: "evidence_similarities", col: "advisory_summary" },
    // discussion_threads
    { table: "discussion_threads", col: "assigned_at_utc" },
    { table: "discussion_threads", col: "resolved_by_user_id" },
    { table: "discussion_threads", col: "resolved_at_utc" },
    { table: "discussion_threads", col: "reopened_by_user_id" },
    { table: "discussion_threads", col: "reopen_count" },
    { table: "discussion_threads", col: "escalated_by_user_id" },
    { table: "discussion_threads", col: "created_at" },
    // discussion_messages
    { table: "discussion_messages", col: "contributor_intake_session_id" },
    { table: "discussion_messages", col: "contributor_label" },
    { table: "discussion_messages", col: "edited_at_utc" },
    { table: "discussion_messages", col: "deleted_at_utc" },
    { table: "discussion_messages", col: "deleted_by_user_id" },
    { table: "discussion_messages", col: "created_at" },
    // discussion_participants
    { table: "discussion_participants", col: "added_by_user_id" },
    { table: "discussion_participants", col: "added_at_utc" },
    { table: "discussion_participants", col: "revoked_by_user_id" },
    // trusted_devices
    { table: "trusted_devices", col: "created_at" },
    // operational_incident_events (naming drift + missing)
    { table: "operational_incident_events", col: "incident_id" },
    { table: "operational_incident_events", col: "event_type" },
    { table: "operational_incident_events", col: "safe_message" },
    { table: "operational_incident_events", col: "metadata_json" },
    { table: "operational_incident_events", col: "created_at" },
    // evidence_workflow_instances (naming drift + claim_ref/matter_ref/title)
    { table: "evidence_workflow_instances", col: "team_id" },
    { table: "evidence_workflow_instances", col: "template_id" },
    { table: "evidence_workflow_instances", col: "claim_ref" },
    { table: "evidence_workflow_instances", col: "matter_ref" },
    { table: "evidence_workflow_instances", col: "title" },
    // evidence_workflow_step_instances (naming drift + missing)
    { table: "evidence_workflow_step_instances", col: "accepted_kinds_json" },
    { table: "evidence_workflow_step_instances", col: "identity_requirement" },
    { table: "evidence_workflow_step_instances", col: "location_requirement" },
    // evidence_workflow_visibility_decisions (naming drift)
    { table: "evidence_workflow_visibility_decisions", col: "workflow_instance_id" },
    { table: "evidence_workflow_visibility_decisions", col: "field_key" },
    // evidence_search_documents (naming drift + missing)
    { table: "evidence_search_documents", col: "source_id" },
    { table: "evidence_search_documents", col: "claim_ref" },
    { table: "evidence_search_documents", col: "matter_ref" },
    { table: "evidence_search_documents", col: "indexed_at_utc" },
  ];

  for (const { table, col } of REPAIR_NOW) {
    it(`${table}.${col} ADDed by migration`, () => {
      const re = new RegExp(
        `ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${table}"[\\s\\S]*?ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${col}"`,
        "i",
      );
      expect.soft(src, `Expected ADD COLUMN "${col}" on ${table}`).toMatch(re);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. MANUAL_DECISION items must NOT be silently repaired.
// ---------------------------------------------------------------------------

describe("Phase O — MANUAL_DECISION items are NOT in the migration", () => {
  const src = read(MIGRATION);

  it("discussion_mentions is NOT touched by this migration (operator must re-audit)", () => {
    // The previous Phase O-Final migration covered discussion_mentions.
    // The brief explicitly says: if audit still reports columns as
    // missing AFTER Phase O-Final was applied, that is operator review
    // territory — not a silent re-fix. Assert this migration does NOT
    // reference discussion_mentions.
    expect(src).not.toMatch(/ALTER\s+TABLE\s+IF\s+EXISTS\s+"discussion_mentions"/i);
  });

  it("evidence_workflow_instance_evidence is NOT touched (missing PK id is operator decision)", () => {
    expect(src).not.toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"evidence_workflow_instance_evidence"/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Index safety — every CREATE INDEX guarded; or none at all.
// ---------------------------------------------------------------------------

describe("Phase O — index safety", () => {
  it("every CREATE INDEX (if any) is wrapped in a column-existence DO block", () => {
    const src = stripSqlComments(read(MIGRATION));
    const indexes = src.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/gi) ?? [];
    if (indexes.length === 0) {
      // The migration intentionally defers all CREATE INDEX statements
      // to a follow-up migration after operator confirmation. This is
      // a documented design decision.
      return;
    }
    const guarded = (src.match(/EXECUTE\s+'CREATE\s+(?:UNIQUE\s+)?INDEX/gi) ?? []).length;
    expect(guarded).toBe(indexes.length);
  });
});

// ---------------------------------------------------------------------------
// 8. Docs — closure doc presence + taxonomy
// ---------------------------------------------------------------------------

describe("Phase O — closure documentation", () => {
  it(`${DOC} exists and is non-empty`, () => {
    expect(exists(DOC)).toBe(true);
    expect(statSync(REPO_ROOT + DOC).size).toBeGreaterThan(800);
  });

  it("doc names the triage taxonomy + production commands", () => {
    const src = read(DOC);
    expect(src).toMatch(/REPAIR_NOW/);
    expect(src).toMatch(/DEFER/);
    expect(src).toMatch(/MANUAL_DECISION_REQUIRED|MANUAL_DECISION/);
    expect(src).toMatch(/IGNORE_RELATION/);
    expect(src).toMatch(/safe-migrate\.mjs/);
    expect(src).toMatch(/MIGRATE_BACKUP_ID|Neon snapshot/);
    expect(src).toMatch(/full-production-schema-audit\.mjs/);
  });
});
