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

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  // Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
  // concatenate the orchestrator + every tab body so source-shape
  // assertions still find the relevant snippets.
  // PHASE 12 POINT 4 — the artifact-readiness poll was extracted from the
  // orchestrator into its own hook (the page is orchestration only, enforced
  // by an 80 KB guard). Included here for the same reason the tab bodies are.
  const PAGE_SRC = [
    "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_hooks/useArtifactReadinessPoll.ts",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx",
    "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx",
  ].map(readSource).join("\n\n");

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
    // The reload is injected into the extracted hook as `reloadWorkspace`
    // (bound to the orchestrator's `loadWorkspace`), so the requirement is
    // that the reload happens ONLY inside the state-transition branch.
    expect(code).toMatch(/if \(stateChanged\) \{\s*await reloadWorkspace\(\);/);
    expect(code).toMatch(/reloadWorkspace: loadWorkspace,/);
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

  // Phase 12 convergence — the CORE governance read routes (policy /
  // legal-holds / retention-candidates / case-legal-holds) were removed as
  // DEAD_LEGACY; their runGovernanceHandler wrap assertions retired with them.
  // The _governance-error-bound helper (HELPER_SRC above) is still validated.
});

// =============================================================================
// PART 5 — Workspace profile + role-aware sidebar visibility
// =============================================================================

describe("Phase 32.5 — workspace profile + sidebar visibility", () => {
  // PHASE 12 POINT 4 PASS D/G — `lib/workspace-profile.ts` had ZERO importers
  // (the shell reads the canonical route registry) and was deleted. The three
  // tests that lived here described the internal shape of that dead module —
  // its profile catalog, its role catalog and its visibility predicate — none
  // of which any shipped surface consumed. They are replaced by a guard that
  // keeps the module from returning, and by the registry invariants below,
  // which assert the navigation behaviour users actually get.
  // Phase 38.6 — the canonical navigation source of truth is the route
  // registry (`lib/navigation/routeRegistry.ts`); the legacy
  // `lib/navigation-config.ts` was deleted and its href invariants live here.
  const NAV_CONFIG_SRC = readSource(
    "../../../apps/web/lib/navigation/routeRegistry.ts",
  );

  it("the unmounted workspace-profile module stays removed", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL("../../../apps/web/lib/workspace-profile.ts", import.meta.url),
        ),
      ),
    ).toBe(false);
  });

  it("sidebar removes the duplicate /governance#... anchor links", () => {
    // The old sidebar had /governance#retention and /governance#legal-holds.
    // The canonical route registry keeps this invariant — it never
    // reintroduces those anchor links.
    expect(NAV_CONFIG_SRC).not.toMatch(/href: "\/governance#retention"/);
    expect(NAV_CONFIG_SRC).not.toMatch(/href: "\/governance#legal-holds"/);
  });

  it("nav links Governance items to real sub-pages (routeRegistry)", () => {
    // Phase 38.6 — governance sub-routes are declared in the canonical
    // route registry (lib/navigation/routeRegistry.ts).
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/lifecycle"/);
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/retention"/);
    expect(NAV_CONFIG_SRC).toMatch(/href: "\/governance\/destruction"/);
  });

  // OBSOLETE — Phase 38.6 removed `lib/navigation-config.ts` and its
  // NavGroup/domain shape entirely. The Administration-group role
  // tuple (`roles: ["OWNER", "ADMIN"]`) was an internal property of
  // that deleted file; the canonical routeRegistry gates access via
  // `requiredCapabilities`, not sidebar-group role tuples, so this
  // structural assertion no longer has a source to read. Role gating
  // is now enforced server-side and covered by the platform-context
  // + route-authz tests.
  // OBSOLETE — Phase 32.8 Foundation removed `selectNavigationGroups`
  // from the sidebar entirely. The server pre-filters navigation via
  // /v1/platform/context. See phase-32-8-foundation-platform-context.test.ts.
});

// =============================================================================
// PART 6 — Consolidated Prisma migration absorbs drift patches
// =============================================================================

describe("Phase 32.5 — consolidated migration absorbs drift patches", () => {
  const MIGRATION_PATH =
    "../prisma/migrations/20260620100000_phase24_31_consolidated_drift_patches/migration.sql";
  const MIGRATION_SRC = readSource(MIGRATION_PATH);

  it("every drift patch is absorbed by SOME migration", () => {
    // The invariant is "no drift patch exists that no migration applies" —
    // otherwise a fresh database and a patched one diverge, silently.
    //
    // This used to check absorption by the 2026-06 consolidated migration
    // ALONE, which was correct only while that migration was the newest one.
    // A patch authored later is absorbed by its own migration and would fail a
    // check scoped to the consolidation — a false negative that would push the
    // next author to either skip the patch or backdate it into a migration that
    // has already been applied in production. Both are worse than widening the
    // search.
    const driftDir = fileURLToPath(
      new URL("../../api/sql/drift-patches/", import.meta.url),
    );
    const migrationsDir = fileURLToPath(
      new URL("../prisma/migrations/", import.meta.url),
    );
    const patches = readdirSync(driftDir).filter((f) => f.endsWith(".sql"));
    expect(patches.length).toBeGreaterThanOrEqual(16);

    const migrationBodies = readdirSync(migrationsDir)
      .filter((d) => /^\d{14}_/.test(d))
      .map((d) => {
        const p = fileURLToPath(
          new URL(`../prisma/migrations/${d}/migration.sql`, import.meta.url),
        );
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      });

    for (const patch of patches) {
      // A patch is absorbed either by NAME (the consolidation lists each one)
      // or by CONTENT (a later migration carries the same statements and names
      // the patch in its own header).
      const absorbed =
        MIGRATION_SRC.includes(`BLOCK: ${patch}`) ||
        MIGRATION_SRC.includes(patch) ||
        migrationBodies.some((body) => body.includes(patch));
      expect(absorbed, `No migration absorbs drift patch ${patch}`).toBe(true);
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
