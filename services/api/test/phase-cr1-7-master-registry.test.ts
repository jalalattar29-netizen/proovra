/**
 * PHASE CR1.7 — Master phase registry contract tests.
 *
 * The registry lives at `docs/recovery/MASTER_PHASE_REGISTRY.md` and is
 * the single source of truth for phase status, deferred items,
 * blockers, and entry/closure gates. These tests are semantic
 * text-contract tests over that file — they assert structural
 * invariants that future phases MUST preserve.
 *
 * Hard rules (also documented in the registry):
 *   - Silent deletion of deferred items is forbidden — every removal
 *     requires a closing phase reference.
 *   - Feature expansion is forbidden during stabilization.
 *   - Every deferred item carries severity + closure criteria.
 *   - Every phase listed has an explicit status.
 *   - The next safe phase is named.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

const REGISTRY = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");

// =============================================================================
// 1. Registry exists and is substantial
// =============================================================================

describe("CR1.7 Test 1 — registry file exists and is substantial", () => {
  it("docs/recovery/MASTER_PHASE_REGISTRY.md is present and >= 8KB", () => {
    expect(REGISTRY.length).toBeGreaterThan(8000);
    expect(REGISTRY).toMatch(/Master Phase Registry/i);
    // The registry must declare itself canonical and instruct future
    // phases to read + update it.
    expect(REGISTRY).toMatch(/canonical/i);
    expect(REGISTRY).toMatch(/single source of truth/i);
  });
});

// =============================================================================
// 2. Required sections present (semantic structure)
// =============================================================================

describe("CR1.7 Test 2 — required sections present", () => {
  // CR1.7 prompt §1 enumerates these sections. They are the bones of
  // the registry; missing one is a structural regression.
  const REQUIRED_SECTION_HEADERS = [
    "## 1. Purpose",
    "## 2. Current platform state",
    "## 3. Completed phases",
    "## 4. Closed-with-deferred phases",
    "## 5. Phase status model",
    "## 6. Open deferred items",
    "## 7. Blockers",
    "## 8. Next safe phase",
    "## 9. Pre-phase entry checklist",
    "## 10. Phase closure template",
    "## 11. Enterprise readiness scorecard",
    "## 12. Required agent behavior from now on",
  ];

  it.each(REQUIRED_SECTION_HEADERS)(
    "registry contains section header: %s",
    (header) => {
      expect(
        REGISTRY,
        `Missing required section header: ${header}`,
      ).toContain(header);
    },
  );
});

// =============================================================================
// 3-5. Registry references the recently closed phases
// =============================================================================

describe("CR1.7 Test 3 — registry contains R8.C, CR1.5, CR1.6", () => {
  const REQUIRED_PHASE_REFS = [
    { label: "R8.C", doc: "R8C_CONSOLIDATION" },
    { label: "CR1.5", doc: "CR1_5_STATE_ORCHESTRATION_OBSERVABILITY" },
    { label: "CR1.6", doc: "CR1_6_SURGICAL_STATE_CLEANUP" },
    { label: "R8.2.2", doc: "R8_2_2_SAML_COMPLIANCE_CLOSURE" },
  ];

  it.each(REQUIRED_PHASE_REFS)(
    "registry references phase $label and its doc",
    ({ label, doc }) => {
      expect(REGISTRY, `Missing phase reference: ${label}`).toContain(label);
      expect(
        REGISTRY,
        `Missing doc reference: ${doc}`,
      ).toContain(doc);
    },
  );
});

// =============================================================================
// 6. Deferred items table is present with required columns
// =============================================================================

describe("CR1.7 Test 4 — deferred items table is well-formed", () => {
  it("has the canonical column headers", () => {
    // The §6 table header line must contain every column required by
    // the CR1.7 prompt §2.
    const REQUIRED_COLUMNS = [
      "ID",
      "Item",
      "Source phase",
      "Severity",
      "Blocking?",
      "Deferred to",
      "Reason",
      "Closure criteria",
    ];
    for (const col of REQUIRED_COLUMNS) {
      expect(
        REGISTRY,
        `Deferred-items table missing column: ${col}`,
      ).toContain(col);
    }
  });

  it("contains at least one row using the DEF-NNN id convention", () => {
    expect(REGISTRY).toMatch(/\bDEF-\d{3}\b/);
  });

  it("every DEF-NNN id appears at least once in §6 deferred items table", () => {
    // Pull every distinct DEF-NNN id used anywhere in the registry —
    // they must all be defined as a row (so cross-references aren't
    // orphaned).
    const ids = new Set<string>();
    const re = /DEF-(\d{3})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(REGISTRY)) !== null) {
      ids.add(`DEF-${m[1]!}`);
    }
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) {
      // Each id should appear in a §6 table row — the row begins with
      // `| <id> |`. We accept any whitespace.
      const rowRegex = new RegExp(`\\|\\s*${id}\\s*\\|`);
      expect(
        REGISTRY,
        `Cross-referenced ${id} does not have a row definition (orphan ref).`,
      ).toMatch(rowRegex);
    }
  });
});

// =============================================================================
// 7. Severity model + blocking-value legend defined
// =============================================================================

describe("CR1.7 Test 5 — severity + blocking-value model present", () => {
  it("declares the four severity levels", () => {
    const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    for (const s of SEVERITIES) {
      expect(REGISTRY, `Severity missing: ${s}`).toContain(s);
    }
  });

  it("declares the four blocking-value semantics", () => {
    const BLOCKING_VALUES = [
      "BLOCKS_NEXT_PHASE",
      "NON_BLOCKING",
      "BLOCKS_LAUNCH",
      "BLOCKS_ENTERPRISE_PILOT",
    ];
    for (const v of BLOCKING_VALUES) {
      expect(REGISTRY, `Blocking value missing: ${v}`).toContain(v);
    }
  });

  it("declares the six phase-status values", () => {
    const STATUSES = [
      "CLOSED",
      "CLOSED_WITH_DEFERRED_ITEMS",
      "PARTIALLY_COMPLETE",
      "BLOCKED",
      "SUPERSEDED",
      "CANCELLED",
    ];
    for (const s of STATUSES) {
      expect(REGISTRY, `Phase status missing: ${s}`).toContain(s);
    }
  });
});

// =============================================================================
// 8-9. Entry checklist + closure template present
// =============================================================================

describe("CR1.7 Test 6 — entry checklist + closure template present", () => {
  it("entry checklist lists at least the 8 mandatory questions", () => {
    // The §9 checklist enumerates 8 questions. Pin a stable phrase
    // from each so reordering doesn't break the test but deletion does.
    const CHECKLIST_PHRASES = [
      "current phase status",
      "deferred items are assigned to this phase",
      "deferred items block this phase",
      "intentionally NOT in scope",
      "forbidden to touch",
      "scope creep",
      "validation must pass",
      "registry updates are required",
    ];
    for (const phrase of CHECKLIST_PHRASES) {
      expect(
        REGISTRY,
        `Entry checklist missing phrase: "${phrase}"`,
      ).toMatch(new RegExp(phrase, "i"));
    }
  });

  it("closure template lists the 10 mandatory final-report items", () => {
    // The §10 template enumerates 10 items. Pin a stable phrase from
    // each.
    const CLOSURE_PHRASES = [
      "Phase status",
      "Completed items",
      "Deferred items",
      "Blockers",
      "Production risk",
      "Enterprise readiness impact",
      "Tests added",
      "Validation results",
      "Registry updates",
      "Next safe phase",
    ];
    for (const phrase of CLOSURE_PHRASES) {
      expect(
        REGISTRY,
        `Closure template missing phrase: "${phrase}"`,
      ).toContain(phrase);
    }
  });
});

// =============================================================================
// 10. Next safe phase identified
// =============================================================================

describe("CR1.7 Test 7 — next safe phase is identified as 32.7", () => {
  it("registry §8 names Phase 32.7 (Final Production Stabilization)", () => {
    expect(REGISTRY).toMatch(/Phase 32\.7/);
    expect(REGISTRY).toMatch(/Final Production Stabilization/i);
  });

  it("registry enumerates 32.7's hard out-of-scope set", () => {
    // The next phase MUST NOT touch these areas. Pin the canonical
    // forbidden list so a future agent cannot quietly broaden scope.
    const OUT_OF_SCOPE = [
      "WebAuthn",
      "SIEM",
      "Navigation expansion",
      "capture",
      "billing",
    ];
    for (const item of OUT_OF_SCOPE) {
      expect(
        REGISTRY,
        `Out-of-scope item not enumerated: ${item}`,
      ).toMatch(new RegExp(item, "i"));
    }
  });
});

// =============================================================================
// 11. Closure-criteria invariant: every §6 row carries a closure criterion
// =============================================================================

describe("CR1.7 Test 8 — every deferred item carries a closure criterion", () => {
  /**
   * The §6 table looks like:
   *   | ID     | Item ... | ... | Closure criteria |
   *   | DEF-001 | ...     | ... | <criteria text>  |
   *
   * We extract each `| DEF-NNN ... |` row and assert the row has
   * 9 pipe-separated cells (8 columns + leading empty cell) and that
   * the final cell is non-empty.
   */
  it("each DEF-NNN row in §6 has 9 pipes and a non-empty closure-criteria cell", () => {
    // Split into lines and pick only rows that look like
    // `| DEF-NNN | ...`.
    const rows = REGISTRY.split(/\r?\n/).filter((line) =>
      /^\|\s*DEF-\d{3}\s*\|/.test(line),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Count pipes — Markdown table rows with N columns have N+1
      // pipes (leading + trailing). 8 columns → 9 pipes.
      const pipeCount = (row.match(/\|/g) ?? []).length;
      expect(
        pipeCount,
        `Row malformed (expected 9 pipes for 8 columns): ${row}`,
      ).toBe(9);
      // Closure-criteria cell is the last meaningful cell — between
      // the second-to-last and last pipe.
      const cells = row.split("|").map((c) => c.trim());
      // cells[0] = "" (before leading pipe), cells[1..8] = 8 columns,
      // cells[9] = "" (after trailing pipe).
      const closureCriteria = cells[8] ?? "";
      expect(
        closureCriteria.length,
        `Empty closure criteria in row: ${row}`,
      ).toBeGreaterThan(3);
    }
  });
});

// =============================================================================
// 12. Feature-expansion ban enforced in §12
// =============================================================================

describe("CR1.7 Test 9 — feature expansion is forbidden during stabilization", () => {
  it("§12 explicitly forbids feature expansion / redesign / new state library", () => {
    expect(REGISTRY).toMatch(/Feature expansion is forbidden/i);
    expect(REGISTRY).toMatch(/refused/i);
    // The forbidden list must enumerate the canonical categories.
    expect(REGISTRY).toMatch(/redesign/i);
    expect(REGISTRY).toMatch(/refactor the app shell/i);
    expect(REGISTRY).toMatch(/new state library/i);
    expect(REGISTRY).toMatch(/expand auth subsystems/i);
    expect(REGISTRY).toMatch(/capture\/custody\/report logic/i);
  });

  it("§12 demands no silent debt and references DEF / closure criteria", () => {
    expect(REGISTRY).toMatch(/Silent debt is forbidden/i);
    expect(REGISTRY).toMatch(/closure criteria/i);
  });
});

// =============================================================================
// 13. Recently closed phases registered with status
// =============================================================================

describe("CR1.7 Test 10 — R8.C / CR1.5 / CR1.6 registered with explicit status", () => {
  it("R8.C is registered as CLOSED_WITH_DEFERRED_ITEMS", () => {
    // R8.C row in §3 or §4.
    expect(REGISTRY).toMatch(
      /\|\s*R8\.C\s*\|[\s\S]*?CLOSED_WITH_DEFERRED_ITEMS/,
    );
  });

  it("CR1.5 is registered as CLOSED_WITH_DEFERRED_ITEMS", () => {
    expect(REGISTRY).toMatch(
      /\|\s*CR1\.5\s*\|[\s\S]*?CLOSED_WITH_DEFERRED_ITEMS/,
    );
  });

  it("CR1.6 is registered as CLOSED_WITH_DEFERRED_ITEMS", () => {
    expect(REGISTRY).toMatch(
      /\|\s*CR1\.6\s*\|[\s\S]*?CLOSED_WITH_DEFERRED_ITEMS/,
    );
  });

  it("CR1.7 (this phase) is registered as CLOSED (documentation-only)", () => {
    expect(REGISTRY).toMatch(/\|\s*CR1\.7\s*\|[\s\S]*?CLOSED/);
  });
});

// =============================================================================
// 14. Known deferred items present (migration check)
// =============================================================================

describe("CR1.7 Test 11 — known deferred items migrated into registry", () => {
  // Each phrase below corresponds to a known item the CR1.7 prompt
  // listed as expected migration content. Pinning them prevents a
  // future edit from silently losing the institutional memory.
  const REQUIRED_DEFERRED_ITEMS_PHRASES: ReadonlyArray<{
    label: string;
    regex: RegExp;
  }> = [
    { label: "providers.tsx bootstrap", regex: /providers\.tsx/i },
    { label: "focus-refresh staged rollout", regex: /focus[- ]refresh/i },
    { label: "useTeamId surviving callsites", regex: /useTeamId/i },
    { label: "push channel for capability changes", regex: /push channel/i },
    { label: "logout teardown window", regex: /Logout/i },
    { label: "live IdP validation", regex: /Live IdP/i },
    { label: "SAML SP request signing", regex: /request signing/i },
    { label: "production secret rotation audit", regex: /secret rotation/i },
    { label: "Stripe live key verification", regex: /Stripe/i },
    { label: "S3_ENDPOINT production safety", regex: /S3_ENDPOINT/i },
  ];
  it.each(REQUIRED_DEFERRED_ITEMS_PHRASES)(
    "registry mentions known deferred topic: $label",
    ({ label, regex }) => {
      expect(
        REGISTRY,
        `Required deferred topic not migrated into registry: "${label}"`,
      ).toMatch(regex);
    },
  );
});

// =============================================================================
// 15. Required agent-behavior protocol present
// =============================================================================

describe("CR1.7 Test 12 — required agent-behavior protocol present", () => {
  it("§12 instructs agents to read + update registry every phase", () => {
    expect(REGISTRY).toMatch(/Before starting a phase/i);
    expect(REGISTRY).toMatch(/At the end of a phase/i);
    expect(REGISTRY).toMatch(/Read .*MASTER_PHASE_REGISTRY\.md/i);
  });

  it("§12 enforces severity + return phase on every deferred item", () => {
    expect(REGISTRY).toMatch(/severity/i);
    expect(REGISTRY).toMatch(/return phase|Deferred to/i);
  });
});
