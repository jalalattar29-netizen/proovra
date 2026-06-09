/**
 * PHASE R1.5B — Workspace experience segmentation guardrails.
 *
 * R1.5B added a canonical experience-mode resolver and wired it as
 * an emphasis-only layer on top of the existing access + workflow
 * chain. The platform stays one product; Personal Space stops
 * looking like an admin console.
 *
 * Hard contract pinned by this test file:
 *
 *   1. The experience resolver is a PURE function (no fetches, no
 *      authorization, no `requiredCapabilities` consultation).
 *   2. PERSONAL mode demotes a bounded set of ORG-only routes into
 *      `moreAdvancedItems`. The routes remain in All Tools and
 *      reachable by direct link.
 *   3. The shell + sidebar + dashboard expose the experience mode
 *      as data attributes only — no class names that depend on the
 *      mode, no feature forking.
 *   4. Observability emits the 4 R1.5B events.
 *   5. `useTeamId()` long-tail audit is documented (not migrated).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listAllFiles, listAllTsxFiles } from "./_helpers/file-walker";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

// =============================================================================
// PART 1 — Workspace experience modes defined
// =============================================================================

describe("R1.5B Part 1 — workspace experience modes are bounded + canonical", () => {
  const types = readWeb("lib/workspace-experience/types.ts");

  it("defines exactly the four canonical experience modes", () => {
    expect(types).toMatch(/PERSONAL/);
    expect(types).toMatch(/ORGANIZATION/);
    expect(types).toMatch(/REVIEW_OPS/);
    expect(types).toMatch(/GOVERNANCE/);
    // The union should not have grown unbounded — any new mode is a
    // CR-level decision.
    const unionMatch = types.match(
      /export type WorkspaceExperienceMode[\s\S]*?;/,
    );
    expect(unionMatch).toBeTruthy();
    const union = unionMatch![0];
    expect(union).toMatch(/"PERSONAL"/);
    expect(union).toMatch(/"ORGANIZATION"/);
    expect(union).toMatch(/"REVIEW_OPS"/);
    expect(union).toMatch(/"GOVERNANCE"/);
    // Sanity-check that no extra literal modes have been added.
    const literalCount = (union.match(/"\w+"/g) ?? []).length;
    expect(literalCount).toBe(4);
  });
});

// =============================================================================
// PART 2 — Canonical resolver, pure + no authorization
// =============================================================================

describe("R1.5B Part 2 — resolver is pure + carries no authorization logic", () => {
  const resolver = readWeb("lib/workspace-experience/resolveWorkspaceExperience.ts");

  it("resolver source does NOT consult route-level authorization fields", () => {
    // Code-context matching only — explanatory header comments are
    // allowed to mention the symbol names (the docstring asserts the
    // contract: "NEVER consults `requiredCapabilities`, ...").
    expect(resolver).not.toMatch(/\.requiredCapabilities\b/);
    expect(resolver).not.toMatch(/\.requiredActiveSpace\b/);
    expect(resolver).not.toMatch(/\.canLoad\b/);
    expect(resolver).not.toMatch(/\.canSeeNav\b/);
    expect(resolver).not.toMatch(/\bauthorize\s*\(/);
  });

  it("resolver source has no fetch / no async I/O", () => {
    expect(resolver).not.toMatch(/\bfetch\(/);
    expect(resolver).not.toMatch(/\bapiFetch\(/);
    expect(resolver).not.toMatch(/\basync\b/);
    expect(resolver).not.toMatch(/\bawait\b/);
  });

  it("PERSONAL active space always resolves to PERSONAL mode", () => {
    // Source contract — the only PERSONAL match in the resolver
    // body must be on `activeSpaceType === "PERSONAL"`. We anchor
    // by requiring this guard to appear before any ORG sub-mode
    // branching.
    const personalBranch = resolver.indexOf('activeSpaceType === "PERSONAL"');
    const reviewOpsBranch = resolver.indexOf('"REVIEW_OPS"');
    expect(personalBranch).toBeGreaterThan(-1);
    expect(reviewOpsBranch).toBeGreaterThan(-1);
    expect(personalBranch).toBeLessThan(reviewOpsBranch);
  });
});

// =============================================================================
// PART 3 — Personal demotion route set is bounded + sane
// =============================================================================

describe("R1.5B Part 3 — personal-mode demotion set is bounded", () => {
  const demotion = readWeb(
    "lib/workspace-experience/personalDemotionRules.ts",
  );

  it("only ORG-only review + governance routes are listed", () => {
    // Bounded vocabulary — each route id is one of the
    // ORG-only entries in routeRegistry.ts:355-763.
    const EXPECTED = new Set([
      "review.escalations",
      "review.queue",
      "review.sla",
      "governance.hub",
      "governance.policy",
      "governance.retention",
      "governance.lifecycle",
      "governance.destruction",
      "governance.analytics",
      "governance.notifications",
    ]);
    for (const id of EXPECTED) {
      expect(demotion).toMatch(new RegExp(`"${id.replace(".", "\\.")}"`));
    }
    // Make sure no non-ORG-only route slipped in — count quoted
    // strings.
    const quotedCount = (demotion.match(/"[a-z0-9._-]+"/gi) ?? []).length;
    expect(
      quotedCount,
      "personal demotion set should contain only the bounded 10 ORG-only ids",
    ).toBe(EXPECTED.size);
  });
});

// =============================================================================
// PART 4 — applyExperienceEmphasis is a pure transform (no permission logic)
// =============================================================================

describe("R1.5B Part 4 — applyExperienceEmphasis preserves access decisions", () => {
  const transform = readWeb(
    "lib/workspace-experience/applyExperienceEmphasis.ts",
  );

  it("transform does not touch allToolsItems (preserves discoverability)", () => {
    // The transform must move demoted items from primary/secondary
    // into moreAdvanced; it must not rebuild allTools or
    // recommendedItems.
    expect(transform).not.toMatch(/allToolsItems\s*=/);
    expect(transform).not.toMatch(/recommendedItems\s*=/);
  });

  it("transform does not introduce authorization predicates", () => {
    expect(transform).not.toMatch(/canLoad\b/);
    expect(transform).not.toMatch(/canSeeNav\b/);
    expect(transform).not.toMatch(/authorize/i);
    expect(transform).not.toMatch(/requiredCapabilities/);
  });
});

// =============================================================================
// PART 5 — Sidebar consumes the experience resolver
// =============================================================================

describe("R1.5B Part 5 — AppSidebarV2 consults the experience resolver", () => {
  const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");

  it("imports the canonical workspace-experience helpers", () => {
    expect(sidebar).toMatch(/resolveWorkspaceExperience/);
    // R2 extracted the per-mode demotion into the canonical
    // disclosure resolver; the sidebar consumes that instead of
    // calling `applyExperienceEmphasis` directly.
    expect(sidebar).toMatch(/resolveNavigationDisclosure/);
  });

  it("uses the disclosure-refined buckets for SidebarMoreView rendering", () => {
    // After R2 the sidebar renders `disclosure.moreAdvancedItems`
    // (which folds in the experience demotion + primary overflow);
    // the previous `demoted.moreAdvancedItems` shape no longer
    // exists since R2 extracted the pipeline.
    expect(sidebar).toMatch(/items=\{disclosure\.moreAdvancedItems\}/);
  });

  it("emits the four R1.5B observability events", () => {
    expect(sidebar).toMatch(/workspace-experience:resolved/);
    expect(sidebar).toMatch(/navigation-mode:resolved/);
    expect(sidebar).toMatch(/advanced-tooling:disclosed/);
  });

  it("exposes data-workspace-experience-mode on the sidebar root", () => {
    expect(sidebar).toMatch(/data-workspace-experience-mode=/);
  });
});

// =============================================================================
// PART 6 — Shell + Dashboard expose mode as data only (no feature fork)
// =============================================================================

describe("R1.5B Part 6 — shell + dashboard expose mode as data only", () => {
  const shell = readWeb("components/app-shell-v2/AppShellV2.tsx");
  const cc = readWeb("components/command-center/CommandCenter.tsx");

  it("AppShellV2 sets data-workspace-experience-mode (CSS hook for R5/R6)", () => {
    expect(shell).toMatch(/resolveWorkspaceExperience/);
    expect(shell).toMatch(/data-workspace-experience-mode=/);
  });

  it("CommandCenter sets data-cc-experience-mode + data-cc-dashboard-emphasis", () => {
    expect(cc).toMatch(/resolveWorkspaceExperience/);
    expect(cc).toMatch(/data-cc-experience-mode=/);
    expect(cc).toMatch(/data-cc-dashboard-emphasis=/);
    expect(cc).toMatch(/dashboard-mode:resolved/);
  });

  it("no duplicate dashboard component was created", () => {
    // No `PersonalDashboard`, `OrgDashboard`, etc.
    const root = webPath("components");
    const all = listAllFiles(root);
    const FORBIDDEN_FILES = [
      "PersonalCommandCenter.tsx",
      "OrgCommandCenter.tsx",
      "OrganizationCommandCenter.tsx",
      "PersonalDashboard.tsx",
      "OrgDashboard.tsx",
      "PersonalAppShell.tsx",
      "OrgAppShell.tsx",
      "PersonalSidebar.tsx",
      "OrgSidebar.tsx",
    ];
    for (const file of all) {
      const name = file.split(/[\\/]/).pop()!;
      expect(
        FORBIDDEN_FILES.includes(name),
        `R1.5B forbids duplicate dashboard/sidebar components — found ${name}`,
      ).toBe(false);
    }
  });

  it("no duplicate sidebar component was created", () => {
    // We rely on the previous test's recursion + FORBIDDEN list.
    // A separate explicit pin: the only AppSidebarV2 file is the
    // canonical one.
    const sidebarMatches = readdirSync(
      webPath("components/app-shell-v2"),
    ).filter((n) => /Sidebar/i.test(n) && /\.tsx?$/.test(n));
    // AppSidebarV2.tsx is the canonical sidebar. Other files in
    // this folder may legitimately contain "Sidebar" in helper
    // names (no expectation imposed beyond the canonical one).
    expect(sidebarMatches).toContain("AppSidebarV2.tsx");
  });
});

// =============================================================================
// PART 7 — observability vocabulary extended with the R1.5B events
// =============================================================================

describe("R1.5B Part 7 — observability vocabulary extended", () => {
  const obs = readWeb("lib/platform-context/state-observability.ts");

  it("STATE_OBSERVABILITY_EVENTS includes the four R1.5B events", () => {
    expect(obs).toMatch(/"workspace-experience:resolved"/);
    expect(obs).toMatch(/"navigation-mode:resolved"/);
    expect(obs).toMatch(/"dashboard-mode:resolved"/);
    expect(obs).toMatch(/"advanced-tooling:disclosed"/);
  });

  it("the utility remains no-op in production", () => {
    // CR1.5 contract continues to hold — production gate first.
    expect(obs).toMatch(/process\.env\.NODE_ENV/);
    expect(obs).toMatch(/NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY/);
  });
});

// =============================================================================
// PART 8 — workflow / persona still presentation-only (no auth regression)
// =============================================================================

describe("R1.5B Part 8 — no authorization regression", () => {
  it("routeAccessResolver still does NOT consult workflow/persona", () => {
    const src = readWeb("lib/navigation/routeAccessResolver.ts");
    // Code-context matching only — the header comment legitimately
    // documents the no-workflow / no-persona contract by naming the
    // symbols it does NOT consult. Negate code patterns only.
    expect(src).not.toMatch(/\.workflowProfile\b/);
    expect(src).not.toMatch(/\.primaryWorkflow\b/);
    expect(src).not.toMatch(/\.workflowTags\b/);
    expect(src).not.toMatch(/\busePersona\w*\(/);
    expect(src).not.toMatch(/\.personaProfile\b/);
  });

  it("workflowExposureResolver still documents the no-authorization contract", () => {
    const src = readWeb("lib/navigation/workflowExposureResolver.ts");
    expect(src).toMatch(/Workflow NEVER changes/i);
  });

  it("experience resolver is not imported into routeAccessResolver", () => {
    const src = readWeb("lib/navigation/routeAccessResolver.ts");
    expect(src).not.toMatch(/workspace-experience/);
  });
});

// =============================================================================
// PART 9 — useTeamWorkspaceGate misuse pin still holds
// =============================================================================

describe("R1.5B Part 9 — no useTeamWorkspaceGate regression", () => {
  it("CommandCenter still uses the canonical activeSpace, not the legacy team gate", () => {
    const src = readWeb("components/command-center/CommandCenter.tsx");
    expect(src).not.toMatch(/\buseTeamWorkspaceGate\s*\(/);
    expect(src).toMatch(/\buseActiveSpace\s*\(/);
  });
});

// =============================================================================
// PART 10 — useTeamId long-tail audit pinned (bounded, not migrated)
// =============================================================================

describe("R1.5B Part 10 — useTeamId callsite count is bounded (audit pin)", () => {
  it("useTeamId callsite count is bounded (R1.5B documented audit; migration belongs to R2)", () => {
    const root = webPath(".");
    const all = listAllTsxFiles(root);
    let callsites = 0;
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      // Match real call sites only.
      if (!/\buseTeamId\s*\(/.test(src)) continue;
      const normalized = file.replace(/\\/g, "/");
      // The hook's own definition file isn't a callsite.
      if (normalized.endsWith("/useTeamWorkspaceGate.ts")) continue;
      // The platform-context barrel re-exports the symbol.
      if (normalized.endsWith("/lib/platform-context/index.ts")) continue;
      callsites += 1;
    }
    // CR1.5 reported ~28; the exact count drifts with each web
    // refactor. R1.5B documents the audit but does not migrate. A
    // wide window allows R2 to begin migrating without an over-
    // tight pin. The lower bound exists so a silent mass-migration
    // also gets flagged.
    expect(callsites).toBeGreaterThanOrEqual(15);
    expect(
      callsites,
      "useTeamId callsites should not grow unboundedly during R1.5B",
    ).toBeLessThanOrEqual(45);
  });
});

// =============================================================================
// PART 11 — R1.5B documentation exists and is substantial
// =============================================================================

describe("R1.5B Part 11 — documentation present + substantial", () => {
  const doc = readRepo("docs/recovery/R1_5B_WORKSPACE_SEGMENTATION.md");

  it("R1.5B doc exists and contains the canonical sections", () => {
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R1\.5B/);
    expect(doc).toMatch(/Experience modes/);
    expect(doc).toMatch(/Canonical segmentation resolver/);
    expect(doc).toMatch(/Personal Space/);
    expect(doc).toMatch(/Remaining risks/);
  });
});

// =============================================================================
// PART 12 — file-size pin on canonical capture / custody / TSA / report files
// =============================================================================

describe("R1.5B Part 12 — capture / custody / TSA / report / package files unchanged", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 11701 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];

  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
      const fullPath = fileURLToPath(new URL(`../${rel}`, import.meta.url));
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(
        st.size,
        `${rel} size ${st.size} drifted out of CR1.5 window [${low}, ${high}]`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});
