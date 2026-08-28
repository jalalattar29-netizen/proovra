/**
 * P1 DOMAIN REMEDIATION (2026-07-21) — workspaceKind discriminator contracts.
 *
 * Pins the canonical classification at every layer that can be verified
 * without a live database (migration APPLY is runtime-verified separately):
 *
 *   - schema declares WorkspaceKind (PERSONAL/OWNED/ORGANIZATION) on Team
 *     and OrganizationKind (SYSTEM/CUSTOMER) on Organization;
 *   - the migration backfills deterministically (isPersonal → PERSONAL,
 *     ENTERPRISE plan → ORGANIZATION, remainder → OWNED) and fails loudly
 *     on integrity violations;
 *   - every Team-creation path sets an explicit kind — personal bootstrap
 *     → PERSONAL/SYSTEM, self-service create → OWNED/SYSTEM, enterprise
 *     provisioning → ORGANIZATION/CUSTOMER;
 *   - `isPersonal=false` is never the sole "Organization" discriminator in
 *     the creation paths.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(API_ROOT, rel), "utf8");

const SCHEMA = read("prisma/schema.prisma");
const MIGRATION = read(
  "prisma/migrations/20270920000000_workspace_kind_discriminator/migration.sql",
);

describe("P1 — schema discriminators", () => {
  it("declares WorkspaceKind with exactly PERSONAL / OWNED / ORGANIZATION", () => {
    expect(SCHEMA).toMatch(
      /enum WorkspaceKind \{\s*PERSONAL\s*OWNED\s*ORGANIZATION\s*\}/,
    );
    // PHASE 12 CORRECTIVE PASS §5.2 (ARCH-002, 2026-08-06) — MANDATORY.
    //
    // This pinned the NULLABLE form, which is what forced the plan-derived
    // fallback in `normalizeWorkspaceKind` — the fallback that turned a
    // commercial upgrade into a silent tenancy change. The column is NOT NULL
    // from 20271125000000, after a backfill from structural authority only.
    expect(SCHEMA).toMatch(/workspaceKind\s+WorkspaceKind\s+@map\("workspace_kind"\)/);
    expect(SCHEMA).not.toMatch(/workspaceKind\s+WorkspaceKind\?/);
    expect(SCHEMA).toMatch(/@@index\(\[workspaceKind\]\)/);
  });

  it("declares OrganizationKind SYSTEM / CUSTOMER with SYSTEM default", () => {
    expect(SCHEMA).toMatch(/enum OrganizationKind \{\s*SYSTEM\s*CUSTOMER\s*\}/);
    expect(SCHEMA).toMatch(
      /kind\s+OrganizationKind\s+@default\(SYSTEM\)/,
    );
  });
});

describe("P1 — deterministic backfill migration", () => {
  it("classifies PERSONAL then ENTERPRISE→ORGANIZATION then remainder→OWNED", () => {
    const personalIdx = MIGRATION.indexOf("'PERSONAL'");
    const orgIdx = MIGRATION.indexOf("'ORGANIZATION'\n  WHERE");
    const ownedIdx = MIGRATION.indexOf("'OWNED'");
    expect(personalIdx).toBeGreaterThan(-1);
    expect(MIGRATION).toMatch(/'PERSONAL'\s*\n\s*WHERE "is_personal" = true/);
    expect(MIGRATION).toMatch(
      /'ORGANIZATION'\s*\n\s*WHERE "workspace_kind" IS NULL AND "billing_plan" = 'ENTERPRISE'/,
    );
    expect(MIGRATION).toMatch(/'OWNED'\s*\n\s*WHERE "workspace_kind" IS NULL/);
    expect(personalIdx).toBeLessThan(orgIdx === -1 ? Infinity : orgIdx);
    expect(ownedIdx).toBeGreaterThan(personalIdx);
  });

  it("promotes orgs with enterprise provenance to CUSTOMER", () => {
    expect(MIGRATION).toMatch(/"kind" = 'CUSTOMER'/);
    expect(MIGRATION).toMatch(/pending_enterprise_seats" IS NOT NULL/);
    expect(MIGRATION).toMatch(/billing_plan" = 'ENTERPRISE'/);
  });

  it("fails loudly on backfill integrity violations (no silent bad rows)", () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'workspace_kind backfill integrity violation/);
    expect(MIGRATION).toMatch(/"workspace_kind" IS NULL/);
  });
});

describe("P1 — creation paths set explicit kinds", () => {
  it("personal bootstrap → workspaceKind PERSONAL + SYSTEM container org", () => {
    const src = read(
      "src/services/platform-context/workspace-bootstrap.service.ts",
    );
    expect(src).toMatch(/workspaceKind: "PERSONAL"/);
    expect(src).toMatch(/kind: "SYSTEM"/);
  });

  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the self-service
  // workspace CREATION path was removed from `POST /v1/teams`, so there is no
  // longer a `team.create` there to state a kind.
  //
  // The reason is commercial and it is decisive: checkout has ONE subject and
  // it is the person, so a workspace created on that path could never be paid
  // for. It would resolve FREE permanently and the shared-workspace admission
  // rule would refuse every piece of evidence recorded in it. The route
  // refuses instead of minting something unusable.
  //
  // The property this test defends is unchanged and is asserted on the two
  // paths that still create workspaces — the personal bootstrap and Enterprise
  // provisioning, each in its own test here. What is asserted for this file is
  // the ABSENCE, so the removal is pinned rather than silently forgotten.
  it("POST /v1/teams no longer creates a workspace — nothing there to classify", () => {
    const src = read("src/routes/teams.routes.ts");
    expect(src).not.toMatch(/(?:tx|prisma)\.team\.create\(/);
    expect(src).toMatch(/WORKSPACE_CREATION_NOT_SELF_SERVICE/);
  });

  it("enterprise provisioning → workspaceKind ORGANIZATION + CUSTOMER org (both paths + grant)", () => {
    const src = read("src/services/enterprise-provisioning.service.ts");
    const orgKindCount = (src.match(/kind: "CUSTOMER"/g) ?? []).length;
    const wsKindCount = (src.match(/workspaceKind: "ORGANIZATION"/g) ?? [])
      .length;
    // owner-exists org + owner-missing org + grant promotion
    expect(orgKindCount).toBeGreaterThanOrEqual(3);
    // owner-exists team + owner-accept minted team (+ grant flip)
    expect(wsKindCount).toBeGreaterThanOrEqual(2);
  });
});
