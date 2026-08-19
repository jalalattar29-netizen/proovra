/**
 * Phase G2 — Operational Ergonomics & Governance Surface Completion
 * (Wave 3 + G1.1 closure).
 *
 * Asserts:
 *
 *   G1.1 — GovernanceSummary mounted on Matter Workspace Overview;
 *          GovernedExportAction wrapper composes ExportEligibilityPreflight.
 *   C1.3 — Matter Workspace per-tab filter input + tab functions accept
 *          `filterText` prop; Evidence + Timeline tabs apply the filter.
 *   C1.5 — Matter Workspace keyboard handler with g-prefixed tab jumps,
 *          / focus filter, Esc clear; ignores editable targets.
 *   C2.5 — EvidenceDiscussionPanel discussion advanced filters/search
 *          with bounded presets (all / unresolved / escalated /
 *          resolved) + client-side title filter.
 *   B.6  — CommandPalette renders Phase B operational group attribution
 *          per result; global Cmd+K binding preserved.
 *
 *   C0.1 (inline reviewer actions) + C0.2 (saved-view CRUD UI) are
 *        deferred as G2.x continuation — the frontend step-up modal +
 *        the saved-view forms are out-of-scope for this wave. The
 *        runbook documents the deferral explicitly.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const GOVERNED_EXPORT = readSource(
  "../../../apps/web/components/governance/GovernedExportAction.tsx",
);
const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const DISCUSSION_PANEL = readSource(
  "../../../apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx",
);
const COMMAND_PALETTE = readSource(
  "../../../apps/web/components/navigation/CommandPalette.tsx",
);

// ===========================================================================
// G1.1 — GovernanceSummary mount + GovernedExportAction wrapper
// ===========================================================================

describe("Phase G2 (G1.1) — governance surface completion", () => {
  it("Matter Workspace Overview tab mounts the GovernanceSummary", () => {
    expect(MATTER_UI).toMatch(
      /import\s*\{\s*GovernanceSummary\s*\}\s*from\s+"\.\.\/governance\/GovernanceSummary"/,
    );
    expect(MATTER_UI).toMatch(/<GovernanceSummary[\s\S]*?variant="matter"/);
  });

  it("GovernedExportAction wrapper exists and is read-only", () => {
    expect(GOVERNED_EXPORT).toMatch(
      /export function GovernedExportAction/,
    );
    const code = stripComments(GOVERNED_EXPORT);
    expect(code).not.toMatch(/method:\s*"POST"/);
    expect(code).not.toMatch(/method:\s*"PATCH"/);
    expect(code).not.toMatch(/method:\s*"DELETE"/);
  });

  it("GovernedExportAction consumes the export-eligibility endpoint with action label support", () => {
    expect(GOVERNED_EXPORT).toContain("/v1/governance/export-eligibility");
    expect(GOVERNED_EXPORT).toContain("actionLabel");
  });

  it("GovernedExportAction renders bounded outcomes + next-step copy", () => {
    expect(GOVERNED_EXPORT).toContain("ALLOWED");
    expect(GOVERNED_EXPORT).toContain("BLOCKED_BY_HOLD");
    expect(GOVERNED_EXPORT).toContain("BLOCKED_BY_LIFECYCLE");
    expect(GOVERNED_EXPORT).toContain("BLOCKED_BY_REVIEW_GATE");
    expect(GOVERNED_EXPORT).toContain("BLOCKED_BY_POLICY");
    expect(GOVERNED_EXPORT).toContain("Release the active legal hold");
  });

  it("GovernedExportAction onAction is only invoked when ALLOWED", () => {
    expect(GOVERNED_EXPORT).toMatch(/if\s*\(!allowed\)\s*return/);
  });

  it("GovernedExportAction never collapses Report PDF and Verification Package ZIP into one label", () => {
    // The component accepts `actionLabel` per call site; assert it
    // does NOT hard-code a single label.
    const code = stripComments(GOVERNED_EXPORT);
    expect(code).not.toMatch(/"Generate Report PDF"/);
    expect(code).not.toMatch(/"Download Report PDF"/);
    expect(code).not.toMatch(/"Verification Package ZIP"/);
  });
});

// ===========================================================================
// C1.3 — Matter Workspace per-tab filter
// ===========================================================================

describe("Phase G2 (C1.3) — Matter Workspace per-tab filter", () => {
  it("declares filterText state + filter input ref", () => {
    expect(MATTER_UI).toMatch(/const \[filterText, setFilterText\]\s*=\s*useState/);
    expect(MATTER_UI).toMatch(
      /filterInputRef\s*=\s*useRef<HTMLInputElement\s*\|\s*null>/,
    );
  });

  it("renders the filter input row + keyboard hint", () => {
    expect(MATTER_UI).toContain("data-matter-filter-row");
    expect(MATTER_UI).toContain("data-matter-filter-input");
    expect(MATTER_UI).toContain("data-matter-keyboard-hint");
  });

  it("filter input is suppressed on Overview / Graph / Risk tabs", () => {
    expect(MATTER_UI).toMatch(
      /activeTab\s*!==\s*"overview"\s*&&\s*\n?\s*activeTab\s*!==\s*"graph"\s*&&\s*\n?\s*activeTab\s*!==\s*"risk"/,
    );
  });

  it("Evidence + Timeline tabs apply the filter via matchesFilter()", () => {
    expect(MATTER_UI).toContain("function matchesFilter");
    // EvidenceTab applies it on `ev.items`.
    expect(MATTER_UI).toMatch(/matchesFilter\(\s*ev\.items,\s*filterText/);
    // TimelineTab applies it on `tl.items`.
    expect(MATTER_UI).toMatch(/matchesFilter\(\s*tl\.items,\s*filterText/);
  });

  it("every filterable tab accepts an optional `filterText` prop", () => {
    const tabFns = [
      "EvidenceTab",
      "TimelineTab",
      "HoldsTab",
      "DecisionsTab",
      "CommunicationsTab",
      "AssignmentsTab",
      "AuditTab",
      "ExportTab",
    ];
    for (const name of tabFns) {
      const re = new RegExp(
        `function\\s+${name}\\(\\s*\\{[\\s\\S]*?filterText[\\s\\S]*?\\}:\\s*\\{`,
      );
      expect(MATTER_UI, `${name} must accept filterText`).toMatch(re);
    }
  });
});

// ===========================================================================
// C1.5 — Matter Workspace keyboard shortcuts
// ===========================================================================

describe("Phase G2 (C1.5) — Matter Workspace keyboard shortcuts", () => {
  it("registers a document keydown listener", () => {
    expect(MATTER_UI).toMatch(/document\.addEventListener\(\s*"keydown"/);
    expect(MATTER_UI).toMatch(/document\.removeEventListener\(\s*"keydown"/);
  });

  it("ignores editable targets (input/textarea/select/contenteditable)", () => {
    expect(MATTER_UI).toMatch(/function isEditableTarget/);
    expect(MATTER_UI).toMatch(/INPUT|TEXTAREA|SELECT/);
    expect(MATTER_UI).toMatch(/isContentEditable/);
  });

  it('binds `/` to focus the filter input', () => {
    expect(MATTER_UI).toMatch(
      /e\.key\s*===\s*"\/"[\s\S]*?filterInputRef\.current\?\.focus\(\)/,
    );
  });

  it("binds `Escape` to clear the go-prefix and the filter input", () => {
    expect(MATTER_UI).toMatch(/e\.key\s*===\s*"Escape"/);
    expect(MATTER_UI).toContain("clearGoPrefix");
  });

  it("supports `g`-prefixed tab jumps for evidence / timeline / audit / export", () => {
    expect(MATTER_UI).toMatch(/goPrefixRef\.current\.pending\s*=\s*true/);
    expect(MATTER_UI).toMatch(/e:\s*"evidence"/);
    expect(MATTER_UI).toMatch(/t:\s*"timeline"/);
    expect(MATTER_UI).toMatch(/a:\s*"audit"/);
    expect(MATTER_UI).toMatch(/x:\s*"export"/);
  });
});

// ===========================================================================
// C2.5 — Discussion advanced filters + search
// ===========================================================================

describe("Phase G2 (C2.5) — discussion advanced filters/search", () => {
  it("declares filterText + filterPreset state", () => {
    expect(DISCUSSION_PANEL).toMatch(
      /const \[filterText, setFilterText\]\s*=\s*useState/,
    );
    expect(DISCUSSION_PANEL).toMatch(
      /const \[filterPreset, setFilterPreset\]\s*=\s*useState/,
    );
  });

  it("renders bounded preset chips (all / unresolved / escalated / resolved)", () => {
    // The chips render via a literal tuple `["all", "unresolved",
    // "escalated", "resolved"] as const` mapped to <button> elements
    // — assert each literal appears in source.
    expect(DISCUSSION_PANEL).toMatch(
      /\[\s*"all"\s*,\s*"unresolved"\s*,\s*"escalated"\s*,\s*"resolved"\s*\]\s*as const/,
    );
    expect(DISCUSSION_PANEL).toContain("data-discussion-filter-preset");
    expect(DISCUSSION_PANEL).toContain(
      "data-discussion-filter-preset-active",
    );
  });

  it("renders the title-search input", () => {
    expect(DISCUSSION_PANEL).toContain("data-discussion-filter-text");
    expect(DISCUSSION_PANEL).toMatch(/placeholder="Filter threads by title/);
  });

  it("applies the filter client-side on the bounded thread list", () => {
    // The filter was hoisted out of JSX into a named `visibleThreads` const
    // when the panel was migrated off inline styles. Same client-side filter,
    // same bounded list, same two inputs — one binding earlier.
    expect(DISCUSSION_PANEL).toMatch(
      /visibleThreads = \(threads \?\? \[\]\)\.filter\([\s\S]*?filterPreset[\s\S]*?filterText/,
    );
  });

  it("never claims social/chat semantics (no Slack/DMs/emoji/reactions/AI summarisation)", () => {
    const code = stripComments(DISCUSSION_PANEL);
    expect(code).not.toMatch(/\bSlack\b/i);
    expect(code).not.toMatch(/\bdirect messages?\b/i);
    expect(code).not.toMatch(/\bemoji\b|\breaction\b/i);
    expect(code).not.toMatch(/\bAI\s+summariz/i);
  });
});

// ===========================================================================
// B.6 — Operational quick-jump (CommandPalette)
// ===========================================================================

describe("Phase G2 (B.6) — operational quick-jump", () => {
  it("CommandPalette imports operationalGroupDescriptor from Phase B groups", () => {
    expect(COMMAND_PALETTE).toMatch(
      /import\s*\{\s*operationalGroupDescriptor[\s\S]*?\}\s*from\s+"\.\.\/\.\.\/lib\/navigation\/phaseBOperationalGroups"/,
    );
  });

  it("renders a Phase B group chip per result", () => {
    expect(COMMAND_PALETTE).toContain("data-command-palette-group-chip");
    expect(COMMAND_PALETTE).toContain(
      "data-command-palette-operational-group",
    );
    expect(COMMAND_PALETTE).toMatch(/operationalGroupDescriptor\(item\.route\.id\)/);
  });

  it("preserves the global Cmd+K binding (B.6 trigger)", () => {
    expect(COMMAND_PALETTE).toMatch(
      /\(e\.metaKey\s*\|\|\s*e\.ctrlKey\)\s*&&\s*e\.key\.toLowerCase\(\)\s*===\s*"k"/,
    );
  });

  it("workspace + access guarded — results respect canSeeNav + canLoad", () => {
    expect(COMMAND_PALETTE).toContain("resolveRouteAccess");
    expect(COMMAND_PALETTE).toMatch(/if\s*\(!access\.canSeeNav\)\s*continue/);
    expect(COMMAND_PALETTE).toMatch(/item\.access\.canLoad/);
  });
});

// ===========================================================================
// Vocabulary discipline across G2 surfaces
// ===========================================================================

describe("Phase G2 — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "GovernedExportAction", src: GOVERNED_EXPORT },
    { name: "MatterWorkspace (G2 edits)", src: MATTER_UI },
    { name: "EvidenceDiscussionPanel (G2 edits)", src: DISCUSSION_PANEL },
    { name: "CommandPalette (G2 edits)", src: COMMAND_PALETTE },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "kanban", re: /\bkanban\b/i },
    { name: "CRM", re: /\bCRM\b/ },
    { name: "ticket", re: /\bticket\b/i },
    { name: "tampered", re: /\btampered?\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "Slack", re: /\bSlack\b/i },
    { name: "compliance attestation", re: /\bcompliance attestation\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}' (after stripping doc comments)`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
