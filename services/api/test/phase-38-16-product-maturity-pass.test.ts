/**
 * PHASE 38.16 — Product maturity pass source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. Capture intake progress rail — bounded 5-stage progression,
 *      workflow-aware labels, derived from session state, a11y
 *      semantics.
 *   2. Density-aware CSS on the 6 owned operational panels — CSS
 *      variables emitted for compact/comfortable/spacious modes;
 *      panels target the canonical density attribute.
 *   3. ContextualHelp component — reads resolveWorkflowHelp,
 *      dismissible + a11y-correct + density-aware; mounted on
 *      capture + dashboard surfaces.
 *   4. Source-level a11y verification on the 5 owned panels.
 *   5. Manual QA checklist documented for browser-side verification
 *      that cannot be performed without a browser.
 *   6. Copy safety locks held on newly-touched surfaces.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

const STAGES = readWeb("app/(app)/capture/_lib/captureIntakeStages.ts");
const RAIL = readWeb("app/(app)/capture/_lib/CaptureIntakeRail.tsx");
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const CONTEXTUAL_HELP = readWeb(
  "components/contextual-help/ContextualHelp.tsx",
);
const SHELL_CSS = readWeb("components/app-shell-v2/app-shell-v2.css");
const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");

// =============================================================================
// PART 1 — Capture intake progress rail
// =============================================================================

describe("Phase 38.16 — capture intake progress rail", () => {
  it("computeIntakeStages is exported with bounded 5-stage id list", () => {
    expect(STAGES).toMatch(/export function computeIntakeStages/);
    expect(STAGES).toMatch(
      /IntakeStageId\s*=\s*\n?\s*\|\s*"select_template"\s*\|\s*"add_materials"\s*\|\s*"map_context"\s*\|\s*"review_readiness"\s*\|\s*"finish"/,
    );
  });

  it("each workflow profile has a STAGE_LABELS entry", () => {
    for (const code of [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ]) {
      expect(STAGES).toMatch(new RegExp(`${code}:\\s*\\{`));
    }
  });

  it("stage completion is derived from REAL session-item fields", () => {
    // Each helper reads bounded fields the operator can see; no fake
    // intelligence, no synthesized signals.
    expect(STAGES).toMatch(/i\.privateNote/);
    expect(STAGES).toMatch(/i\.sourceLabel/);
    expect(STAGES).toMatch(/clientSignals\?\.locationIncluded/);
    expect(STAGES).toMatch(/input\.items\.length\s*>\s*0/);
    expect(STAGES).toMatch(/input\.collectionPlanSelected/);
  });

  it("output is always exactly 5 stages, in canonical order", () => {
    // The order array is the structural invariant — pinned here so a
    // future change can't silently reorder or shrink the rail.
    expect(STAGES).toMatch(
      /const\s+order:\s*IntakeStageId\[\]\s*=\s*\[\s*"select_template",\s*"add_materials",\s*"map_context",\s*"review_readiness",\s*"finish",?\s*\]/,
    );
  });

  it("operational-tone catalog — no legal/forensic labels", () => {
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bproves the truth\b/i,
      /\bauthenticity guaranteed\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(STAGES).not.toMatch(pattern);
      expect(RAIL).not.toMatch(pattern);
    }
  });
});

describe("Phase 38.16 — CaptureIntakeRail component contract", () => {
  it("renders a labelled <nav> landmark", () => {
    expect(RAIL).toMatch(/<nav\b/);
    expect(RAIL).toMatch(/aria-label="Capture intake progression"/);
  });

  it("active stage carries aria-current=\"step\"", () => {
    expect(RAIL).toMatch(
      /aria-current=\{stage\.status\s*===\s*"active"\s*\?\s*"step"\s*:\s*undefined\}/,
    );
  });

  it("emits structured data attributes per stage", () => {
    expect(RAIL).toMatch(/data-capture-intake-stage=/);
    expect(RAIL).toMatch(/data-capture-intake-stage-status=/);
    expect(RAIL).toMatch(/data-capture-intake-rail-workflow=/);
    expect(RAIL).toMatch(/data-capture-intake-rail-active-stage=/);
  });

  it("consumes density CSS variables (not hard-coded padding)", () => {
    expect(RAIL).toMatch(/var\(--proovra-density-/);
  });

  it("capture page mounts the rail with workflow + items + readiness", () => {
    expect(CAPTURE).toMatch(/CaptureIntakeRail/);
    expect(CAPTURE).toMatch(/collectionPlanSelected=\{Boolean\(selectedCollectionPlan\)\}/);
    expect(CAPTURE).toMatch(/readiness=\{computeCaptureReadiness/);
  });

  it("capture page does NOT use rail state to block finalization", () => {
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*!?rail[\s\S]{0,80}return\s+null/,
    );
    expect(CAPTURE).not.toMatch(
      /if\s*\(\s*stages[\s\S]{0,80}(disable|return null|throw)/,
    );
  });
});

// =============================================================================
// PART 2 — Density-aware CSS on owned panels
// =============================================================================

describe("Phase 38.16 — density-aware CSS for owned panels", () => {
  const PANEL_SELECTORS = [
    "data-capture-intake-rail",
    "data-capture-workflow-guidance",
    "data-capture-readiness",
    "data-capture-suggestions",
    "data-page-route-gate",
    "data-workflow-safety-notice",
    "data-command-palette",
  ];

  it("default panel CSS variables are declared", () => {
    expect(SHELL_CSS).toMatch(/--proovra-density-panel-padding/);
    expect(SHELL_CSS).toMatch(/--proovra-density-panel-gap/);
    expect(SHELL_CSS).toMatch(/--proovra-density-panel-font-size/);
    expect(SHELL_CSS).toMatch(/--proovra-density-chip-padding/);
  });

  it("compact + spacious modes override the variables", () => {
    expect(SHELL_CSS).toMatch(
      /data-operational-density="compact"\]\s*\[data-capture-intake-rail\]/,
    );
    expect(SHELL_CSS).toMatch(
      /data-operational-density="spacious"\]\s*\[data-capture-intake-rail\]/,
    );
  });

  it("each owned panel selector appears in the density block", () => {
    for (const selector of PANEL_SELECTORS) {
      expect(
        SHELL_CSS,
        `density block must target [${selector}]`,
      ).toMatch(new RegExp(`\\[${selector}\\]`));
    }
  });

  it("capture page emits the canonical data-operational-density attribute", () => {
    expect(CAPTURE).toMatch(
      /data-operational-density=\{[\s\S]{0,80}operationalDensityPreference/,
    );
  });
});

// =============================================================================
// PART 3 — ContextualHelp component contract
// =============================================================================

describe("Phase 38.16 — ContextualHelp component", () => {
  it("imports the canonical resolveWorkflowHelp helper", () => {
    expect(CONTEXTUAL_HELP).toMatch(
      /import\s*\{[\s\S]{0,200}resolveWorkflowHelp[\s\S]{0,200}\}\s*from\s*["'][^"']*platform-context["']/,
    );
  });

  it("renders a labelled region (a11y)", () => {
    expect(CONTEXTUAL_HELP).toMatch(/role="region"/);
    expect(CONTEXTUAL_HELP).toMatch(/aria-label=\{`Contextual help:/);
  });

  it("toggle has aria-expanded + aria-controls + visible label", () => {
    expect(CONTEXTUAL_HELP).toMatch(/aria-expanded=\{expanded\}/);
    expect(CONTEXTUAL_HELP).toMatch(/aria-controls=\{`contextual-help-body-/);
  });

  it("dismiss button is labelled", () => {
    expect(CONTEXTUAL_HELP).toMatch(/aria-label="Dismiss contextual help"/);
    expect(CONTEXTUAL_HELP).toMatch(/data-contextual-help-dismiss/);
  });

  it("dismiss is persisted in localStorage scoped per (workflow, surface)", () => {
    expect(CONTEXTUAL_HELP).toMatch(
      /DISMISS_KEY_PREFIX[\s\S]{0,40}workflow[\s\S]{0,40}surface/,
    );
    expect(CONTEXTUAL_HELP).toMatch(/localStorage/);
  });

  it("consumes density CSS variables (font-size + padding)", () => {
    expect(CONTEXTUAL_HELP).toMatch(/var\(--proovra-density-panel-padding/);
    expect(CONTEXTUAL_HELP).toMatch(/var\(--proovra-density-panel-font-size/);
  });

  it("renders state notes when provided + emits structured attributes", () => {
    // The <ul> carries the plural form `data-contextual-help-state-notes`;
    // each <li> carries the singular boolean form
    // `data-contextual-help-state-note` (no value, JSX-boolean style).
    expect(CONTEXTUAL_HELP).toMatch(/data-contextual-help-state-notes/);
    expect(CONTEXTUAL_HELP).toMatch(/data-contextual-help-state-note\b/);
  });

  it("operational-tone — no legal/forensic overclaim copy", () => {
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bproves the truth\b/i,
      /\bauthenticity guaranteed\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(CONTEXTUAL_HELP).not.toMatch(pattern);
    }
  });

  it("capture page mounts ContextualHelp with surface=\"capture\"", () => {
    expect(CAPTURE).toMatch(/ContextualHelp/);
    expect(CAPTURE).toMatch(/surface="capture"/);
  });

  it("CommandCenter mounts ContextualHelp with surface=\"ops\"", () => {
    expect(COMMAND_CENTER).toMatch(/ContextualHelp/);
    expect(COMMAND_CENTER).toMatch(/surface="ops"/);
  });
});

// =============================================================================
// PART 4 — Source-level a11y verification of owned panels
// =============================================================================

describe("Phase 38.16 — a11y source contract on owned panels", () => {
  const PANELS: Array<{ rel: string; name: string }> = [
    {
      rel: "app/(app)/capture/_lib/CaptureWorkflowGuidance.tsx",
      name: "CaptureWorkflowGuidance",
    },
    {
      rel: "app/(app)/capture/_lib/CaptureReadinessPanel.tsx",
      name: "CaptureReadinessPanel",
    },
    {
      rel: "app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx",
      name: "CaptureSuggestionsPanel",
    },
    {
      rel: "app/(app)/capture/_lib/CaptureIntakeRail.tsx",
      name: "CaptureIntakeRail",
    },
    {
      rel: "components/contextual-help/ContextualHelp.tsx",
      name: "ContextualHelp",
    },
  ];

  for (const panel of PANELS) {
    it(`${panel.name} has an accessible name (aria-label) on its root region`, () => {
      const src = readWeb(panel.rel);
      // Each owned panel must render either `aria-label=` on a
      // <section>/<nav> root.
      expect(src).toMatch(/aria-label=/);
    });

    it(`${panel.name} has no clickable <div> with onClick (uses <button> instead)`, () => {
      const src = readWeb(panel.rel);
      // Negative pattern: forbid `<div ... onClick={...}>` constructs.
      // <button> with onClick is fine; <div> with onClick is not.
      expect(src).not.toMatch(/<div\s[^>]*onClick=\{/);
    });
  }

  // Each panel that has a dismiss button must label it.
  const DISMISS_PANELS: Array<{ rel: string; name: string }> = [
    {
      rel: "app/(app)/capture/_lib/CaptureWorkflowGuidance.tsx",
      name: "CaptureWorkflowGuidance",
    },
    {
      rel: "app/(app)/capture/_lib/CaptureReadinessPanel.tsx",
      name: "CaptureReadinessPanel",
    },
    {
      rel: "app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx",
      name: "CaptureSuggestionsPanel",
    },
    {
      rel: "components/contextual-help/ContextualHelp.tsx",
      name: "ContextualHelp",
    },
  ];

  for (const panel of DISMISS_PANELS) {
    it(`${panel.name} dismiss button carries aria-label`, () => {
      const src = readWeb(panel.rel);
      expect(src).toMatch(/aria-label="(Dismiss|Hide) [^"]+"/);
    });
  }
});

// =============================================================================
// PART 5 — Manual QA checklist documented for browser-side verification
// =============================================================================

describe("Phase 38.16 — manual QA checklist for browser-side verification", () => {
  it("checklist file exists alongside the ContextualHelp component", () => {
    const checklistPath = webPath(
      "components/contextual-help/MANUAL_QA_CHECKLIST.md",
    );
    expect(existsSync(checklistPath), `${checklistPath} must exist`).toBe(
      true,
    );
  });

  it("checklist enumerates Responsive + Accessibility sections", () => {
    const checklist = readWeb(
      "components/contextual-help/MANUAL_QA_CHECKLIST.md",
    );
    expect(checklist).toMatch(/## Responsive/);
    expect(checklist).toMatch(/## Accessibility/);
    expect(checklist).toMatch(/Desktop|Laptop|Tablet|Mobile/);
    expect(checklist).toMatch(/Keyboard-only/);
    expect(checklist).toMatch(/Screen reader/);
  });

  it("checklist references every panel selector under verification", () => {
    const checklist = readWeb(
      "components/contextual-help/MANUAL_QA_CHECKLIST.md",
    );
    for (const sel of [
      "data-capture-intake-rail",
      "data-capture-workflow-guidance",
      "data-capture-readiness",
      "data-capture-suggestions",
      "data-contextual-help",
      "data-page-route-gate",
      "data-workflow-safety-notice",
      "data-command-palette",
    ]) {
      expect(
        checklist,
        `checklist must reference [${sel}]`,
      ).toMatch(new RegExp(sel));
    }
  });

  it("checklist refuses to claim browser-verified pass without verification", () => {
    const checklist = readWeb(
      "components/contextual-help/MANUAL_QA_CHECKLIST.md",
    );
    expect(checklist).toMatch(
      /deferred|do not claim|cannot be verified/i,
    );
  });
});

// =============================================================================
// PART 6 — Copy safety locks held on every newly-touched surface
// =============================================================================

describe("Phase 38.16 — copy safety locks", () => {
  const FILES = [
    "app/(app)/capture/_lib/captureIntakeStages.ts",
    "app/(app)/capture/_lib/CaptureIntakeRail.tsx",
    "components/contextual-help/ContextualHelp.tsx",
  ];

  const BANNED = [
    /\b(is|are|will be|guaranteed)\s+legally admissible\b/i,
    /\bauthenticity\s+(is\s+)?guaranteed\b/i,
    /\b(is|are)\s+tamper-proof\b/i,
    /\b(is|are)\s+court-ready\b/i,
    /\b(it\s+)?proves the truth\b/i,
    /"tamper-proof evidence"/i,
    /"court-ready evidence"/i,
    /"court-ready package"/i,
    /"lawyer mode"/i,
    /"journalist mode"/i,
    /"insurance mode"/i,
    /"hidden because of workflow"/i,
    /"mode-locked"/i,
  ];

  for (const file of FILES) {
    it(`${file} contains no positive overclaim copy`, () => {
      const src = readWeb(file);
      for (const pattern of BANNED) {
        expect(src, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
