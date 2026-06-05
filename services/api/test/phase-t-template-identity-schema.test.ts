/**
 * Phase T — Canonical template-identity schema contract.
 *
 * Asserts the additive nullable migration that establishes the canonical
 * template-identity trio on Evidence and EvidenceReviewWorkflow:
 *
 *   1. The migration ships at the documented path and is non-empty.
 *   2. The Prisma schema declares the trio on both models, nullable,
 *      with the correct VarChar(120) / Int / Uuid types.
 *   3. The Prisma schema declares both FK relations to
 *      EvidenceWorkflowTemplate with onDelete: SetNull and distinct
 *      relation names per model.
 *   4. The Prisma schema declares back-relations on EvidenceWorkflowTemplate.
 *   5. The migration adds ALL six columns via ADD COLUMN IF NOT EXISTS
 *      and contains no NOT NULL, no DROP, no cascade, no defaults, no
 *      backfill.
 *   6. The migration's two FK clauses use ON DELETE SET NULL.
 *   7. The migration adds the two non-unique indexes on
 *      (team_id, template_slug).
 *   8. The generated Prisma client types expose the new fields on
 *      both models (compile-time check via type-level assertions).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const MIGRATION_REL =
  "services/api/prisma/migrations/20270816000000_phase_t_template_identity_columns/migration.sql";
const SCHEMA_REL = "services/api/prisma/schema.prisma";

// ---------------------------------------------------------------------------
// 1. Migration exists at the documented path.
// ---------------------------------------------------------------------------

describe("Phase T — migration shipping", () => {
  it("ships at the documented timestamp path", () => {
    expect(exists(MIGRATION_REL)).toBe(true);
    expect(statSync(REPO_ROOT + MIGRATION_REL).size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2-4. Prisma schema declarations.
// ---------------------------------------------------------------------------

describe("Phase T — Prisma schema declarations", () => {
  const schema = read(SCHEMA_REL);

  // The Evidence model is the first model declaration in the schema
  // (the audit confirmed lines 9-261). Extract its body for assertions
  // that must not match across model boundaries.
  function extractModel(name: string): string {
    const re = new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
    const match = schema.match(re);
    if (!match) throw new Error(`model ${name} not found`);
    return match[1];
  }

  const evidenceBody = extractModel("Evidence");
  const reviewWorkflowBody = extractModel("EvidenceReviewWorkflow");
  const templateBody = extractModel("EvidenceWorkflowTemplate");

  it("Evidence carries templateSlug VarChar(120) NULLABLE", () => {
    expect(evidenceBody).toMatch(
      /templateSlug\s+String\?\s+@map\("template_slug"\)\s+@db\.VarChar\(120\)/,
    );
  });

  it("Evidence carries templateVersion Int NULLABLE", () => {
    expect(evidenceBody).toMatch(
      /templateVersion\s+Int\?\s+@map\("template_version"\)/,
    );
  });

  it("Evidence carries templateDbId Uuid NULLABLE", () => {
    expect(evidenceBody).toMatch(
      /templateDbId\s+String\?\s+@map\("template_db_id"\)\s+@db\.Uuid/,
    );
  });

  it("Evidence declares the EvidenceTemplate relation with onDelete: SetNull", () => {
    expect(evidenceBody).toMatch(
      /template\s+EvidenceWorkflowTemplate\?\s+@relation\("EvidenceTemplate",\s*fields:\s*\[templateDbId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/,
    );
  });

  it("Evidence declares the per-workspace template index", () => {
    expect(evidenceBody).toMatch(/@@index\(\[teamId,\s*templateSlug\]\)/);
  });

  it("EvidenceReviewWorkflow carries templateSlug VarChar(120) NULLABLE", () => {
    expect(reviewWorkflowBody).toMatch(
      /templateSlug\s+String\?\s+@map\("template_slug"\)\s+@db\.VarChar\(120\)/,
    );
  });

  it("EvidenceReviewWorkflow carries templateVersion Int NULLABLE", () => {
    expect(reviewWorkflowBody).toMatch(
      /templateVersion\s+Int\?\s+@map\("template_version"\)/,
    );
  });

  it("EvidenceReviewWorkflow carries templateDbId Uuid NULLABLE", () => {
    expect(reviewWorkflowBody).toMatch(
      /templateDbId\s+String\?\s+@map\("template_db_id"\)\s+@db\.Uuid/,
    );
  });

  it("EvidenceReviewWorkflow declares the ReviewWorkflowTemplate relation with onDelete: SetNull", () => {
    expect(reviewWorkflowBody).toMatch(
      /template\s+EvidenceWorkflowTemplate\?\s+@relation\("ReviewWorkflowTemplate",\s*fields:\s*\[templateDbId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/,
    );
  });

  it("EvidenceReviewWorkflow declares the per-workspace template index", () => {
    expect(reviewWorkflowBody).toMatch(/@@index\(\[teamId,\s*templateSlug\]\)/);
  });

  it("EvidenceWorkflowTemplate declares both back-relations with distinct names", () => {
    expect(templateBody).toMatch(
      /evidences\s+Evidence\[\]\s+@relation\("EvidenceTemplate"\)/,
    );
    expect(templateBody).toMatch(
      /reviewerWorkflows\s+EvidenceReviewWorkflow\[\]\s+@relation\("ReviewWorkflowTemplate"\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5-7. Migration SQL contract.
// ---------------------------------------------------------------------------

describe("Phase T — migration SQL contract", () => {
  const raw = read(MIGRATION_REL);
  const src = stripSqlComments(raw);

  // No destructive or NOT-NULL operations.
  it("is additive only — no destructive DDL", () => {
    expect.soft(src).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    expect.soft(src).not.toMatch(/\bTRUNCATE\b/i);
    expect.soft(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect.soft(src).not.toMatch(/\bRENAME\s+(TABLE|COLUMN|TO)\b/i);
    expect.soft(src).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    expect.soft(src).not.toMatch(/\bNOT\s+NULL\b/i);
    expect.soft(src).not.toMatch(/\bREVOKE\b/i);
    // No CASCADE on the FK (we use SET NULL deliberately).
    expect.soft(src).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    // No DEFAULT clauses on the new columns — the migration must not
    // rewrite the table on Postgres 11+.
    expect
      .soft(src.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"[^"]+"\s+[A-Z()0-9 ]+DEFAULT/gi))
      .toBeNull();
  });

  it("guards every ADD COLUMN with IF NOT EXISTS", () => {
    const addColumnLines = src.match(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi);
    expect(addColumnLines).toBeNull();
  });

  it("adds the trio to the evidence table", () => {
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence"\s+ADD COLUMN IF NOT EXISTS\s+"template_slug"\s+VARCHAR\(120\)/,
    );
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence"\s+ADD COLUMN IF NOT EXISTS\s+"template_version"\s+INTEGER/,
    );
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence"\s+ADD COLUMN IF NOT EXISTS\s+"template_db_id"\s+UUID/,
    );
  });

  it("adds the trio to the evidence_review_workflows table", () => {
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence_review_workflows"\s+ADD COLUMN IF NOT EXISTS\s+"template_slug"\s+VARCHAR\(120\)/,
    );
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence_review_workflows"\s+ADD COLUMN IF NOT EXISTS\s+"template_version"\s+INTEGER/,
    );
    expect(src).toMatch(
      /ALTER TABLE\s+"evidence_review_workflows"\s+ADD COLUMN IF NOT EXISTS\s+"template_db_id"\s+UUID/,
    );
  });

  it("declares both FK constraints with ON DELETE SET NULL", () => {
    // Evidence FK.
    expect(src).toMatch(
      /ADD CONSTRAINT\s+"evidence_template_db_id_fk"\s+FOREIGN KEY\s+\("template_db_id"\)\s+REFERENCES\s+"evidence_workflow_templates"\s+\("id"\)\s+ON DELETE SET NULL/,
    );
    // Review workflow FK.
    expect(src).toMatch(
      /ADD CONSTRAINT\s+"evidence_review_workflows_template_db_id_fk"\s+FOREIGN KEY\s+\("template_db_id"\)\s+REFERENCES\s+"evidence_workflow_templates"\s+\("id"\)\s+ON DELETE SET NULL/,
    );
  });

  it("guards the FK constraints with information_schema idempotency checks", () => {
    // Both DO $$ blocks must check for the existing constraint name
    // so re-running the migration is a clean no-op.
    expect(src).toMatch(/constraint_name = 'evidence_template_db_id_fk'/);
    expect(src).toMatch(
      /constraint_name = 'evidence_review_workflows_template_db_id_fk'/,
    );
  });

  it("creates the two non-unique (team_id, template_slug) indexes", () => {
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"evidence_team_id_template_slug_idx"\s+ON\s+"evidence"\s+\("team_id",\s*"template_slug"\)/,
    );
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+"evidence_review_workflows_team_id_template_slug_idx"\s+ON\s+"evidence_review_workflows"\s+\("team_id",\s*"template_slug"\)/,
    );
    // And neither is unique.
    expect.soft(src).not.toMatch(/CREATE UNIQUE INDEX[^;]*template_slug/i);
  });
});

// ---------------------------------------------------------------------------
// 8. Generated Prisma client types expose the new fields.
//
// These are compile-time assertions — the test merely has to compile to
// pass. We construct a typed object that the generated client would
// accept on create; if any of the new optional fields are missing from
// the generated types this file fails to compile at typecheck.
// ---------------------------------------------------------------------------

describe("Phase T — generated Prisma client types", () => {
  it("Evidence create input accepts the template trio (compile-time)", () => {
    // The cast to Prisma.EvidenceUncheckedCreateInput verifies the
    // generated client knows about all three columns. We do not
    // actually call prisma — this is purely a type-level assertion.
    const _evidenceTypeProbe: Pick<
      Prisma.EvidenceUncheckedCreateInput,
      "templateSlug" | "templateVersion" | "templateDbId"
    > = {
      templateSlug: "demo-slug",
      templateVersion: 1,
      templateDbId: "00000000-0000-0000-0000-000000000000",
    };
    expect(_evidenceTypeProbe.templateSlug).toBe("demo-slug");
    expect(_evidenceTypeProbe.templateVersion).toBe(1);
    expect(typeof _evidenceTypeProbe.templateDbId).toBe("string");
  });

  it("EvidenceReviewWorkflow create input accepts the template trio (compile-time)", () => {
    const _workflowTypeProbe: Pick<
      Prisma.EvidenceReviewWorkflowUncheckedCreateInput,
      "templateSlug" | "templateVersion" | "templateDbId"
    > = {
      templateSlug: "demo-slug",
      templateVersion: 2,
      templateDbId: "00000000-0000-0000-0000-000000000000",
    };
    expect(_workflowTypeProbe.templateSlug).toBe("demo-slug");
    expect(_workflowTypeProbe.templateVersion).toBe(2);
    expect(typeof _workflowTypeProbe.templateDbId).toBe("string");
  });
});
