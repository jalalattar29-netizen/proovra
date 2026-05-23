/**
 * PHASE 38.4 — Final consumption source-contract + behavioral tests.
 *
 * Covers:
 *   1. HintCallout component contract (gating, dismissal, never blocks)
 *   2. Reports page mounts the HintCallout
 *   3. Density CSS rules exist for all three modes
 *   4. workflowHelp library returns complete shape for every
 *      (workflow, surface) pair + no legal overclaim language
 *   5. Persona / workflow surfaces remain UX-only
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

const HINT = readWeb("components/persona/HintCallout.tsx");
const REPORTS = readWeb("components/reports-experience/ReportsIndex.tsx");
const SHELL_CSS = readWeb("components/app-shell-v2/app-shell-v2.css");
const HELP_LIB = readWeb("lib/platform-context/workflowHelp.ts");
const INDEX = readWeb("lib/platform-context/index.ts");

// =============================================================================
// PART 1 — HintCallout contract
// =============================================================================

describe("Phase 38.4 — HintCallout component", () => {
  it("reads the hint from the canonical resolver (no inline copy)", () => {
    expect(HINT).toMatch(/resolvePersonaHint/);
    expect(HINT).toMatch(/usePersonaProfile/);
  });

  it("gates rendering on the hint's capabilityKey via useCan (never bypasses)", () => {
    expect(HINT).toMatch(/useCan\(/);
    expect(HINT).toMatch(/if \(hint\.capabilityKey && !canSeeHintTarget\)/);
  });

  it("returns null when no hint exists (no empty callout)", () => {
    expect(HINT).toMatch(/if \(!hint\) return null/);
  });

  it("dismissal persists in localStorage per hint id", () => {
    expect(HINT).toMatch(/STORAGE_PREFIX\s*=\s*"proovra\.persona-hint\.dismissed:"/);
    expect(HINT).toMatch(/window\.localStorage\.setItem/);
    expect(HINT).toMatch(/window\.localStorage\.getItem/);
  });

  it("exposes data attributes for tests + debugging", () => {
    expect(HINT).toMatch(/data-persona-hint\b/);
    expect(HINT).toMatch(/data-persona-hint-id/);
    expect(HINT).toMatch(/data-persona-hint-surface/);
    expect(HINT).toMatch(/data-persona-hint-headline/);
    expect(HINT).toMatch(/data-persona-hint-cta/);
    expect(HINT).toMatch(/data-persona-hint-dismiss/);
  });

  it("dismiss button has accessible name", () => {
    expect(HINT).toMatch(/aria-label="Dismiss hint"/);
  });
});

// =============================================================================
// PART 2 — Reports page wires the HintCallout
// =============================================================================

describe("Phase 38.4 — Reports page mounts HintCallout", () => {
  it("imports the HintCallout component", () => {
    expect(REPORTS).toMatch(/import \{ HintCallout \}/);
  });

  it("renders <HintCallout surface=\"reports\" /> in the page", () => {
    expect(REPORTS).toMatch(/<HintCallout surface="reports"\s*\/>/);
  });
});

// =============================================================================
// PART 3 — Density CSS rules
// =============================================================================

describe("Phase 38.4 — operational density CSS rules", () => {
  it("declares CSS variables for all three modes", () => {
    expect(SHELL_CSS).toMatch(
      /\.app-shell-v2\[data-operational-density="comfortable"\]/,
    );
    expect(SHELL_CSS).toMatch(
      /\.app-shell-v2\[data-operational-density="compact"\]/,
    );
    expect(SHELL_CSS).toMatch(
      /\.app-shell-v2\[data-operational-density="spacious"\]/,
    );
  });

  it("compact mode tightens row + section + tile spacing", () => {
    expect(SHELL_CSS).toMatch(/--proovra-density-row-padding-y:\s*6px/);
    expect(SHELL_CSS).toMatch(/--proovra-density-section-gap:\s*12px/);
  });

  it("spacious mode generously increases spacing", () => {
    expect(SHELL_CSS).toMatch(/--proovra-density-row-padding-y:\s*14px/);
    expect(SHELL_CSS).toMatch(/--proovra-density-section-gap:\s*36px/);
  });

  it("density CSS NEVER hides features (no display:none or visibility:hidden in density blocks)", () => {
    // Extract the density rules block and assert no hiding directives.
    const idx = SHELL_CSS.indexOf("PHASE 38.4 — Operational density CSS");
    expect(idx).toBeGreaterThan(0);
    const block = SHELL_CSS.slice(idx);
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility:\s*hidden/);
  });
});

// =============================================================================
// PART 4 — Workflow help library
// =============================================================================

describe("Phase 38.4 — workflowHelp library", () => {
  it("exports resolveWorkflowHelp + types", () => {
    expect(INDEX).toMatch(/resolveWorkflowHelp/);
    expect(INDEX).toMatch(/HelpSurface/);
    expect(INDEX).toMatch(/WorkflowHelpEntry/);
  });

  it("returns a complete entry for every (workflow, surface) pair", async () => {
    const { resolveWorkflowHelp } = await import(
      "../../../apps/web/lib/platform-context/workflowHelp.js"
    );
    const workflows = [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ] as const;
    const surfaces = [
      "capture",
      "evidence",
      "cases",
      "reports",
      "governance",
      "reviewer-ops",
      "ops",
    ] as const;
    for (const workflow of workflows) {
      for (const surface of surfaces) {
        const entry = resolveWorkflowHelp({ workflow, surface });
        expect(entry.title.length).toBeGreaterThan(0);
        expect(entry.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("LAWYER cases help uses 'Matter' framing", async () => {
    const { resolveWorkflowHelp } = await import(
      "../../../apps/web/lib/platform-context/workflowHelp.js"
    );
    const help = resolveWorkflowHelp({
      workflow: "LEGAL_CASEWORK",
      surface: "cases",
    });
    expect(help.title.toLowerCase()).toContain("matter");
  });

  it("REVIEW_OPERATIONS reviewer-ops help mentions queues + SLA", async () => {
    const { resolveWorkflowHelp } = await import(
      "../../../apps/web/lib/platform-context/workflowHelp.js"
    );
    const help = resolveWorkflowHelp({
      workflow: "REVIEW_OPERATIONS",
      surface: "reviewer-ops",
    });
    expect(help.body.toLowerCase()).toMatch(/queue|sla/);
  });

  it("contains NO legal overclaim language across any entry", async () => {
    const { resolveWorkflowHelp } = await import(
      "../../../apps/web/lib/platform-context/workflowHelp.js"
    );
    // Banned language patterns. NOTE: the canonical product disclaimer
    // "do not assert legal admissibility, authenticity, or 'court-ready'
    // status" deliberately uses the phrase "court-ready" inside a
    // NEGATION — that's the canonical anti-overclaim language. We only
    // catch positive overclaim phrases.
    const banned = [
      /guaranteed admissible/i,
      /100%\s*verified/i,
      /legally binding/i,
      /provably authentic/i,
      /\bis\s+court[-\s]?ready/i,
      /\bare\s+court[-\s]?ready/i,
    ];
    const workflows = [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ] as const;
    const surfaces = [
      "capture",
      "evidence",
      "cases",
      "reports",
      "governance",
      "reviewer-ops",
      "ops",
    ] as const;
    for (const workflow of workflows) {
      for (const surface of surfaces) {
        const entry = resolveWorkflowHelp({ workflow, surface });
        for (const pattern of banned) {
          expect(
            pattern.test(entry.title) || pattern.test(entry.body),
            `Banned language ${pattern} found in ${workflow}/${surface}`,
          ).toBe(false);
        }
      }
    }
  });

  it("help library is pure (no fetch, no platform-context, no auth)", () => {
    expect(HELP_LIB).not.toMatch(/apiFetch|fetch\(/);
    expect(HELP_LIB).not.toMatch(/usePlatformContext|useCan|authorize/);
  });
});

// =============================================================================
// PART 5 — Persona / workflow stays UX-only
// =============================================================================

describe("Phase 38.4 — persona/workflow remains UX-only", () => {
  it("HintCallout uses useCan to GATE render — never to grant a feature", () => {
    // Pattern: `if (hint.capabilityKey && !canSeeHintTarget) return null;`
    expect(HINT).toMatch(/if \(hint\.capabilityKey && !canSeeHintTarget\) return null/);
  });

  it("workflow help library makes no capability decisions", () => {
    expect(HELP_LIB).not.toMatch(/useCan\(/);
    expect(HELP_LIB).not.toMatch(/capabilities\?\.\w+/);
  });
});
