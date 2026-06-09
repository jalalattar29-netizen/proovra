/**
 * PHASE R3 — Dashboard Orchestration & Workspace Focus guardrails.
 *
 * R3 added a canonical dashboard orchestration layer on TOP of the
 * existing single CommandCenter:
 *
 *   resolveWorkspaceExperience()  (R1.5B mode)
 *      ↓
 *   resolveDashboardSections()    (R3 — mode + persona ordering)
 *   resolveDashboardQuickActions  (R3 — bounded mode-aware shortcuts)
 *   resolveDashboardOnboarding    (R3 — contextual hint copy)
 *      ↓
 *   CommandCenterReady (render — one canonical dashboard)
 *
 * Hard rules pinned by this file:
 *
 *   1. Exactly one canonical dashboard component (CommandCenter.tsx).
 *   2. Orchestration layer is pure — no authorization, no fetches.
 *   3. Quick actions are bounded (≤ 4 per mode) and link to existing
 *      registered routes.
 *   4. Onboarding hints are mode-aware and operationally meaningful
 *      (no "No workspace selected" copy regressions).
 *   5. Personal mode emphasis ≠ ORG mode emphasis (the two are
 *      visibly different).
 *   6. Capture / custody / TSA / report / package files unchanged.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

const TYPES = readWeb("lib/dashboard/types.ts");
const RULES = readWeb("lib/dashboard/dashboardModeRules.ts");
const SECTIONS = readWeb("lib/dashboard/resolveDashboardSections.ts");
const QUICK = readWeb("lib/dashboard/resolveDashboardQuickActions.ts");
const ONBOARDING = readWeb("lib/dashboard/resolveDashboardOnboarding.ts");
const QUICK_COMPONENT = readWeb(
  "components/command-center/CommandCenterQuickActions.tsx",
);
const CC = readWeb("components/command-center/CommandCenter.tsx");

// =============================================================================
// PART 1 — Canonical orchestration layer exists, pure, no auth
// =============================================================================

describe("R3 Part 1 — canonical dashboard orchestrator", () => {
  it("exports the four canonical resolvers from lib/dashboard", () => {
    const barrel = readWeb("lib/dashboard/index.ts");
    expect(barrel).toMatch(/resolveDashboardSections/);
    expect(barrel).toMatch(/resolveDashboardQuickActions/);
    expect(barrel).toMatch(/resolveDashboardOnboarding/);
    expect(barrel).toMatch(/MODE_SECTION_PRIORITY/);
  });

  it("orchestration resolvers carry NO authorization logic", () => {
    // Code-context regex (header comments may mention these symbols).
    for (const src of [SECTIONS, QUICK, ONBOARDING, RULES]) {
      expect(src).not.toMatch(/\.requiredCapabilities\b/);
      expect(src).not.toMatch(/\.canLoad\b/);
      expect(src).not.toMatch(/\.canSeeNav\b/);
      expect(src).not.toMatch(/\bauthorize\s*\(/);
    }
  });

  it("orchestration resolvers are pure (no fetches, no async)", () => {
    for (const src of [SECTIONS, QUICK, ONBOARDING]) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/\bapiFetch\(/);
      expect(src).not.toMatch(/\basync\b/);
      expect(src).not.toMatch(/\bawait\b/);
    }
  });
});

// =============================================================================
// PART 2 — Personal Space orchestration emphasis
// =============================================================================

describe("R3 Part 2 — personal mode emphasizes quick/operational workflows", () => {
  it("PERSONAL section priority leads with summary + recentEvidence + caseOperations", () => {
    expect(RULES).toMatch(
      /PERSONAL:\s*\[\s*"summary",\s*"recentEvidence",\s*"caseOperations"/,
    );
  });

  it("PERSONAL quick actions are bounded + operational (capture, evidence, reports)", () => {
    // Anchor specifically on MODE_QUICK_ACTIONS — there is also a
    // PERSONAL key under MODE_SECTION_PRIORITY (section ids only,
    // no hrefs), so the regex must scope to the quick-actions map.
    const qaBlock = RULES.match(
      /MODE_QUICK_ACTIONS[\s\S]*?PERSONAL:\s*\[([\s\S]*?)\],\s*ORGANIZATION:/,
    );
    expect(qaBlock).toBeTruthy();
    const block = qaBlock![1];
    expect(block).toMatch(/"\/capture"/);
    expect(block).toMatch(/"\/evidence"/);
    expect(block).toMatch(/"\/reports"/);
    // Bounded — count action ids (each has the `personal.` prefix).
    const idCount = (block.match(/\bid:\s*"personal\./g) ?? []).length;
    expect(idCount).toBeGreaterThanOrEqual(2);
    expect(idCount).toBeLessThanOrEqual(4);
  });

  it("PERSONAL onboarding hint points at capture (operationally meaningful)", () => {
    expect(RULES).toMatch(
      /PERSONAL:\s*\{[\s\S]{0,200}href:\s*"\/capture"/,
    );
    expect(RULES).toMatch(/Create your first evidence record/);
  });
});

// =============================================================================
// PART 3 — Organization orchestration emphasis
// =============================================================================

describe("R3 Part 3 — organization mode emphasizes operational queues", () => {
  it("ORGANIZATION section priority leads with operationalPressure + caseOperations + reviewerOrchestration", () => {
    expect(RULES).toMatch(
      /ORGANIZATION:\s*\[\s*"operationalPressure",\s*"caseOperations",\s*"reviewerOrchestration"/,
    );
  });

  it("ORGANIZATION quick actions emphasize reviewer + intake operations", () => {
    // Same anchor pattern as the PERSONAL block — MODE_QUICK_ACTIONS
    // scope only. Phase Final-Vocab-Alignment retired `/reviewer-ops`
    // (the legacy queue index) and made `/review` the canonical
    // reviewer console; quick action hrefs follow that move. The
    // escalations sub-route remains at `/reviewer-ops/escalations`.
    const qaBlock = RULES.match(
      /MODE_QUICK_ACTIONS[\s\S]*?ORGANIZATION:\s*\[([\s\S]*?)\],\s*REVIEW_OPS:/,
    );
    expect(qaBlock).toBeTruthy();
    const block = qaBlock![1];
    expect(block).toMatch(/"\/review"/);
    expect(block).toMatch(/"\/reviewer-ops\/escalations"/);
    expect(block).toMatch(/"\/intake-links"/);
    const idCount = (block.match(/\bid:\s*"org\./g) ?? []).length;
    expect(idCount).toBeGreaterThanOrEqual(2);
    expect(idCount).toBeLessThanOrEqual(4);
  });
});

// =============================================================================
// PART 4 — REVIEW_OPS + GOVERNANCE contextual emphasis (no separate dashboards)
// =============================================================================

describe("R3 Part 4 — REVIEW_OPS + GOVERNANCE contexts are emphasis-only, not new dashboards", () => {
  it("REVIEW_OPS section priority leads with reviewerOrchestration + queueCongestion", () => {
    expect(RULES).toMatch(
      /REVIEW_OPS:\s*\[\s*"reviewerOrchestration",\s*"operationalPressure",\s*"queueCongestion"/,
    );
  });

  it("GOVERNANCE section priority leads with governancePosture + auditReadiness", () => {
    expect(RULES).toMatch(
      /GOVERNANCE:\s*\[\s*"governancePosture",\s*"auditReadiness"/,
    );
  });

  it("no separate ReviewerDashboard or GovernanceDashboard component was created", () => {
    const root = webPath("components");
    function listAllFiles(dirAbs: string): string[] {
      const out: string[] = [];
      const stack: string[] = [dirAbs];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = `${dir}/${name}`;
          try {
            const st = statSync(full);
            if (st.isFile() && /\.tsx?$/.test(name)) out.push(full);
            else if (st.isDirectory()) stack.push(full);
          } catch {
            /* ignore */
          }
        }
      }
      return out;
    }
    const all = listAllFiles(root);
    const FORBIDDEN = [
      "PersonalCommandCenter.tsx",
      "OrgCommandCenter.tsx",
      "ReviewerCommandCenter.tsx",
      "GovernanceCommandCenter.tsx",
      "PersonalDashboard.tsx",
      "ReviewerDashboard.tsx",
      "GovernanceDashboard.tsx",
    ];
    for (const file of all) {
      const name = file.split(/[\\/]/).pop()!;
      expect(
        FORBIDDEN.includes(name),
        `R3 forbids per-mode dashboard component forks — found ${name}`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// PART 5 — Onboarding / empty-state recovery (no "No workspace selected")
// =============================================================================

describe("R3 Part 5 — onboarding hints are mode-aware + operationally meaningful", () => {
  it("every mode has a bounded onboarding hint with a real href", () => {
    for (const mode of ["PERSONAL", "ORGANIZATION", "REVIEW_OPS", "GOVERNANCE"]) {
      const hintMatch = RULES.match(
        new RegExp(
          `${mode}:\\s*\\{[\\s\\S]{0,300}href:\\s*"([^"]+)"`,
        ),
      );
      expect(hintMatch, `${mode} onboarding hint must have an href`).toBeTruthy();
      expect(hintMatch![1]).toMatch(/^\//);
    }
  });

  it("no onboarding hint contains 'No workspace selected' regression copy", () => {
    expect(RULES).not.toMatch(/No workspace selected/i);
  });

  it("CommandCenter renders the onboarding hint conditionally (not constantly)", () => {
    // The hint must be guarded by `onboardingHint ?` so completed
    // onboarding doesn't render empty / leftover hints.
    expect(CC).toMatch(/onboardingHint\s*\?/);
    expect(CC).toMatch(/data-cc-onboarding-hint/);
  });
});

// =============================================================================
// PART 6 — Dashboard section hierarchy bounded
// =============================================================================

describe("R3 Part 6 — bounded section hierarchy + emphasis labels", () => {
  it("orchestrator emits per-section emphasis (primary / secondary / de-emphasized)", () => {
    expect(SECTIONS).toMatch(/emphasis:\s*"primary"/);
    expect(SECTIONS).toMatch(/emphasis:\s*"secondary"/);
    expect(SECTIONS).toMatch(/emphasis:\s*"de-emphasized"/);
  });

  it("orchestrator NEVER removes sections (only reorders + labels)", () => {
    // The contract is documented in the resolver header; we pin the
    // structural guarantee: every available section id ends up in
    // the output (the third loop appends every claim-less id).
    expect(SECTIONS).toMatch(/for \(const id of input\.availableSectionIds\)/);
    expect(SECTIONS).toMatch(/de-emphasized/);
  });
});

// =============================================================================
// PART 7 — Quick actions bounded + reference existing routes
// =============================================================================

describe("R3 Part 7 — quick actions bounded + reference registered routes", () => {
  it("QUICK_ACTIONS_MAX_PER_MODE bounds the quick-action count", () => {
    expect(QUICK).toMatch(/QUICK_ACTIONS_MAX_PER_MODE\s*=\s*4/);
  });

  it("every quick action href is a registered route", () => {
    // Extract all `href: "..."` literals from the rules + verify
    // each one matches an existing route in routeRegistry.ts.
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    const hrefs = Array.from(RULES.matchAll(/href:\s*"([^"]+)"/g)).map(
      (m) => m[1],
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(
        registry.includes(`href: "${href}"`) ||
          registry.includes(`"${href}"`),
        `quick action href ${href} must be a registered route in routeRegistry.ts`,
      ).toBe(true);
    }
  });

  it("CommandCenterQuickActions component is a thin presentation wrapper (no auth)", () => {
    expect(QUICK_COMPONENT).not.toMatch(/\bauthorize\s*\(/);
    expect(QUICK_COMPONENT).not.toMatch(/usePlatformContext/);
    expect(QUICK_COMPONENT).not.toMatch(/\bapiFetch\(/);
    expect(QUICK_COMPONENT).toMatch(/data-cc-quick-actions/);
  });
});

// =============================================================================
// PART 8 — Dashboard / navigation coherence (consume same experience mode)
// =============================================================================

describe("R3 Part 8 — dashboard and navigation read the same experience mode", () => {
  it("CommandCenter uses resolveDashboardSections + resolveDashboardQuickActions + resolveDashboardOnboarding", () => {
    expect(CC).toMatch(/resolveDashboardSections/);
    expect(CC).toMatch(/resolveDashboardQuickActions/);
    expect(CC).toMatch(/resolveDashboardOnboarding/);
  });

  it("CommandCenter mounts the quick-actions component", () => {
    expect(CC).toMatch(/<CommandCenterQuickActions\b/);
  });

  it("CommandCenter consumes the same workspace-experience helper the sidebar uses", () => {
    const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(CC).toMatch(/resolveWorkspaceExperience/);
    expect(sidebar).toMatch(/resolveWorkspaceExperience/);
  });
});

// =============================================================================
// PART 9 — Observability extension
// =============================================================================

describe("R3 Part 9 — observability vocabulary extended", () => {
  const obs = readWeb("lib/platform-context/state-observability.ts");

  it("STATE_OBSERVABILITY_EVENTS includes the R3 events", () => {
    expect(obs).toMatch(/"dashboard-sections:resolved"/);
    expect(obs).toMatch(/"dashboard-priority:resolved"/);
    expect(obs).toMatch(/"dashboard-quick-actions:resolved"/);
  });

  it("CommandCenter emits the R3 events", () => {
    expect(CC).toMatch(/dashboard-sections:resolved/);
    expect(CC).toMatch(/dashboard-priority:resolved/);
    expect(CC).toMatch(/dashboard-quick-actions:resolved/);
  });
});

// =============================================================================
// PART 10 — Single canonical dashboard system + no regression
// =============================================================================

describe("R3 Part 10 — single canonical dashboard system", () => {
  it("exactly one CommandCenter component file exists", () => {
    const root = webPath("components/command-center");
    const files = readdirSync(root).filter(
      (n) => /^CommandCenter\.tsx?$/.test(n),
    );
    expect(files).toEqual(["CommandCenter.tsx"]);
  });

  it("workflow/persona authorization regression sweep (no new auth predicates in orchestration)", () => {
    for (const src of [SECTIONS, QUICK, ONBOARDING, RULES, TYPES]) {
      expect(src).not.toMatch(/\bauthorize\s*\(/);
      expect(src).not.toMatch(/requiredCapabilities/);
    }
  });

  it("CommandCenter still consumes the backend envelope (no API fork)", () => {
    expect(CC).toMatch(/\/v1\/dashboard\/command-center/);
  });
});

// =============================================================================
// PART 11 — Documentation present
// =============================================================================

describe("R3 Part 11 — documentation present + substantial", () => {
  const doc = readRepo("docs/recovery/R3_DASHBOARD_ORCHESTRATION.md");

  it("R3 doc exists and covers the required sections", () => {
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R3/);
    expect(doc).toMatch(/orchestration philosophy/i);
    expect(doc).toMatch(/Quick action/i);
    expect(doc).toMatch(/Remaining risks/);
  });
});

// =============================================================================
// PART 12 — Capture / custody / TSA / report / package unchanged
// =============================================================================

describe("R3 Part 12 — canonical capture/custody/TSA/report files unchanged", () => {
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
        `${rel} size ${st.size} drifted out of window [${low}, ${high}]`,
      ).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});
