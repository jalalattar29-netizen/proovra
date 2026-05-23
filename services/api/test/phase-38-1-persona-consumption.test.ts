/**
 * PHASE 38.1 — Persona consumption source-contract tests.
 *
 * Covers:
 *   1. First-login banner — renders only when persona is incomplete;
 *      never blocks the app; localStorage dismissal per workspace.
 *   2. Sidebar More/Advanced — splitByPersona is a pure partition;
 *      sidebar renders priority items + collapsed More disclosure.
 *   3. Cases page consumes useTerminology() for the title kicker.
 *   4. Reports empty-state consumes resolvePersonaEmptyState().
 *   5. Persona stays UX-only — none of the consumption surfaces gate
 *      features by persona.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const BANNER = readWeb("components/app-shell-v2/PersonaSetupBanner.tsx");
const SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");
const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const SPLIT_HELPER = readWeb("lib/platform-context/personaPriorityOrder.ts");
const INDEX = readWeb("lib/platform-context/index.ts");
const CASES = readWeb("components/cases-experience/CasesIndex.tsx");
const REPORTS = readWeb("components/reports-experience/ReportsIndex.tsx");

// =============================================================================
// PART 1 — First-login banner
// =============================================================================

describe("Phase 38.1 — persona setup banner", () => {
  it("renders only when the persona profile is incomplete", () => {
    // Banner only renders when source==="default" OR onboardingCompleted===false.
    expect(BANNER).toMatch(
      /persona\.source\s*===\s*"default"\s*\|\|\s*persona\.onboardingCompleted\s*===\s*false/,
    );
  });

  it("is dismissible per workspace via localStorage", () => {
    expect(BANNER).toMatch(/STORAGE_PREFIX\s*=\s*"proovra\.persona-banner\.dismissed-for-team:"/);
    expect(BANNER).toMatch(/window\.localStorage\.setItem/);
    expect(BANNER).toMatch(/window\.localStorage\.getItem/);
  });

  it("links to the canonical setup destination (/settings/persona)", () => {
    expect(BANNER).toMatch(/href="\/settings\/persona"/);
    expect(BANNER).toMatch(/data-persona-setup-banner-cta\b/);
  });

  it("exposes data attributes for tests + analytics-free debugging", () => {
    expect(BANNER).toMatch(/data-persona-setup-banner\b/);
    expect(BANNER).toMatch(/data-persona-source/);
    expect(BANNER).toMatch(/data-persona-onboarding-completed/);
    expect(BANNER).toMatch(/data-persona-setup-banner-dismiss\b/);
  });

  it("never makes a fetch / API call (reads from canonical envelope only)", () => {
    expect(BANNER).not.toMatch(/apiFetch|fetch\(/);
    expect(BANNER).toMatch(/usePersonaProfile/);
    expect(BANNER).toMatch(/useActiveSpace/);
  });

  it("AppShellV2 mounts the banner under the topbar", () => {
    expect(SHELL).toMatch(/PersonaSetupBanner/);
    expect(SHELL).toMatch(/<PersonaSetupBanner\s*\/>/);
  });
});

// =============================================================================
// PART 2 — Sidebar More/Advanced
// =============================================================================

describe("Phase 38.1 — sidebar More/Advanced", () => {
  it("exports splitByPersona from the platform-context index", () => {
    expect(INDEX).toMatch(/splitByPersona/);
  });

  it("splitByPersona is a pure partition (priority + more) — pinned in source", () => {
    expect(SPLIT_HELPER).toMatch(/export function splitByPersona/);
    expect(SPLIT_HELPER).toMatch(/return\s*\{\s*priority:[\s\S]{0,40}more:/);
  });

  it("INDIVIDUAL renders every item as priority (no demotion by default)", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/personaPriorityOrder.js"
    );
    const items = [
      { id: "workspace.home" },
      { id: "governance.lifecycle" },
      { id: "platform.ops_center" },
    ];
    const { priority, more } = mod.splitByPersona(items, "INDIVIDUAL");
    expect(priority).toHaveLength(3);
    expect(more).toHaveLength(0);
  });

  it("LAWYER promotes case-priority items and demotes the rest into More", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/personaPriorityOrder.js"
    );
    const items = [
      { id: "workspace.home" },
      { id: "workspace.capture" },
      { id: "workspace.cases" },
      { id: "platform.ops_center" },
      { id: "governance.hub" },
    ];
    const { priority, more } = mod.splitByPersona(items, "LAWYER");
    // cases + governance match LAWYER's priority list; the rest land in more.
    const priorityIds = priority.map((i) => i.id);
    expect(priorityIds).toContain("workspace.cases");
    expect(priorityIds).toContain("governance.hub");
    const moreIds = more.map((i) => i.id);
    expect(moreIds).toContain("workspace.home");
    expect(moreIds).toContain("platform.ops_center");
    expect(priority.length + more.length).toBe(items.length);
  });

  it("AppSidebarV2 consumes the persona/workflow priority partition + renders the More disclosure", () => {
    // Phase 38.9 — the sidebar moved to the canonical
    // `resolveWorkflowExposure` (strict superset of splitByPersona).
    // The More/Advanced disclosure is preserved.
    expect(SIDEBAR).toMatch(/splitByPersona|resolveWorkflowExposure/);
    expect(SIDEBAR).toMatch(/moreAdvancedItems|split\.more/);
    expect(SIDEBAR).toMatch(/data-sidebar-more-toggle/);
    // Phase 38.9 — the attribute is set conditionally for items in
    // the More disclosure (JSX expression form), or as a literal
    // attribute in the legacy form. Either is acceptable.
    expect(SIDEBAR).toMatch(
      /data-sidebar-nav-more=(?:"true"|\{inMore[^}]*\})/,
    );
  });

  it("More disclosure is keyboard-accessible (aria-expanded)", () => {
    // Phase 38.9 — local var renamed inside the SidebarMoreView
    // component; the aria-expanded attribute is still wired to the
    // disclosure-open state.
    expect(SIDEBAR).toMatch(/aria-expanded=\{(moreOpen|open)\}/);
  });

  it("More disclosure NEVER hides items — capabilities remain authoritative", () => {
    // Items in `moreItems` are still rendered (when expanded). The
    // pure-function partition guarantees the count is preserved.
    expect(SPLIT_HELPER).toMatch(
      /priority\.length\s*\+\s*more\.length\s*===\s*items\.length|items\.filter\(\(item\) => !claimed\.has\(item\.id\)\)/,
    );
  });
});

// =============================================================================
// PART 3 — Cases page terminology consumption
// =============================================================================

describe("Phase 38.1 — Cases page consumes terminology", () => {
  it("imports useTerminology from the canonical platform-context module", () => {
    expect(CASES).toMatch(/useTerminology/);
  });

  it("renders the kicker + title via terminology (Case → Matter / Claim / Investigation)", () => {
    expect(CASES).toMatch(/data-cases-kicker/);
    expect(CASES).toMatch(/data-cases-title/);
    // The title uses casePlural so it adapts.
    expect(CASES).toMatch(/\{terms\.casePlural\}/);
  });

  it("does NOT use terminology to gate behavior (capabilities still authoritative)", () => {
    // The page still calls useTeamId/useTeamWorkspaceGate (canonical
    // access gates). The terminology hook is additive presentation.
    expect(CASES).toMatch(/useTeamId/);
    // No persona-based capability check.
    expect(CASES).not.toMatch(/primaryProfile\s*===\s*"[A-Z]+"\s*\?/);
  });
});

// =============================================================================
// PART 4 — Reports empty-state consumption
// =============================================================================

describe("Phase 38.1 — Reports empty state consumes persona library", () => {
  it("imports resolvePersonaEmptyState + usePersonaProfile", () => {
    expect(REPORTS).toMatch(/resolvePersonaEmptyState/);
    expect(REPORTS).toMatch(/usePersonaProfile/);
  });

  it("ReportsEmptyState calls the resolver with surface='reports'", () => {
    expect(REPORTS).toMatch(/resolvePersonaEmptyState\(/);
    expect(REPORTS).toMatch(/persona:\s*persona\.primaryProfile/);
    expect(REPORTS).toMatch(/surface:\s*"reports"/);
  });

  it("renders title, body, and primary CTA from the resolved state", () => {
    expect(REPORTS).toMatch(/\{state\.title\}/);
    expect(REPORTS).toMatch(/\{state\.body\}/);
    expect(REPORTS).toMatch(/\{state\.primaryCtaLabel\}/);
    expect(REPORTS).toMatch(/href=\{state\.primaryCtaHref\}/);
  });

  it("exposes data attribute for the active persona", () => {
    expect(REPORTS).toMatch(/data-persona-empty-state-persona/);
  });
});

// =============================================================================
// PART 5 — Persona stays UX-only across the consumption surfaces
// =============================================================================

describe("Phase 38.1 — consumption surfaces never gate features by persona", () => {
  it("Cases page does not branch on persona to hide a feature", () => {
    expect(CASES).not.toMatch(/persona\s*===\s*"LAWYER"\s*\?\s*null/);
    expect(CASES).not.toMatch(/persona\s*===\s*"INDIVIDUAL"\s*\?\s*null/);
  });

  it("Reports page does not branch on persona to hide a feature", () => {
    expect(REPORTS).not.toMatch(/persona\s*===\s*"LAWYER"\s*\?\s*null/);
    expect(REPORTS).not.toMatch(/persona\s*===\s*"INDIVIDUAL"\s*\?\s*null/);
  });

  it("Banner never blocks the app (always dismissible)", () => {
    expect(BANNER).toMatch(/handleDismiss/);
    expect(BANNER).toMatch(/setDismissed\(true\)/);
  });
});
