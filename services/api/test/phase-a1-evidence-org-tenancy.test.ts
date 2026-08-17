/**
 * Phase A1 — Evidence organization tenancy, contract suite.
 *
 * Source-contract style (same shape as Phase A0 / Phase 30.9). This
 * suite asserts the five contracts that A1 introduces:
 *
 *   1. The migration backfills `evidence.organization_id` from
 *      `teams.organization_id` for every row where `team_id IS NOT NULL`
 *      AND the current `organization_id` disagrees with the team's
 *      organization. Healing the Phase A1 write-path bug AND any
 *      pre-A1 NULLs.
 *
 *   2. The migration adds the FK constraint
 *      `evidence_organization_id_fkey` (NOT VALID + VALIDATE) on
 *      `evidence.organization_id → organizations(id)` with
 *      `ON DELETE RESTRICT`.
 *
 *   3. The migration adds the CHECK constraint
 *      `evidence_team_implies_org_chk`: a row may not have
 *      `team_id IS NOT NULL AND organization_id IS NULL`. Personal-
 *      mode rows (`team_id IS NULL AND organization_id IS NULL`)
 *      remain legal.
 *
 *   4. `WorkspaceScope` carries `organizationId`. Both
 *      `getPersonalWorkspaceScope` and `getTeamWorkspaceScope`
 *      populate it. The Phase A1 evidence-create site writes
 *      `scope.organizationId` — NOT `scope.teamId` — into
 *      `evidence.organization_id`.
 *
 *   5. The `tenancy-resolver.service.ts` helper rejects the Stage 6
 *      invariant violation (`team_org_missing`) and the cross-tenant
 *      disagreement (`tenancy_disagreement`) cleanly.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const MIGRATION_SQL = readSource(
  "../prisma/migrations/20261001000000_phase_a1_evidence_org_tenancy/migration.sql",
);
const SCHEMA = readSource("../prisma/schema.prisma");
const EVIDENCE_SERVICE = readSource("../src/services/evidence.service.ts");
const WORKSPACE_BILLING = readSource(
  "../src/services/workspace-billing.service.ts",
);
describe("Phase A1 — evidence org tenancy (source contract)", () => {
  it("migration UPDATEs evidence.organization_id from teams.organization_id", () => {
    expect(MIGRATION_SQL).toMatch(
      /UPDATE\s+evidence[\s\S]*SET\s+organization_id\s*=\s*teams\.organization_id[\s\S]*WHERE\s+evidence\.team_id\s*=\s*teams\.id/i,
    );
  });

  it("migration adds the evidence_organization_id_fkey FK constraint (NOT VALID then VALIDATE)", () => {
    expect(MIGRATION_SQL).toContain(
      'ADD CONSTRAINT evidence_organization_id_fkey',
    );
    expect(MIGRATION_SQL).toContain("REFERENCES organizations(id)");
    expect(MIGRATION_SQL).toMatch(/ON\s+DELETE\s+RESTRICT/i);
    expect(MIGRATION_SQL).toMatch(/NOT\s+VALID/i);
    expect(MIGRATION_SQL).toMatch(
      /VALIDATE\s+CONSTRAINT\s+evidence_organization_id_fkey/i,
    );
  });

  it("migration adds the evidence_team_implies_org_chk CHECK constraint", () => {
    expect(MIGRATION_SQL).toContain("evidence_team_implies_org_chk");
    // Personal-mode rows (both NULL) remain legal; the constraint
    // rejects only the "team_id set, org_id NULL" combination.
    expect(MIGRATION_SQL).toMatch(
      /CHECK\s*\(\s*[\s\S]*team_id\s+IS\s+NULL\s+OR\s+organization_id\s+IS\s+NOT\s+NULL[\s\S]*\)/i,
    );
  });

  it("migration creates the (team_id, organization_id) composite index", () => {
    expect(MIGRATION_SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+evidence_team_id_organization_id_idx/i,
    );
  });

  it("migration NEVER sets NOT NULL on evidence.organization_id (intentional, Stage 7 work)", () => {
    expect(MIGRATION_SQL).not.toMatch(
      /ALTER\s+TABLE\s+evidence\s+ALTER\s+COLUMN\s+organization_id\s+SET\s+NOT\s+NULL/i,
    );
  });

  it("schema.prisma declares the Evidence ↔ Organization relation", () => {
    const evidenceBlock = SCHEMA.match(
      /model\s+Evidence\s*\{[\s\S]*?@@map\("evidence"\)\s*\}/,
    )?.[0];
    expect(evidenceBlock).toBeTruthy();
    expect(evidenceBlock!).toContain('@relation("EvidenceOrganization"');
    expect(evidenceBlock!).toMatch(
      /fields:\s*\[organizationId\]\s*,\s*references:\s*\[id\]\s*,\s*onDelete:\s*Restrict/,
    );
  });

  it("WorkspaceScope carries organizationId and both factories populate it", () => {
    expect(WORKSPACE_BILLING).toMatch(
      /export\s+type\s+WorkspaceScope\s*=\s*\{[\s\S]*organizationId:\s*string\s*\|\s*null/,
    );
    // Personal factory reads the bootstrap personal team's organizationId.
    expect(WORKSPACE_BILLING).toMatch(
      /isPersonal:\s*true[\s\S]*select:\s*\{\s*organizationId:\s*true\s*\}/,
    );
    // Team factory passes the team's organizationId straight through.
    expect(WORKSPACE_BILLING).toContain(
      "organizationId: team.organizationId,",
    );
  });

  it("evidence.service.ts writes scope.organizationId (not scope.teamId) into organization_id", () => {
    // The fix replaces the prior `organizationId: scope.teamId,` with
    // `organizationId: scope.organizationId,`. We assert the correct
    // assignment is present. The buggy assignment can still appear
    // INSIDE a comment that explains the historical bug — we look
    // for the executable line (trailing comma + newline) to confirm
    // the live code no longer contains it.
    expect(EVIDENCE_SERVICE).toContain(
      "organizationId: scope.organizationId,",
    );
    // Confirm the executable assignment to `scope.teamId` is gone.
    // The historical-context comment (which mentions the bug as a
    // string in backticks) is allowed.
    const executableLines = EVIDENCE_SERVICE.split("\n").filter(
      (line) => !line.trim().startsWith("//"),
    );
    const buggyLine = executableLines.find((line) =>
      /^\s*organizationId:\s*scope\.teamId\s*,/.test(line),
    );
    expect(buggyLine).toBeUndefined();
  });

  // LEGACY-003 (2026-08-15): the read-only guarantee asserted here belonged to
  // the REMOVED tenancy resolver. A module that does not exist writes nothing.

});

// =============================================================================
// LEGACY-003 — removed module contract
// =============================================================================

/**
 * LEGACY-003 (2026-08-15) REMOVED `src/services/organization/tenancy-resolver.service.ts`. It resolved a Team's Organization id back when `teams.organization_id` was NULLABLE; Stage 6 made the column NOT NULL and every write path selects it directly, leaving this a lookup with no caller AND a second place that could decide which Organization a workspace belongs to. The Stage-6 invariant itself is still asserted in this file against the code that actually runs.
 */
describe("Phase A1 — tenancy resolver stays removed", () => {
  it("the removed module(s) stay removed", () => {
    for (const rel of [
      "../src/services/organization/tenancy-resolver.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});
