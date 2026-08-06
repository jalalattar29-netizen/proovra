/**
 * PHASE 12 POINT 4 — every database object has exactly ONE owner.
 *
 * Before this correction the repository had two incomplete schema authorities:
 * hand-written migrations knew about 16 tables and 24 columns that
 * `schema.prisma` did not declare, and runtime raw SQL depended on them. The
 * schema comparison therefore proposed DROPPING live tables, and a
 * destructive-diff guard was the only thing standing between that proposal and
 * production. A guard that prevents damage is not the same as an owner.
 *
 * Ownership is now explicit:
 *
 *   PRISMA_MANAGED   — the datamodel owns table/column EXISTENCE. 13 tables and
 *                      19 columns were added to schema.prisma; the comparison
 *                      now proposes removing nothing.
 *   MIGRATION_MANAGED_RAW_SQL — index names, extra indexes, foreign keys,
 *                      defaults and native type detail that hand-written
 *                      migrations own. Registered in
 *                      `docs/architecture/raw-schema-ownership.json` and
 *                      VERIFIED (not filtered) by `scripts/raw-schema-verify.mjs`.
 *   EXTENSION_MANAGED — the pgvector column, created only when the extension
 *                      installs.
 *   LEGACY_REMOVE    — 3 superseded singular tables and 5 duplicate columns,
 *                      removed by the guarded forward-only migration
 *                      20271117000000_point4_schema_authority_contract (the Release-A repair half
 *                      is 20271112000000_point4_write_unblock_repair).
 *
 * These tests are static: they pin the manifest's completeness and the
 * verifier's semantics. The live proof (fresh PostgreSQL 16, four positive
 * controls) runs via `pnpm db:raw-schema-verify`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(API_ROOT, "..", "..");
const MANIFEST_PATH = resolve(REPO, "docs/architecture/raw-schema-ownership.json");
const SCHEMA = readFileSync(resolve(API_ROOT, "prisma/schema.prisma"), "utf8");
// PHASE 12 POINT 6 — the convergence migration was SPLIT so a single SQL file
// no longer straddles two release waves. The non-destructive half (relaxing
// the orphaned NOT NULL duplicates so the three broken `create()` paths work
// again, plus the security_events.severity convergence) is Release A; the
// physical removal is Release D.
const REPAIR_MIGRATION = resolve(
  API_ROOT,
  "prisma/migrations/20271112000000_point4_write_unblock_repair/migration.sql",
);
const MIGRATION = resolve(
  API_ROOT,
  "prisma/migrations/20271117000000_point4_schema_authority_contract/migration.sql",
);

type Manifest = {
  invariants: { tablesProposedForRemoval: number; columnsProposedForRemoval: number };
  categories: Record<string, { ownership: string; reason: string }>;
  extensions: Array<{
    name: string;
    owningMigration: string;
    runtimeBehaviourWhenAbsent: string;
    ownedObjects: string[];
  }>;
  categoryCounts: Record<string, number>;
  totalRegisteredObjects: number;
  objects: Array<{ table: string; sign: string; object: string; category: string }>;
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

/** The 13 tables brought under the datamodel, by physical name. */
const NOW_DECLARED_TABLES = [
  "evidence_ocr_text",
  "evidence_part_derived_assets",
  "evidence_part_exif_summaries",
  "evidence_transcript_segments",
  "evidence_upload_session_parts",
  "evidence_upload_sessions",
  "external_review_grants",
  "investigation_graph_edges",
  "investigation_graph_nodes",
  "manual_relationships",
  "media_intelligence_runs",
  "media_intelligence_signals",
  "search_audit_logs",
];

/** The 3 superseded singular tables the new migration drops. */
const LEGACY_TABLES = [
  "governance_policy_audit",
  "redaction_activity",
  "redaction_policy_audit",
];

/** The 5 duplicate columns the new migration drops, with their canonical twin. */
const DUPLICATE_COLUMNS: Array<[string, string, string]> = [
  ["cross_org_review_grants", "created_by_user_id", "granted_by_user_id"],
  ["delegated_admin_grants", "grantee_user_id", "granted_to_user_id"],
  ["redaction_policy_assignments", "policy_version_id", "version_id"],
  ["redaction_policy_assignments", "revoked_at_utc", "revoked_at"],
  ["redaction_policy_versions", "published_at_utc", "published_at"],
];

describe("Phase 12 Point 4 — schema ownership is single and explicit", () => {
  it("every previously-undeclared LIVE table is now declared in the datamodel", () => {
    const missing = NOW_DECLARED_TABLES.filter(
      (t) => !new RegExp(`@@map\\("${t}"\\)`).test(SCHEMA),
    );
    expect(
      missing.sort(),
      `tables still missing from schema.prisma:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("the datamodel owns EXISTENCE — the manifest records zero removal proposals", () => {
    expect(manifest.invariants.tablesProposedForRemoval).toBe(0);
    expect(manifest.invariants.columnsProposedForRemoval).toBe(0);
  });

  it("every registered object carries a terminal ownership class (UnclassifiedDatabaseObjects = 0)", () => {
    const unclassified = manifest.objects.filter(
      (o) => !o.category || o.category === "OTHER" || o.category === "UNKNOWN",
    );
    expect(
      unclassified,
      `objects with no terminal ownership:\n${unclassified
        .map((o) => `${o.table} ${o.object}`)
        .join("\n")}`,
    ).toEqual([]);
    for (const [name, meta] of Object.entries(manifest.categories)) {
      if (name === "OTHER") continue;
      expect(
        ["MIGRATION_MANAGED_RAW_SQL", "EXTENSION_MANAGED", "PRISMA_MANAGED"],
        `category ${name}`,
      ).toContain(meta.ownership);
      expect(meta.reason.length, `category ${name} needs a reason`).toBeGreaterThan(20);
    }
    // The counts must actually add up to the recorded total.
    const sum = Object.entries(manifest.categoryCounts)
      .filter(([k]) => k !== "OTHER")
      .reduce((a, [, n]) => a + n, 0);
    expect(sum).toBe(manifest.totalRegisteredObjects);
    expect(manifest.objects.length).toBe(manifest.totalRegisteredObjects);
  });

  it("no raw-manifest entry duplicates a table/column the datamodel owns", () => {
    // Existence-class entries would mean two authorities for the same thing.
    const existence = manifest.objects.filter((o) =>
      /^(Removed column|Added table|Removed tables)/.test(o.object),
    );
    expect(existence, "manifest must not claim ownership of existence").toEqual([]);
  });

  it("the pgvector extension is registered with its honest degraded behaviour", () => {
    const vector = manifest.extensions.find((e) => e.name === "vector");
    expect(vector).toBeTruthy();
    expect(vector!.owningMigration).toMatch(/phase15_semantic_search/);
    expect(vector!.runtimeBehaviourWhenAbsent).toMatch(/keyword-only/i);
    expect(vector!.ownedObjects.join(" ")).toMatch(/embedding_vector/);
  });

  it("the verifier VERIFIES rather than filters, and refuses to guess a target", () => {
    const src = readFileSync(resolve(API_ROOT, "scripts/raw-schema-verify.mjs"), "utf8");
    // Both directions.
    expect(src).toMatch(/REGISTERED raw-schema object\(s\) are gone or mutated/);
    expect(src).toMatch(/UNREGISTERED schema divergence/);
    // Existence is a hard failure independent of the manifest.
    expect(src).toMatch(/the datamodel no longer owns object existence/);
    // No silent default target.
    expect(src).toMatch(/never guesses/);
    expect(src).toMatch(/REFUSING an explicit target on a non-local host/);
  });

  it("the contract migration is guarded, forward-only, and destroys nothing ambiguous", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const sql = readFileSync(MIGRATION, "utf8");
    // Every duplicate column and its canonical twin is named in the guard's
    // driving table, so no pair can be dropped without a divergence check.
    for (const [table, dup, canonical] of DUPLICATE_COLUMNS) {
      expect(sql, `${table}.${dup} pair`).toContain(`'${table}'`);
      expect(sql, `${table}.${dup} pair`).toContain(`'${dup}'`);
      expect(sql, `${table}.${dup} pair`).toContain(`'${canonical}'`);
    }
    // The divergence test must be NULL-tolerant: a duplicate that is NULL
    // holds no data, so it cannot be "divergent" from a populated canonical.
    // Without this the guard raises on every healthy row written after the
    // Release-A repair relaxed the NOT NULL, and the contract could never run.
    expect(sql).toMatch(/IS NOT NULL AND %I IS DISTINCT FROM %I/);
    // Legacy tables are dropped only when empty.
    for (const t of LEGACY_TABLES) expect(sql).toContain(`'${t}'`);
    expect(sql).toMatch(/REFUSING to drop superseded table[\s\S]*?still holds/);
    // No unguarded destructive statement: every DROP is issued through the
    // guarded dynamic form inside a DO block.
    expect(sql).not.toMatch(/^\s*DROP TABLE (?!%I)/m);
    expect(sql).not.toMatch(/^\s*ALTER TABLE .*DROP COLUMN/m);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it("the Release-A repair unblocks the broken create() paths without dropping anything", () => {
    expect(existsSync(REPAIR_MIGRATION)).toBe(true);
    const sql = readFileSync(REPAIR_MIGRATION, "utf8");
    // The three NOT NULL orphans that make delegatedAdminGrant.create,
    // crossOrgReviewGrant.create and redactionPolicyAssignment.create fail.
    for (const [table, dup] of [
      ["cross_org_review_grants", "created_by_user_id"],
      ["delegated_admin_grants", "grantee_user_id"],
      ["redaction_policy_assignments", "policy_version_id"],
    ]) {
      expect(sql, `${table}.${dup}`).toContain(`'${table}'`);
      expect(sql, `${table}.${dup}`).toContain(`'${dup}'`);
    }
    expect(sql).toMatch(/DROP NOT NULL/);
    // Release A must contain NO destructive statement at all.
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).not.toMatch(/DROP TABLE/);
  });

  it("nothing in the runtime reads the removed legacy tables or duplicate columns", () => {
    // A resurrection guard: the singular tables and duplicate columns must not
    // come back as runtime references.
    const roots = ["services/api/src", "services/worker/src", "packages/shared-runtime/src"];
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    for (const r of roots) walk(resolve(REPO, r));
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      for (const t of LEGACY_TABLES) {
        // Only a SQL reference counts. The identifier also appears inside
        // documentation strings (the trust-center federator lists subsystem
        // names in prose), which is not a read.
        if (new RegExp(`(FROM|JOIN|INTO|UPDATE|TABLE)\\s+"?${t}"?(?![a-z_])`, "i").test(code)) {
          offenders.push(`${f.slice(REPO.length + 1)} -> ${t}`);
        }
      }
      for (const [table, dup] of DUPLICATE_COLUMNS) {
        // A column name is only meaningful next to ITS table: `created_by_user_id`
        // and `revoked_at_utc` are ordinary column names on other tables
        // (investigation_graph_*, external_review_grants) and those are fine.
        if (!code.includes(table)) continue;
        if (new RegExp(`["'\`]${dup}["'\`]`).test(code)) {
          offenders.push(`${f.slice(REPO.length + 1)} -> ${table}.${dup}`);
        }
      }
    }
    expect(
      offenders.sort(),
      `runtime references to removed objects:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the duplicate columns are gone from the datamodel's field maps", () => {
    // Scoped to the OWNING model: `created_by_user_id` and `revoked_at_utc` are
    // legitimate physical columns on other tables, so a global search would be
    // a false positive.
    const MODEL_OF: Record<string, string> = {
      cross_org_review_grants: "CrossOrgReviewGrant",
      delegated_admin_grants: "DelegatedAdminGrant",
      redaction_policy_assignments: "RedactionPolicyAssignment",
      redaction_policy_versions: "RedactionPolicyVersion",
    };
    for (const [table, dup, canonical] of DUPLICATE_COLUMNS) {
      const model = MODEL_OF[table]!;
      const start = SCHEMA.indexOf(`model ${model} {`);
      expect(start, `model ${model} must exist`).toBeGreaterThan(-1);
      const body = SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
      expect(body, `${model} must not @map the duplicate ${dup}`).not.toContain(
        `@map("${dup}")`,
      );
      expect(body, `${model} must @map the canonical ${canonical}`).toContain(
        `@map("${canonical}")`,
      );
    }
  });
});
