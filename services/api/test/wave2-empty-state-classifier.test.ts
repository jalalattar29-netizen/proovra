/**
 * Wave 2 Phase 4 — Empty-State Truth Classifier regression test
 * (source-contract).
 *
 * Pins the canonical 10-code union, the classifier resolver shape,
 * the page-side migration to OperationalEmptyState, and the
 * disappearance of hand-rolled empty-state divs across the 6
 * Investigation surfaces.
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

const PRIMITIVE = readWeb(
  "components/operational/OperationalEmptyState.tsx",
);
const CLASSIFIER = readWeb("lib/empty-state/classifier.ts");

const PAGES: ReadonlyArray<{ path: string; src: string; domain: string }> = [
  {
    path: "app/(app)/investigation/page.tsx",
    src: readWeb("app/(app)/investigation/page.tsx"),
    domain: "overview",
  },
  {
    path: "app/(app)/investigation/graph/page.tsx",
    src: readWeb("app/(app)/investigation/graph/page.tsx"),
    domain: "graph",
  },
  {
    path: "app/(app)/investigation/timeline/page.tsx",
    src: readWeb("app/(app)/investigation/timeline/page.tsx"),
    domain: "timeline",
  },
  {
    path: "app/(app)/investigation/duplicates/page.tsx",
    src: readWeb("app/(app)/investigation/duplicates/page.tsx"),
    domain: "duplicates",
  },
  {
    path: "app/(app)/investigation/reviewers/page.tsx",
    src: readWeb("app/(app)/investigation/reviewers/page.tsx"),
    domain: "reviewers",
  },
  {
    path: "app/(app)/investigation/relationships/page.tsx",
    src: readWeb("app/(app)/investigation/relationships/page.tsx"),
    domain: "relationships",
  },
];

// ===========================================================================
// 10-code classification union
// ===========================================================================

const TEN_CODES = [
  "TRUE_EMPTY",
  "PIPELINE_PENDING",
  "PIPELINE_FAILED",
  "WORKER_UNAVAILABLE",
  "CONFIG_DISABLED",
  "PERMISSION_RESTRICTED",
  "WRONG_SCOPE",
  "API_ERROR",
  "FEATURE_NOT_CONFIGURED",
  "CAPABILITY_UNAVAILABLE",
] as const;

describe("Wave 2 Phase 4 — OperationalEmptyState primitive extension", () => {
  it("declares EmptyStateClassification union with all 10 codes", () => {
    expect(PRIMITIVE).toMatch(
      /export type EmptyStateClassification\s*=\s*([\s\S]*?);/m,
    );
    for (const code of TEN_CODES) {
      expect(PRIMITIVE).toMatch(new RegExp(`"${code}"`));
    }
  });

  it("declares CLASSIFICATION_COPY map with one entry per code", () => {
    expect(PRIMITIVE).toMatch(/export const CLASSIFICATION_COPY/);
    for (const code of TEN_CODES) {
      // Each code MUST appear as a property key in the copy map.
      expect(PRIMITIVE).toMatch(new RegExp(`${code}:\\s*\\{`));
    }
  });

  it("primitive props expose nextAction, adminAction, diagnosticsLink, isAdmin", () => {
    expect(PRIMITIVE).toMatch(/classification\?:\s*EmptyStateClassification/);
    expect(PRIMITIVE).toMatch(/nextAction\?:\s*EmptyStateActionAffordance/);
    expect(PRIMITIVE).toMatch(/adminAction\?:\s*EmptyStateActionAffordance/);
    expect(PRIMITIVE).toMatch(/diagnosticsLink\?:\s*string/);
    expect(PRIMITIVE).toMatch(/isAdmin\?:\s*boolean/);
  });

  it("primitive guards admin affordances behind isAdmin === true", () => {
    // The render block conditionally renders the admin action + diagnostics
    // link only when isAdmin is truthy.
    expect(PRIMITIVE).toMatch(/isAdmin\s*&&\s*adminAction/);
    expect(PRIMITIVE).toMatch(/isAdmin\s*&&\s*diagnosticsLink/);
  });
});

// ===========================================================================
// Classifier resolver
// ===========================================================================

describe("Wave 2 Phase 4 — classifyInvestigationEmptyState resolver", () => {
  it("exports the classifier function with the brief's signature", () => {
    expect(CLASSIFIER).toMatch(
      /export function classifyInvestigationEmptyState\s*\(/,
    );
    // Returns a ClassifierResult with { classification, reason }.
    expect(CLASSIFIER).toMatch(/export interface ClassifierResult/);
    expect(CLASSIFIER).toMatch(/classification:\s*EmptyStateClassification/);
    expect(CLASSIFIER).toMatch(/reason:\s*string/);
  });

  it("exports the ClassifierInput interface with bounded shape", () => {
    expect(CLASSIFIER).toMatch(/export interface ClassifierInput/);
    expect(CLASSIFIER).toMatch(/fetchError:\s*Error \| null/);
    expect(CLASSIFIER).toMatch(/permission\?:\s*ClassifierPermission/);
    expect(CLASSIFIER).toMatch(
      /capabilityStatus\?:\s*ProducerModeStatusLike/,
    );
    expect(CLASSIFIER).toMatch(
      /diagnostics\?:\s*InvestigationDiagnosticsLike/,
    );
  });

  it("Rule 1 — fetchError dominates → API_ERROR", () => {
    // The resolver checks fetchError first and returns API_ERROR.
    expect(CLASSIFIER).toMatch(/input\.fetchError\s*!==\s*null/);
    expect(CLASSIFIER).toMatch(/classification:\s*"API_ERROR"/);
  });

  it("Rule 2 — permission === 'denied' → PERMISSION_RESTRICTED", () => {
    expect(CLASSIFIER).toMatch(/permission\s*===\s*"denied"/);
    expect(CLASSIFIER).toMatch(
      /classification:\s*"PERMISSION_RESTRICTED"/,
    );
  });

  it("Rule 3 — permission === 'wrong_scope' → WRONG_SCOPE", () => {
    expect(CLASSIFIER).toMatch(/permission\s*===\s*"wrong_scope"/);
    expect(CLASSIFIER).toMatch(/classification:\s*"WRONG_SCOPE"/);
  });

  it("Rule 4 — capabilityStatus.configured === false → FEATURE_NOT_CONFIGURED", () => {
    expect(CLASSIFIER).toMatch(/cap\.configured\s*===\s*false/);
    expect(CLASSIFIER).toMatch(
      /classification:\s*"FEATURE_NOT_CONFIGURED"/,
    );
  });

  it("Rule 5 — capabilityStatus.enabled === false → CONFIG_DISABLED", () => {
    expect(CLASSIFIER).toMatch(/cap\.enabled\s*===\s*false/);
    expect(CLASSIFIER).toMatch(/classification:\s*"CONFIG_DISABLED"/);
  });

  it("Rule 6 — DEFERRED + provider 'none' → CAPABILITY_UNAVAILABLE", () => {
    expect(CLASSIFIER).toMatch(/cap\.provider\s*===\s*"none"/);
    expect(CLASSIFIER).toMatch(/cap\.mode\s*===\s*"DEFERRED"/);
    expect(CLASSIFIER).toMatch(
      /classification:\s*"CAPABILITY_UNAVAILABLE"/,
    );
  });

  it("Rule 7 — queue depth > 0 → PIPELINE_PENDING", () => {
    expect(CLASSIFIER).toMatch(/queueDepth\s*>\s*0/);
    expect(CLASSIFIER).toMatch(/classification:\s*"PIPELINE_PENDING"/);
  });

  it("Rule 8 — pipeline failure surfaces → PIPELINE_FAILED", () => {
    expect(CLASSIFIER).toMatch(/classification:\s*"PIPELINE_FAILED"/);
    expect(CLASSIFIER).toMatch(/pickPipelineFailure/);
  });

  it("Rule 8b — queue inventory unavailable → WORKER_UNAVAILABLE", () => {
    expect(CLASSIFIER).toMatch(
      /queue_inventory_unavailable/,
    );
    expect(CLASSIFIER).toMatch(/classification:\s*"WORKER_UNAVAILABLE"/);
  });

  it("Rule 9 — catch-all → TRUE_EMPTY", () => {
    expect(CLASSIFIER).toMatch(/classification:\s*"TRUE_EMPTY"/);
  });

  it("classifier accepts the 6 EmptyStateDomain values", () => {
    for (const domain of [
      "graph",
      "timeline",
      "duplicates",
      "reviewers",
      "relationships",
      "overview",
    ]) {
      expect(CLASSIFIER).toMatch(new RegExp(`"${domain}"`));
    }
  });
});

// ===========================================================================
// Page migration
// ===========================================================================

describe("Wave 2 Phase 4 — page migration to classifier", () => {
  for (const page of PAGES) {
    it(`${page.path} imports classifyInvestigationEmptyState`, () => {
      expect(page.src).toMatch(/classifyInvestigationEmptyState/);
    });

    it(`${page.path} imports OperationalEmptyState`, () => {
      expect(page.src).toMatch(/from\s+["'].*OperationalEmptyState["']/);
      expect(page.src).toMatch(/OperationalEmptyState/);
    });

    it(`${page.path} passes the page's domain to the classifier`, () => {
      // Each migrated page calls classifyInvestigationEmptyState at least
      // once with a bounded domain literal. The literal MUST match the
      // page's canonical domain — we check both: the call site exists,
      // and one of the 6 domain string literals appears in the file.
      expect(page.src).toMatch(/classifyInvestigationEmptyState\s*\(/);
      const domainPattern = new RegExp(`"${page.domain}"`);
      expect(page.src).toMatch(domainPattern);
    });

    it(`${page.path} has NO hand-rolled empty-state divs with style={emptyStyle}`, () => {
      // Bounded grep: the regex captures the pattern reviewers used most often
      // (a <div style={emptyStyle}>...<p style={emptyTitleStyle}>...) which
      // is the canonical hand-rolled empty-state block. The migrated pages
      // render <OperationalEmptyState> instead — the <p style={emptyStyle}>
      // for the "Loading…" indicator is allowed and not matched here.
      expect(page.src).not.toMatch(
        /<div style={emptyStyle}>[\s\S]{0,400}<p style={emptyTitleStyle}>/,
      );
    });

    it(`${page.path} captures fetchError state for the classifier`, () => {
      // Every migrated page MUST track fetchError so the classifier can
      // resolve API_ERROR instead of silently misclassifying as TRUE_EMPTY.
      expect(page.src).toMatch(/setFetchError/);
    });
  }
});
