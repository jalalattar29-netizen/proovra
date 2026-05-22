/**
 * Phase 32.5 — Stabilization release: production-blocker test coverage.
 *
 * Each test enforces ONE invariant the stabilization fixes depend on:
 *
 *   1. Verification package skip path for personal-workspace evidence
 *      — the worker MUST pre-check teamId BEFORE calling
 *      createVerificationPackage so the gate's
 *      `teamId_or_evidenceId_missing` path never fires for the
 *      personal-workspace case.
 *
 *   2. EvidenceArtifactStatus.verificationPackage projection includes
 *      `unavailable` + `unavailableReason` so the frontend can
 *      distinguish "still being generated" from "won't ever be
 *      generated (personal workspace)".
 *
 *   3. The evidence detail page polls /v1/evidence/:id/artifacts/status
 *      while finalized, paused on document.hidden.
 *
 *   4. Governance routes that read schema-drift-prone tables wrap
 *      Prisma errors via `runGovernanceHandler` → bounded 503, not
 *      raw 500.
 *
 *   5. Workspace-profile + role-aware sidebar visibility predicate
 *      filters admin-only items for non-admin roles.
 *
 *   6. Phase 32.5 consolidated migration absorbs every drift patch
 *      under services/api/sql/drift-patches/ AND creates
 *      reviewer_ops_reminders (which previously existed in Prisma
 *      but had no creator).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// =============================================================================
// PART 1 — Verification package teamId pre-check (Part 2 of brief)
// =============================================================================

describe("Phase 32.5 → 32.6.6 — verification package personal-workspace handling", () => {
  const PROCESSOR_SRC = readSource("../../worker/src/processor.ts");

  // Phase 32.6.6 — the personal-workspace pre-skip was retired.
  // Personal evidence is now first-class and generates a PERSONAL
  // BASIC package. The two historical assertions (worker SKIPs +
  // logs INFO line for skip) are inverted: BOTH must no longer be
  // present in the processor.

  it("Phase 32.6.6 — worker no longer pre-skips personal-workspace evidence", () => {
    // The `!!evidence.teamId` guard that gated package generation
    // on team presence is gone. Personal evidence reaches
    // createVerificationPackage and the package-mode selection
    // there picks `personal_basic`.
    expect(PROCESSOR_SRC).not.toMatch(/!!evidence\.teamId/);
    expect(PROCESSOR_SRC).not.toMatch(/personalWorkspacePackageSkipped/);
  });

  it("Phase 32.6.6 — `verification_package.skipped_personal_workspace` log line is removed", () => {
    expect(PROCESSOR_SRC).not.toMatch(
      /verification_package\.skipped_personal_workspace/,
    );
  });

  it("Phase 32.6.6 — PackageGateDeniedError catch arm preserved (governance still fail-closed for team evidence)", () => {
    expect(PROCESSOR_SRC).toMatch(/instanceof PackageGateDeniedError/);
    expect(PROCESSOR_SRC).toMatch(/package_generation_blocked_total/);
  });
});

// =============================================================================
// PART 2 — Artifact status projection: unavailable vs pending
// =============================================================================

describe("Phase 32.5 → 32.6.6 — artifact status projection", () => {
  const SERVICE_SRC = readSource(
    "../src/services/evidence-artifact-status.service.ts",
  );

  it("EvidenceArtifactStatus.verificationPackage carries `unavailable` + `unavailableReason` (shape retained for backward-compat)", () => {
    expect(SERVICE_SRC).toMatch(/unavailable: false;\s*unavailableReason: null;/);
    expect(SERVICE_SRC).toMatch(
      /unavailable: boolean;\s*unavailableReason: VerificationPackageUnavailableReason \| null;/,
    );
  });

  it("Phase 32.6.6 — `unavailable` for personal-workspace path is now always false", () => {
    // The historical derivation `finalized && !params.evidenceTeamId`
    // is replaced with a constant `false`. Personal evidence now
    // generates a PERSONAL BASIC package and transitions through the
    // normal pending → available flow.
    expect(SERVICE_SRC).toMatch(
      /packageUnavailableForPersonalWorkspace\s*=\s*false/,
    );
    expect(SERVICE_SRC).not.toMatch(
      /packageUnavailableForPersonalWorkspace\s*=\s*finalized\s*&&\s*!params\.evidenceTeamId/,
    );
  });

  it("Phase 32.6.6 — packagePending derivation still excludes blocked + unavailable", () => {
    const code = stripComments(SERVICE_SRC);
    expect(code).toMatch(
      /packagePending\s*=\s*finalized\s*&&\s*\n?\s*!latestPackage\s*&&\s*\n?\s*!packageUnavailableForPersonalWorkspace\s*&&\s*\n?\s*!packageBlocked/,
    );
  });

  it("Phase 32.6.6 — `unavailableReason` enum no longer emits a value (reserved for future cases)", () => {
    // The historical enum was a single bounded value. The new declaration
    // is `never` (no values currently produced). Match either the
    // historical or the new shape.
    expect(SERVICE_SRC).toMatch(
      /export type VerificationPackageUnavailableReason\s*=\s*(never|\|\s*"[^"]+")\s*;/,
    );
    // The personal-workspace reason string is no longer emitted as a
    // live value in the helper response payload.
    expect(SERVICE_SRC).toMatch(/unavailableReason:\s*null/);
  });

  it("route passes evidenceTeamId through to the helper", () => {
    const ROUTES_SRC = readSource("../src/routes/evidence.routes.ts");
    expect(ROUTES_SRC).toMatch(
      /buildEvidenceArtifactStatus\(\{[\s\S]{0,400}evidenceTeamId:\s*evidenceRecord\.teamId\s*\?\?\s*null/,
    );
  });
});

// =============================================================================
// PART 3 — Evidence detail page artifact polling
// =============================================================================

describe("Phase 32.5 — evidence detail page artifact polling", () => {
  const PAGE_SRC = readSource(
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  );

  it("polls /v1/evidence/:id/artifacts/status (the side-effect-free endpoint)", () => {
    expect(PAGE_SRC).toMatch(
      /\/v1\/evidence\/\$\{evidenceId\}\/artifacts\/status/,
    );
    // It must NOT poll the report download endpoint — that one creates
    // custody / audit events. We anchor on the bounded pollOnce()
    // helper name (not a doc comment), which survives stripComments.
    const code = stripComments(PAGE_SRC);
    const pollBlock = code.match(/const pollOnce[\s\S]*?\}, \[/);
    expect(pollBlock).toBeTruthy();
    expect(pollBlock![0]).not.toMatch(/report\/latest/);
  });

  it("polling pauses when the tab is hidden (document.hidden gate)", () => {
    expect(PAGE_SRC).toMatch(/document\.hidden/);
  });

  it("polling stops when both report + package are no longer pending", () => {
    expect(PAGE_SRC).toMatch(
      /reportStillPending\s*\|\|\s*packageStillPending/,
    );
    // The interval is cleared when pollOnce returns false.
    expect(PAGE_SRC).toMatch(/clearInterval\(timer\)/);
  });

  it("polling triggers loadWorkspace ONLY on state transition (not every tick)", () => {
    const code = stripComments(PAGE_SRC);
    expect(code).toMatch(
      /stateChanged\s*=\s*reportNowAvailable !== priorReportAvailable \|\|\s*packageNowAvailable !== priorPackageAvailable/,
    );
    expect(code).toMatch(/if \(stateChanged\) \{\s*await loadWorkspace\(\);/);
  });

  it("polling is gated on finalized status (SIGNED or REPORTED) — no polling for CREATED/UPLOADING", () => {
    expect(PAGE_SRC).toMatch(
      /const finalized = status === "SIGNED" \|\| status === "REPORTED";/,
    );
  });
});

// =============================================================================
// PART 4 — Governance routes: bounded 503 instead of 500
// =============================================================================

describe("Phase 32.5 — governance route schema-drift bounded handler", () => {
  const HELPER_SRC = readSource("../src/routes/_governance-error-bound.ts");
  const ROUTES_SRC = readSource("../src/routes/governance.routes.ts");

  it("helper recognises Prisma schema-drift codes P2022 / P2021 / P2025", () => {
    expect(HELPER_SRC).toMatch(/"P2022".*Column does not exist/);
    expect(HELPER_SRC).toMatch(/"P2021".*Table does not exist/);
    expect(HELPER_SRC).toMatch(/"P2025"/);
  });

  it("helper returns bounded 503 with a SINGLE error code (no schema names leaked)", () => {
    expect(HELPER_SRC).toMatch(/reply\.code\(503\)/);
    expect(HELPER_SRC).toMatch(/code: "governance_schema_unavailable"/);
    // The user-visible message MUST NOT mention table names.
    const messageMatch = HELPER_SRC.match(
      /message:\s*"([^"]+)"/,
    );
    expect(messageMatch).toBeTruthy();
    expect(messageMatch![1]).not.toMatch(/table|column|schema_validation/i);
  });

  it("non-Prisma errors are RE-THROWN (don't swallow real bugs)", () => {
    expect(HELPER_SRC).toMatch(/throw err;/);
  });

  it("the CORE governance read routes consume runGovernanceHandler", () => {
    // Phase 32.7.6 — `/v1/governance/case-legal-holds` was lifted
    // OUT of the generic `runGovernanceHandler` wrapper into a
    // per-endpoint optional-subsystem handler (P2021/P2022 → 200
    // empty + WARN log). The 3 remaining CORE read routes still
    // wrap with the 503 fail-closed contract:
    //   * /v1/governance/policy
    //   * /v1/governance/legal-holds
    //   * /v1/governance/retention-candidates
    const wrapsCount = (
      ROUTES_SRC.match(/await runGovernanceHandler\(reply,/g) ?? []
    ).length;
    expect(wrapsCount).toBeGreaterThanOrEqual(3);

    // And the case-legal-holds GET is intentionally NOT among
    // them — that's the Phase 32.7.6 optional-subsystem
    // contract.
    const caseGetIdx = ROUTES_SRC.indexOf(
      'app.get(\n    "/v1/governance/case-legal-holds"',
    );
    expect(caseGetIdx).toBeGreaterThan(-1);
    const caseNextHandler = ROUTES_SRC.indexOf("app.post(", caseGetIdx);
    const caseGetBody = ROUTES_SRC.slice(caseGetIdx, caseNextHandler);
    expect(caseGetBody).not.toMatch(/runGovernanceHandler\(reply,/);
  });
});

// =============================================================================
// PART 5 — Workspace profile + role-aware sidebar visibility
// =============================================================================

describe("Phase 32.5 — workspace profile + sidebar visibility", () => {
  const PROFILE_SRC = readSource(
    "../../../apps/web/lib/workspace-profile.ts",
  );
  const SIDEBAR_SRC = readSource(
    "../../../apps/web/components/app-shell-v2/AppSidebarV2.tsx",
  );
  // Phase 32.8B — sidebar items now live in the data-driven nav
  // config. Tests that previously read structure out of the sidebar
  // source should look here instead.
  const NAV_CONFIG_SRC = readSource(
    "../../../apps/web/lib/navigation-config.ts",
  );

  it("workspace profile catalog has 6 bounded values including INDIVIDUAL and ENTERPRISE_ADMIN", () => {
    const m = PROFILE_SRC.match(
      /export const WORKSPACE_PROFILES = \[([\s\S]*?)\] as const/,
    );
    expect(m).toBeTruthy();
    const entries = (m![1].match(/"[A-Z_]+"/g) ?? []).map((e) => e.slice(1, -1));
    expect(entries.sort()).toEqual([
      "ENTERPRISE_ADMIN",
      "INDIVIDUAL",
      "INSURANCE",
      "INVESTIGATION",
      "JOURNALISM",
      "LEGAL",
    ]);
  });

  it("workspace role catalog includes the bounded set", () => {
    const m = PROFILE_SRC.match(
      /export const WORKSPACE_ROLES = \[([\s\S]*?)\] as const/,
    );
    expect(m).toBeTruthy();
    const entries = (m![1].match(/"[A-Z_]+"/g) ?? []).map((e) => e.slice(1, -1));
    expect(entries).toContain("OWNER");
    expect(entries).toContain("ADMIN");
    expect(entries).toContain("MEMBER");
    expect(entries).toContain("VIEWER");
  });

  it("filterByVisibility honours platform-admin + roles + profiles predicates", () => {
    const code = stripComments(PROFILE_SRC);
    expect(code).toMatch(
      /if \(v\.requiresPlatformAdmin && !context\.isPlatformAdmin\) return false/,
    );
    expect(code).toMatch(/if \(!v\.roles\.includes\(context\.role\)\) return false/);
    expect(code).toMatch(/if \(!v\.profiles\.includes\(context\.profile\)\) return false/);
  });

  it("sidebar removes the duplicate /governance#... anchor links", () => {
    // The old sidebar had /governance#retention and /governance#legal-holds.
    // Phase 32.8B keeps this invariant — the data-driven nav config
    // never reintroduces those anchor links.
    expect(NAV_CONFIG_SRC).not.toMatch(/href: "\/governance#retention"/);
    expect(NAV_CONFIG_SRC).not.toMatch(/href: "\/governance#legal-holds"/);
  });

  it("sidebar links Governance items to real sub-pages (Phase 32.8B nav config)", () => {
    // Phase 32.8B — sidebar items are declared in lib/navigation-config.ts.
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/lifecycle"/);
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/retention"/);
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/destruction"/);
  });

  it("administration items gate visibility on OWNER/ADMIN role (Phase 32.8B nav config)", () => {
    // Phase 32.8B — Administration group lives in navigation-config.
    // Teams, Billing, Integrations, Intake Links must require admin
    // roles. Settings + Platform Admin have their own gates.
    const code = stripComments(NAV_CONFIG_SRC);
    // The Administration group block contains role-gated entries.
    const adminGroupIdx = code.indexOf(
      'const ADMINISTRATION_GROUP: NavGroup',
    );
    expect(adminGroupIdx).toBeGreaterThan(-1);
    const adminGroupEnd = code.indexOf("};", adminGroupIdx);
    const adminGroupBody = code.slice(adminGroupIdx, adminGroupEnd);
    // At least one admin-only item with the bounded role tuple.
    expect(adminGroupBody).toMatch(/roles: \["OWNER", "ADMIN"\]/);
  });

  it("sidebar consumes selectNavigationGroups exactly once (Phase 32.8B data-driven)", () => {
    // Phase 32.8B — the sidebar no longer hand-rolls multiple
    // `filterByVisibility(...)` calls. The canonical pipeline is
    // `selectNavigationGroups(...)`, called once.
    const calls = (
      SIDEBAR_SRC.match(/selectNavigationGroups\(/g) ?? []
    ).length;
    expect(calls).toBe(1);
  });
});

// =============================================================================
// PART 6 — Consolidated Prisma migration absorbs drift patches
// =============================================================================

describe("Phase 32.5 — consolidated migration absorbs drift patches", () => {
  const MIGRATION_PATH =
    "../prisma/migrations/20260620100000_phase24_31_consolidated_drift_patches/migration.sql";
  const MIGRATION_SRC = readSource(MIGRATION_PATH);

  it("migration absorbs every drift patch listed in services/api/sql/drift-patches/", () => {
    const driftDir = fileURLToPath(
      new URL("../../api/sql/drift-patches/", import.meta.url),
    );
    const patches = readdirSync(driftDir).filter((f) => f.endsWith(".sql"));
    expect(patches.length).toBeGreaterThanOrEqual(16);
    // The migration's header lists every patch by filename. Verify
    // every drift-patch file appears as a "BLOCK:" anchor or in the
    // header preamble.
    for (const patch of patches) {
      expect(
        MIGRATION_SRC.includes(`BLOCK: ${patch}`) ||
          MIGRATION_SRC.includes(patch),
        `Migration must absorb drift patch ${patch}`,
      ).toBe(true);
    }
  });

  it("migration creates reviewer_ops_reminders (which had no creator anywhere before)", () => {
    expect(MIGRATION_SRC).toMatch(
      /CREATE TABLE IF NOT EXISTS "reviewer_ops_reminders"/,
    );
    expect(MIGRATION_SRC).toMatch(
      /reviewer_ops_reminders_team_kind_dedup_uk/,
    );
  });

  it("migration has NO nested BEGIN / COMMIT statements (Prisma wraps each migration in its own tx)", () => {
    // Strip comments so the documentation header doesn't count.
    const code = MIGRATION_SRC
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(code).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

// =============================================================================
// PART 7 — Mobile viewport meta
// =============================================================================

describe("Phase 32.5 — root layout viewport meta", () => {
  const LAYOUT_SRC = readSource("../../../apps/web/app/layout.tsx");

  it("root layout declares the mobile viewport meta tag", () => {
    expect(LAYOUT_SRC).toMatch(
      /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1\.0[^"]*"\s*\/>/,
    );
  });

  it("viewport meta includes viewport-fit=cover (modern iOS safe-area support)", () => {
    expect(LAYOUT_SRC).toMatch(/viewport-fit=cover/);
  });
});
