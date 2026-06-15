/**
 * Indexer-error surface — regression test for the production
 * "every row failed with reason='upsert_failed'" incident.
 *
 * Before the fix, `evidence-indexing.service.ts` caught every
 * Prisma exception and returned `{ ok: false, reason: "upsert_failed" }`,
 * collapsing the actual NOT NULL / type-mismatch into a single opaque
 * string. Production reported `evidence_search_documents = 0` against
 * `active_evidence = 144` with the operator unable to read the column
 * name from the failure.
 *
 * These tests pin:
 *
 *   1. `extractPrismaErrorDetail` returns code + meta + message
 *      from a `PrismaClientKnownRequestError`-shaped object.
 *   2. The indexers return those fields on `{ ok: false }` instead
 *      of collapsing to "upsert_failed".
 *   3. `runWorkspaceReindex` logs prismaCode + prismaMeta when
 *      forwarding a failed indexer result.
 *   4. The drift-repair migration exists and DROPs NOT NULL on every
 *      legacy camelCase column (idempotent + scoped to
 *      evidence_search_documents).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractPrismaErrorDetail } from "../src/services/search/evidence-indexing.service.js";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("extractPrismaErrorDetail — Prisma error pass-through", () => {
  it("returns code/meta/message for a PrismaClientKnownRequestError-shaped object", () => {
    const fake = {
      code: "P2011",
      meta: {
        constraint: "evidence_search_documents_teamId_not_null",
        modelName: "EvidenceSearchDocument",
        target: "teamId",
      },
      message:
        'Invalid `prisma.evidenceSearchDocument.create()` invocation:\n\nNull constraint violation on the fields: (`teamId`)',
    };
    const out = extractPrismaErrorDetail(fake);
    expect(out.prismaCode).toBe("P2011");
    expect(out.prismaMeta).toEqual(fake.meta);
    expect(out.prismaMessage).toContain("Null constraint violation");
  });

  it("returns empty object for null/undefined", () => {
    expect(extractPrismaErrorDetail(null)).toEqual({});
    expect(extractPrismaErrorDetail(undefined)).toEqual({});
  });

  it("handles non-Prisma errors gracefully (no code, just message)", () => {
    const e = new Error("network down");
    const out = extractPrismaErrorDetail(e);
    expect(out.prismaCode).toBeUndefined();
    expect(out.prismaMeta).toBeUndefined();
    expect(out.prismaMessage).toBe("network down");
  });

  it("truncates a long message to ≤500 chars (anti-log-flood)", () => {
    const longMsg = "x".repeat(2000);
    const out = extractPrismaErrorDetail(new Error(longMsg));
    expect(out.prismaMessage?.length).toBeLessThanOrEqual(500);
  });
});

describe("Indexer service files — swallow is removed", () => {
  const EVIDENCE = resolve(
    API_ROOT,
    "src/services/search/evidence-indexing.service.ts",
  );
  const CASE = resolve(
    API_ROOT,
    "src/services/search/case-indexing.service.ts",
  );
  const ARTIFACT = resolve(
    API_ROOT,
    "src/services/search/artifact-indexing.service.ts",
  );

  it("evidence-indexing returns prismaCode/prismaMeta/prismaMessage on upsert failure", () => {
    const src = read(EVIDENCE);
    // The IndexResult type must declare the structured-error fields.
    expect(src).toMatch(/prismaCode\??:\s*string/);
    expect(src).toMatch(/prismaMeta\??:\s*Record<string, unknown>/);
    expect(src).toMatch(/prismaMessage\??:\s*string/);
    // The upsert catch block must call extractPrismaErrorDetail
    // and pass its output into the ok:false return.
    expect(src).toMatch(/extractPrismaErrorDetail\(err\)/);
    // Pin that the function exists and is exported (other indexers
    // import it).
    expect(src).toMatch(/export function extractPrismaErrorDetail/);
  });

  it("case-indexing surfaces prismaCode/prismaMeta/prismaMessage on upsert failure", () => {
    const src = read(CASE);
    expect(src).toMatch(/extractPrismaErrorDetail/);
    expect(src).toMatch(/prismaCode\??:\s*string/);
    expect(src).toMatch(/prismaMeta\??:\s*Record<string, unknown>/);
    expect(src).toMatch(/prismaMessage\??:\s*string/);
  });

  it("artifact-indexing surfaces prismaCode/prismaMeta/prismaMessage on upsert failure", () => {
    const src = read(ARTIFACT);
    expect(src).toMatch(/extractPrismaErrorDetail/);
    expect(src).toMatch(/prismaCode\??:\s*string/);
    expect(src).toMatch(/prismaMeta\??:\s*Record<string, unknown>/);
    expect(src).toMatch(/prismaMessage\??:\s*string/);
  });
});

describe("runWorkspaceReindex — logs Prisma details on failure", () => {
  const SERVICE = resolve(API_ROOT, "src/services/search/reindex.service.ts");
  const src = read(SERVICE);

  it("forwards prismaCode/prismaMeta/prismaMessage to the warn logger for every source-type", () => {
    // Each of the five `log.warn(...)` failure sites must include
    // prismaCode / prismaMeta / prismaMessage in the log payload,
    // not just the collapsed `reason`. Pin five separate matches.
    const sites = [
      "search.reindex.evidence.failed",
      "search.reindex.case.failed",
      "search.reindex.report.failed",
      "search.reindex.package.failed",
      "search.reindex.note.failed",
    ];
    for (const tag of sites) {
      const idx = src.indexOf(tag);
      expect(idx, `tag missing: ${tag}`).toBeGreaterThan(-1);
      // The structured payload is rendered above the tag; grab the
      // 600-char window preceding the tag for matching.
      const window = src.slice(Math.max(0, idx - 600), idx);
      expect(window, `prismaCode missing for ${tag}`).toMatch(/prismaCode/);
      expect(window, `prismaMeta missing for ${tag}`).toMatch(/prismaMeta/);
      expect(window, `prismaMessage missing for ${tag}`).toMatch(/prismaMessage/);
    }
  });
});

describe("Drift-repair migration — legacy camelCase DROP NOT NULL", () => {
  const MIGRATION_PATH = resolve(
    API_ROOT,
    "prisma/migrations/20270821000000_phase_search_evidence_search_documents_legacy_drop_not_null/migration.sql",
  );

  it("the migration file exists", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("the migration scopes DROP NOT NULL to evidence_search_documents only", () => {
    const sql = read(MIGRATION_PATH);
    // Must operate on exactly one table.
    expect(sql).toMatch(/evidence_search_documents/);
    // Anti-regression: no other table name should appear as a
    // DROP-NOT-NULL target — pin a few foreign tables.
    expect(sql).not.toMatch(/ALTER TABLE\s+"evidence"\s/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"cases"\s/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"reports"\s/);
  });

  it("the migration is idempotent (information_schema.columns gate)", () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/is_nullable\s*=\s*'NO'/);
    expect(sql).toMatch(/DROP NOT NULL/);
  });

  it("the migration NEVER touches the canonical snake_case write targets", () => {
    const sql = read(MIGRATION_PATH);
    // The whitelist of camelCase legacy columns must NOT contain the
    // snake_case names. Pin by their exact string.
    const dangerousSnake = [
      "'team_id'",
      "'document_type'",
      "'source_id'",
      "'searchable_text'",
      "'source_updated_at_utc'",
      "'created_at'",
    ];
    for (const c of dangerousSnake) {
      expect(sql, `must not target snake_case ${c}`).not.toContain(c);
    }
  });

  it("the migration covers every camelCase column the Prisma model writes", () => {
    const sql = read(MIGRATION_PATH);
    // Pin the canonical set the production schema is suspected to
    // still carry as NOT NULL. Source: the prior
    // 20261007000000_phase_o_live_schema_compatibility_repair
    // migration's cam_to_snake map.
    const required = [
      "teamId",
      "documentType",
      "sourceId",
      "title",
      "subtitle",
      "summary",
      "searchableText",
      "searchableMetadataJson",
      "searchableTagsJson",
      "visibilityScopeJson",
      "governanceScopeJson",
      "reviewState",
      "workflowState",
      "exportState",
      "retentionState",
      "legalHoldState",
      "contributorScoped",
      "reviewerRestricted",
      "evidenceId",
      "workflowInstanceId",
      "workflowStepInstanceId",
      "caseId",
      "claimRef",
      "matterRef",
      "sourceUpdatedAtUtc",
      "indexedAtUtc",
      "createdAt",
      "updatedAt",
    ];
    for (const c of required) {
      expect(sql, `legacy column missing from whitelist: ${c}`).toContain(
        `'${c}'`,
      );
    }
  });
});
