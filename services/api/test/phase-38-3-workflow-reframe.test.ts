/**
 * PHASE 38.3 — Workflow-oriented profile reframe.
 *
 * Covers:
 *   1. Workflow profile mapping is bijective with the persona enum
 *   2. Workflow descriptors are bounded + non-profession-locking
 *   3. Onboarding wizard renders workflow labels/descriptions
 *   4. Topbar persona chip renders the workflow label (not the raw enum)
 *   5. Setup banner copy is workflow-oriented (no profession language)
 *   6. suggestWorkflow pure-function correctness
 *   7. Capability registry remains untouched (workflow stays UX-only)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PERSONA_PROFILES,
} from "../src/services/platform-context/types.js";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const WORKFLOW = readWeb("lib/platform-context/workflowProfile.ts");
const SUGGEST = readWeb("lib/platform-context/workflowSuggestion.ts");
const INDEX = readWeb("lib/platform-context/index.ts");
const WIZARD = readWeb("app/(app)/settings/persona/page.tsx");
const TOPBAR = readWeb("components/app-shell-v2/AppTopbarV2.tsx");
const BANNER = readWeb("components/app-shell-v2/PersonaSetupBanner.tsx");

// =============================================================================
// PART 1 — Workflow mapping bijective with persona enum
// =============================================================================

describe("Phase 38.3 — workflow profile mapping", () => {
  it("declares the 7 canonical workflow codes", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    expect(mod.WORKFLOW_PROFILE_CODES).toEqual([
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ]);
  });

  it("every internal persona maps to exactly one workflow descriptor", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    for (const persona of WORKSPACE_PERSONA_PROFILES) {
      const desc = mod.workflowFromPersona(persona);
      expect(desc.persona).toBe(persona);
      expect(desc.code.length).toBeGreaterThan(0);
      expect(desc.label.length).toBeGreaterThan(0);
      expect(desc.description.length).toBeGreaterThan(0);
    }
  });

  it("every workflow code maps back to exactly one persona", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    for (const code of mod.WORKFLOW_PROFILE_CODES) {
      const desc = mod.workflowFromCode(code);
      expect(desc.code).toBe(code);
    }
  });

  it("listWorkflowDescriptors returns all 7 descriptors in canonical order", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    const list = mod.listWorkflowDescriptors();
    expect(list).toHaveLength(7);
    expect(list[0].code).toBe("VERIFICATION_DOCUMENTATION");
  });
});

// =============================================================================
// PART 2 — Workflow descriptors are non-profession-locking
// =============================================================================

describe("Phase 38.3 — workflow labels are workflow-oriented, not profession-locked", () => {
  it("workflow labels reference WORKFLOWS, not job titles", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    const labels = mod.listWorkflowDescriptors().map((d) => d.label);
    // Anti-pattern: a label like "Lawyer" / "Journalist" would lock the
    // product into a profession. The canonical labels speak in workflow
    // terms.
    for (const label of labels) {
      expect(/^Lawyer$/i.test(label)).toBe(false);
      expect(/^Journalist$/i.test(label)).toBe(false);
      expect(/^Insurance$/i.test(label)).toBe(false);
      expect(/^Investigator$/i.test(label)).toBe(false);
    }
    // Positive: at least one label references the "Workflows" wording
    // to anchor the workflow-oriented framing.
    const concat = labels.join(" | ").toLowerCase();
    expect(concat).toContain("workflow");
  });

  it("workflow descriptions speak operationally (no 'for lawyers' phrasing)", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowProfile.js"
    );
    for (const desc of mod.listWorkflowDescriptors()) {
      expect(/for lawyers/i.test(desc.description)).toBe(false);
      expect(/for journalists/i.test(desc.description)).toBe(false);
      expect(/for insurance companies/i.test(desc.description)).toBe(false);
      expect(/for investigators/i.test(desc.description)).toBe(false);
    }
  });
});

// =============================================================================
// PART 3 — Onboarding wizard renders workflow-oriented copy
// =============================================================================

describe("Phase 38.3 — onboarding wizard wording", () => {
  it("imports workflowFromPersona for label resolution", () => {
    expect(WIZARD).toMatch(/workflowFromPersona/);
    expect(WIZARD).toMatch(/function workflowLabel\(/);
    expect(WIZARD).toMatch(/function workflowDescription\(/);
  });

  it("primary-workflow step asks about workflows, not profession", () => {
    expect(WIZARD).toMatch(
      /What workflows are most important to your work\?/,
    );
    // Sanity: no "Are you a lawyer?" style phrasing.
    expect(WIZARD).not.toMatch(/Are you a lawyer/i);
    expect(WIZARD).not.toMatch(/Are you a journalist/i);
  });

  it("headline + subheadline use the canonical workflow framing", () => {
    expect(WIZARD).toMatch(/How will you use PROOVRA\?/);
    expect(WIZARD).toMatch(
      /Configure workflows, operational priorities, and workspace/,
    );
  });

  it("secondary-options heading is workflow-oriented (not 'use-cases')", () => {
    expect(WIZARD).toMatch(/Secondary workflows/);
  });

  it("does NOT contain the old hardcoded profession label map", () => {
    expect(WIZARD).not.toMatch(/PERSONA_LABEL:\s*Record/);
    expect(WIZARD).not.toMatch(/PERSONA_DESCRIPTION:\s*Record/);
  });
});

// =============================================================================
// PART 4 — Topbar persona chip uses workflow label
// =============================================================================

describe("Phase 38.3 — topbar workflow chip", () => {
  it("topbar imports workflowFromPersona", () => {
    expect(TOPBAR).toMatch(/workflowFromPersona/);
  });

  it("topbar renders the workflow label (not the raw persona enum code)", () => {
    // The chip's text content comes from `wf.label`, not the raw enum.
    expect(TOPBAR).toMatch(/data-app-topbar-workflow=\{wf\.code\}/);
    expect(TOPBAR).toMatch(/title=\{`Workflow profile: \$\{wf\.label\}`\}/);
    // The legacy raw-enum `replace(/_/g, " ")` rendering is gone.
    expect(TOPBAR).not.toMatch(/primaryProfile\.replace\(\/_\/g/);
  });
});

// =============================================================================
// PART 5 — Setup banner is workflow-oriented
// =============================================================================

describe("Phase 38.3 — setup banner copy", () => {
  it("banner headline + body reference workflows, not personas", () => {
    expect(BANNER).toMatch(/Configure your workflows/);
    expect(BANNER).toMatch(
      /Pick the workflows most important to your work/,
    );
    // Sanity: legacy "Choose a persona" copy is gone.
    expect(BANNER).not.toMatch(/Choose a persona/);
  });
});

// =============================================================================
// PART 6 — suggestWorkflow pure-function correctness
// =============================================================================

describe("Phase 38.3 — suggestWorkflow helper", () => {
  it("returns default suggestion for empty input (never throws)", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({});
    expect(out.recommended).toBe("VERIFICATION_DOCUMENTATION");
    expect(out.confidence).toBe(0);
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("recommends OPERATIONAL_ADMINISTRATION when incident signal dominates", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({
      operationalIncidentActivity: 100,
      caseActivity: 5,
    });
    expect(out.recommended).toBe("OPERATIONAL_ADMINISTRATION");
    expect(out.confidence).toBeGreaterThan(80);
  });

  it("recommends LEGAL_CASEWORK when case activity dominates", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({ caseActivity: 50 });
    expect(out.recommended).toBe("LEGAL_CASEWORK");
  });

  it("recommends REVIEW_OPERATIONS when reviewer queue dominates", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({ reviewerQueueActivity: 50 });
    expect(out.recommended).toBe("REVIEW_OPERATIONS");
  });

  it("recommends GOVERNANCE_COMPLIANCE when governance activity dominates", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({ governanceActivity: 50 });
    expect(out.recommended).toBe("GOVERNANCE_COMPLIANCE");
  });

  it("returns a confidence between 0 and 100", async () => {
    const mod = await import(
      "../../../apps/web/lib/platform-context/workflowSuggestion.js"
    );
    const out = mod.suggestWorkflow({
      caseActivity: 50,
      reviewerQueueActivity: 50,
    });
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(100);
  });

  it("is pure — no fetch, no platform-context calls, no auth", () => {
    expect(SUGGEST).not.toMatch(/apiFetch|fetch\(/);
    expect(SUGGEST).not.toMatch(/usePlatformContext|useCan|authorize/);
  });
});

// =============================================================================
// PART 7 — Capability registry remains untouched
// =============================================================================

describe("Phase 38.3 — capability registry stays workflow-free", () => {
  it("workflow profile module is pure (no platform-context, no auth)", () => {
    expect(WORKFLOW).not.toMatch(/usePlatformContext|useCan|authorize/);
    expect(WORKFLOW).not.toMatch(/apiFetch|fetch\(/);
  });

  it("workflow exports are wired into the canonical index", () => {
    expect(INDEX).toMatch(/workflowFromPersona/);
    expect(INDEX).toMatch(/workflowFromCode/);
    expect(INDEX).toMatch(/listWorkflowDescriptors/);
    expect(INDEX).toMatch(/suggestWorkflow/);
    expect(INDEX).toMatch(/WORKFLOW_PROFILE_CODES/);
  });
});
