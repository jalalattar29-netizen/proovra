/**
 * PHASE 38.2 — Full persona consumption source-contract + behavioral tests.
 *
 * Covers:
 *   1. getPersonaSectionOrder pure-function correctness
 *   2. Operational density attribute on the app shell root
 *   3. resolvePersonaHint pure-function correctness + hint shape
 *   4. Terminology rollout to Search + Cases queue
 *   5. Persona-aware empty-state copy still bounded
 *   6. Capability authority unchanged (persona never bypasses)
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

const SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");
const INDEX = readWeb("lib/platform-context/index.ts");
const SECTION_ORDER = readWeb("lib/platform-context/personaSectionOrder.ts");
const HINTS = readWeb("lib/platform-context/personaHints.ts");
const SEARCH = readWeb("app/(app)/search/page.tsx");
const CASES = readWeb("components/cases-experience/CasesIndex.tsx");

// =============================================================================
// PART 1 — getPersonaSectionOrder pure-function correctness
// =============================================================================

describe("Phase 38.2 — getPersonaSectionOrder", () => {
  it("exports the helper + priority map", () => {
    expect(INDEX).toMatch(/getPersonaSectionOrder/);
    expect(INDEX).toMatch(/PERSONA_DASHBOARD_PRIORITY/);
  });

  it("INDIVIDUAL preserves canonical order (no reordering)", async () => {
    const { getPersonaSectionOrder } = await import(
      "../../../apps/web/lib/platform-context/personaSectionOrder.js"
    );
    const out = getPersonaSectionOrder({
      persona: "INDIVIDUAL",
      availableSectionIds: [
        "summary",
        "operationalPressure",
        "caseOperations",
        "governancePosture",
      ],
    });
    expect(out).toEqual([
      "summary",
      "operationalPressure",
      "caseOperations",
      "governancePosture",
    ]);
  });

  it("LAWYER pulls caseOperations + governance ahead of summary", async () => {
    const { getPersonaSectionOrder } = await import(
      "../../../apps/web/lib/platform-context/personaSectionOrder.js"
    );
    const out = getPersonaSectionOrder({
      persona: "LAWYER",
      availableSectionIds: [
        "summary",
        "operationalPressure",
        "caseOperations",
        "governancePosture",
      ],
    });
    // caseOperations (priority 1 for LAWYER) + governancePosture (priority 4)
    // are pulled forward; summary follows; operationalPressure (no LAWYER
    // priority) lands at the end.
    expect(out[0]).toBe("caseOperations");
    expect(out).toContain("governancePosture");
    expect(out).toContain("summary");
    expect(out).toContain("operationalPressure");
    // Same set in / same set out — never adds or removes.
    expect(new Set(out)).toEqual(
      new Set([
        "summary",
        "operationalPressure",
        "caseOperations",
        "governancePosture",
      ]),
    );
  });

  it("ADMIN_OPERATOR pulls operationalPressure + incidents to the top", async () => {
    const { getPersonaSectionOrder } = await import(
      "../../../apps/web/lib/platform-context/personaSectionOrder.js"
    );
    const out = getPersonaSectionOrder({
      persona: "ADMIN_OPERATOR",
      availableSectionIds: [
        "summary",
        "operationalPressure",
        "incidents",
        "caseOperations",
      ],
    });
    expect(out[0]).toBe("operationalPressure");
    expect(out[1]).toBe("incidents");
  });

  it("returns empty array for empty input (no fabricated sections)", async () => {
    const { getPersonaSectionOrder } = await import(
      "../../../apps/web/lib/platform-context/personaSectionOrder.js"
    );
    expect(
      getPersonaSectionOrder({ persona: "LAWYER", availableSectionIds: [] }),
    ).toEqual([]);
  });

  it("ignores priority items that aren't in the input (never fabricates)", async () => {
    const { getPersonaSectionOrder } = await import(
      "../../../apps/web/lib/platform-context/personaSectionOrder.js"
    );
    const out = getPersonaSectionOrder({
      persona: "LAWYER",
      availableSectionIds: ["summary"],
    });
    expect(out).toEqual(["summary"]);
  });

  it("section-order helper is a pure function (no fetches, no side effects)", () => {
    expect(SECTION_ORDER).not.toMatch(/apiFetch|fetch\(/);
    expect(SECTION_ORDER).not.toMatch(/usePlatformContext/);
  });
});

// =============================================================================
// PART 2 — Operational density attribute
// =============================================================================

describe("Phase 38.2 — operational density attribute on shell root", () => {
  it("AppShellV2 reads density from the persona profile (defaults to comfortable)", () => {
    expect(SHELL).toMatch(/operationalDensityPreference/);
    expect(SHELL).toMatch(/data-operational-density=/);
    expect(SHELL).toMatch(/"comfortable"/);
  });

  it("AppShellV2 also exposes the active persona as a data attribute (CSS hook)", () => {
    expect(SHELL).toMatch(/data-active-persona=/);
    expect(SHELL).toMatch(/personaProfile\?\.primaryProfile/);
  });

  it("Density / persona attributes are presentation-only (no capability check)", () => {
    // The shell does not branch on persona to decide whether to render
    // children. Capability remains authoritative.
    expect(SHELL).not.toMatch(/primaryProfile\s*===\s*"[A-Z_]+"\s*\?\s*<.*recovery/i);
  });
});

// =============================================================================
// PART 3 — Persona hints library
// =============================================================================

describe("Phase 38.2 — resolvePersonaHint library", () => {
  it("exports resolvePersonaHint + PersonaHint + PersonaHintSurface", () => {
    expect(INDEX).toMatch(/resolvePersonaHint/);
    expect(INDEX).toMatch(/PersonaHint\b/);
    expect(INDEX).toMatch(/PersonaHintSurface/);
  });

  it("returns null for personas without a hint for the requested surface", async () => {
    const { resolvePersonaHint } = await import(
      "../../../apps/web/lib/platform-context/personaHints.js"
    );
    // INDIVIDUAL has dashboard + evidence hints; reviewer-ops is null.
    expect(
      resolvePersonaHint({ persona: "INDIVIDUAL", surface: "reviewer-ops" }),
    ).toBeNull();
  });

  it("LAWYER dashboard hint surfaces legal hold / retention discoverability", async () => {
    const { resolvePersonaHint } = await import(
      "../../../apps/web/lib/platform-context/personaHints.js"
    );
    const hint = resolvePersonaHint({
      persona: "LAWYER",
      surface: "dashboard",
    });
    expect(hint).not.toBeNull();
    expect(hint!.headline.toLowerCase()).toContain("legal hold");
    expect(hint!.capabilityKey).toBe("LEGAL_HOLD_PLACE");
  });

  it("every hint has a complete shape (id, headline, body, CTA label + href)", async () => {
    const { resolvePersonaHint } = await import(
      "../../../apps/web/lib/platform-context/personaHints.js"
    );
    const personas = [
      "INDIVIDUAL",
      "LAWYER",
      "INSURANCE",
      "INVESTIGATOR",
      "JOURNALIST",
      "ENTERPRISE_COMPLIANCE",
      "ADMIN_OPERATOR",
    ] as const;
    const surfaces = [
      "dashboard",
      "cases",
      "evidence",
      "reports",
      "governance",
      "reviewer-ops",
    ] as const;
    for (const persona of personas) {
      for (const surface of surfaces) {
        const hint = resolvePersonaHint({ persona, surface });
        if (hint === null) continue;
        expect(hint.id.length).toBeGreaterThan(0);
        expect(hint.headline.length).toBeGreaterThan(0);
        expect(hint.body.length).toBeGreaterThan(0);
        expect(hint.ctaLabel.length).toBeGreaterThan(0);
        expect(hint.ctaHref).toMatch(/^\//);
      }
    }
  });

  it("hint library is pure (no fetches, no capability calls)", () => {
    // Strip comments before negative-matching so docstring mentions
    // (e.g. "callers gate via useCan") don't trip the assertion.
    const code = HINTS.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(code).not.toMatch(/apiFetch|fetch\(/);
    expect(code).not.toMatch(/usePlatformContext\b/);
    expect(code).not.toMatch(/useCan\(/);
  });

  it("hints declare capabilityKey when they require gating (caller wraps in useCan)", () => {
    // Some hints reference reviewer-ops / governance — those carry a
    // capabilityKey field so the caller can gate the render.
    expect(HINTS).toMatch(/capabilityKey:\s*"LEGAL_HOLD_PLACE"/);
    expect(HINTS).toMatch(/capabilityKey:\s*"REVIEWER_OPS_VIEW"/);
    expect(HINTS).toMatch(/capabilityKey:\s*"GOVERNANCE_VIEW"/);
  });
});

// =============================================================================
// PART 4 — Terminology rollout: Search + Cases queue
// =============================================================================

describe("Phase 38.2 — terminology rollout", () => {
  it("Search page heading is plain 'Search' (Phase SEARCH-REMEDIATION removed persona aliasing)", () => {
    // Phase SEARCH-REMEDIATION — the page now serves Personal /
    // Small-Business users as a unified "Search" across evidence,
    // cases, reports, notes and OCR text. The persona-tuned
    // "{terms.evidence} Discovery" heading was misleading because
    // (1) it implied evidence-only scope when the index now also
    // covers cases/reports/packages/notes, and (2) "Discovery"
    // is an enterprise legal-procedure term unfamiliar to
    // Personal users.
    expect(SEARCH).toMatch(/data-search-title/);
    expect(SEARCH).toMatch(/data-search-title>\s*\n?\s*Search\s*\n?\s*<\/h1>/);
    expect(SEARCH).not.toMatch(/\{terms\.evidence\}\s*Discovery/);
  });

  it("Cases queue table renders the plain-language title + spec empty-state copy (no persona aliasing)", () => {
    // Phase CASES-PERSONAL-UX (audit-driven follow-up) — the Cases
    // page opted out of persona terminology. The h1 is plain
    // "Cases" and the table title + empty-states use that label
    // verbatim so personal/small-business users see consistent
    // wording. Persona terminology is still applied on Home /
    // Evidence pages; only this surface universally says "Cases".
    expect(CASES).toMatch(/data-matter-queue-title/);
    expect(CASES).toMatch(/`Cases · \$\{items\.length\}`/);
    expect(CASES).not.toMatch(/terms\.casePlural/);
    expect(CASES).not.toMatch(/terms\.caseLower/);
    // The two spec empty states are wired and copy is locked.
    expect(CASES).toMatch(/data-empty-state="no-cases-yet"/);
    expect(CASES).toMatch(/data-empty-state="no-filter-match"/);
    expect(CASES).toMatch(/<strong>No cases yet<\/strong>/);
    expect(CASES).toMatch(/<strong>No cases match these filters<\/strong>/);
  });
});

// =============================================================================
// PART 5 — Capability authority unchanged (the headline guarantee)
// =============================================================================

describe("Phase 38.2 — persona stays UX-only", () => {
  it("section-order helper makes no capability decisions", () => {
    expect(SECTION_ORDER).not.toMatch(/CAPABILITY|useCan\(/);
  });

  it("hint library declares capabilityKey but never decides — caller gates", () => {
    // Strip comments before the negative-match.
    const code = HINTS.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(code).not.toMatch(/useCan\(/);
    expect(code).not.toMatch(/if \(!capabilities/);
  });

  it("Search + Cases never gate features by persona — terminology only", () => {
    expect(SEARCH).not.toMatch(/primaryProfile\s*===\s*"[A-Z_]+"\s*\?\s*null/);
    expect(CASES).not.toMatch(/primaryProfile\s*===\s*"[A-Z_]+"\s*\?\s*null/);
  });
});
