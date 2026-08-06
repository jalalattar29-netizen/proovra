/**
 * Phase R9 — Case/matter evidence views exclude soft-deleted evidence (F22).
 *
 * A trashed evidence row keeps its `CaseEvidenceLink` rows, so the
 * case-workspace and matter-workspace evidence display lists + counts
 * filtered by case linkage / `id in evidenceIds` WITHOUT a
 * `deletedAt: null` guard would render soft-deleted evidence as still
 * "linked" and inflate the linked-evidence counts. These pins assert
 * the display/count queries exclude it.
 *
 * Track 1B closure — case linkage is expressed as
 * `caseLinks: { some: { caseId: input.caseId } }` (the legacy
 * Evidence.caseId scalar was dropped by migration
 * 20271105000000_evidence_case_id_removal).
 *
 * Source-contract style (DB-free), consistent with the other case tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSvc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/services/cases/${rel}`, import.meta.url)), "utf8");
}

const caseWorkspace = readSvc("case-workspace.service.ts");
const matterWorkspace = readSvc("matter-workspace.service.ts");

describe("Phase R9 — case/matter evidence views exclude soft-deleted (F22)", () => {
  it("case-workspace linked-evidence count filters deletedAt: null", () => {
    expect(caseWorkspace).toMatch(
      /evidence\.count\(\{\s*where:\s*\{\s*caseLinks:\s*\{\s*some:\s*\{\s*caseId:\s*input\.caseId\s*\}\s*\},\s*deletedAt:\s*null\s*\}/,
    );
  });

  it("no prisma.evidence query filters by case linkage without deletedAt: null", () => {
    // Scope to Evidence queries only (caseLegalHold / reviewWorkflow etc.
    // legitimately filter by caseId without a deletedAt column). Every
    // `prisma.evidence.count|findMany({ where: { caseLinks: { some: { caseId: input.caseId } } ... }})`
    // must carry deletedAt: null.
    const evidenceQueries = [
      ...caseWorkspace.matchAll(
        /prisma\.evidence\.(?:count|findMany)\(\{\s*(?:\/\/[^\n]*\n\s*)*where:\s*\{\s*caseLinks:\s*\{\s*some:\s*\{\s*caseId:\s*input\.caseId\s*\}\s*\}([^)]*?)\}\s*,/g,
      ),
    ];
    expect(evidenceQueries.length).toBeGreaterThan(0);
    for (const m of evidenceQueries) {
      expect(m[1], `a prisma.evidence case-linkage query is missing deletedAt: null: ${m[0]}`).toMatch(
        /deletedAt:\s*null/,
      );
    }
  });

  it("matter-workspace evidence board excludes soft-deleted evidence by id", () => {
    expect(matterWorkspace).toMatch(
      /where:\s*\{\s*id:\s*\{\s*in:\s*evidenceIds\s*\},\s*deletedAt:\s*null\s*\}/,
    );
  });
});
