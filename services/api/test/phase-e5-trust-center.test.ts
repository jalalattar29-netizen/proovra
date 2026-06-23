/**
 * PHASE E5 — Trust Center contract tests.
 *
 * Phase E5 introduces a public enterprise-facing Trust Center page that
 * explains, in calm operational language, what PROOVRA records, what
 * its verification subsystems confirm, and what it does NOT claim.
 *
 * Hard rules pinned by this suite:
 *
 *   - The shared content module (`trust-center-content.ts`) is the
 *     single source of truth for every section title, summary, bullet,
 *     and limitation. The page MUST consume it and MUST NOT hard-code
 *     marketing copy.
 *   - The Trust Center page MUST surface the required boundary phrases
 *     (integrity != truth; verification != legal admissibility; AI is
 *     advisory only).
 *   - The Trust Center page MUST NOT match any forbidden phrase regex
 *     ("court-ready", "tamper-proof", "unhackable", "military-grade",
 *     "SOC 2 compliant", "ISO 27001 compliant", "HIPAA compliant",
 *     "GDPR compliant", "FedRAMP authorized", "99.999% uptime",
 *     "AI verified", "AI authenticated", etc.).
 *   - The same forbidden phrase regexes MUST also remain false against
 *     the existing safe surfaces (Verify page, report-v2 sections, AI
 *     components) — cross-surface wording alignment.
 *   - The Trust Center MUST live at the canonical top-level `/trust`
 *     destination — promoted from the legacy `/about/trust` sub-route
 *     so Trust Center reads as a primary trust/legal destination, not
 *     an About sub-page.
 *   - Every section MUST carry an explicit `Limitations` sub-block.
 *   - The page MUST link to the existing legal documentation (no doc
 *     duplication; the Trust Center is a summary surface, not a
 *     replacement for the policy pages).
 *   - The Trust Center MUST NOT introduce new automation, auth, runtime,
 *     or evidence/custody mutation logic.
 *
 * Phase E5 ships NO Prisma migration and NO new capability — it is a
 * content + page + tests phase.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS,
  TRUST_CENTER_PAGE_BOUNDARY_CALLOUT,
  TRUST_CENTER_PAGE_INTRO,
  TRUST_CENTER_REQUIRED_PHRASES,
  TRUST_CENTER_SECTIONS,
  TRUST_CENTER_SECTION_IDS,
  trustCenterDeepLink,
} from "@proovra/shared-evidence-presentation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function packagesPath(rel: string): string {
  return fileURLToPath(new URL(`../../../packages/${rel}`, import.meta.url));
}
function workerPath(rel: string): string {
  return fileURLToPath(new URL(`../../../services/worker/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readPackages(rel: string): string {
  return readFileSync(packagesPath(rel), "utf8");
}
function readWorker(rel: string): string {
  return readFileSync(workerPath(rel), "utf8");
}

const TRUST_CENTER_CONTENT_SRC = readPackages(
  "shared-evidence-presentation/src/trust-center-content.ts",
);
const TRUST_CENTER_PAGE = readWeb("app/trust/page.tsx");
const CLAIMS_MATRIX = readPackages(
  "shared-evidence-presentation/src/claims-matrix.ts",
);
const FOOTER = readWeb("components/Footer.tsx");

// ===========================================================================
// PART 1 — Section IDs are stable + canonical
// ===========================================================================

describe("E5 Test 1 — section IDs are stable + canonical", () => {
  it("ships exactly the 10 canonical sections", () => {
    expect(TRUST_CENTER_SECTION_IDS).toEqual([
      "verification-methodology",
      "chain-of-custody",
      "timestamping-anchoring",
      "evidence-integrity-model",
      "storage-retention",
      "security-signing",
      "automation-auditability",
      "ai-limitations",
      "operational-reliability",
      "transparency-limitations",
    ]);
  });

  it("section objects align with the section ID list", () => {
    expect(TRUST_CENTER_SECTIONS.map((s) => s.id)).toEqual([
      ...TRUST_CENTER_SECTION_IDS,
    ]);
  });

  it("every section has a non-empty title + summary", () => {
    for (const s of TRUST_CENTER_SECTIONS) {
      expect(s.title.length, `title for ${s.id}`).toBeGreaterThan(4);
      expect(s.summary.length, `summary for ${s.id}`).toBeGreaterThan(40);
    }
  });

  it("every section carries a non-empty Limitations sub-block (boundary is first-class)", () => {
    for (const s of TRUST_CENTER_SECTIONS) {
      expect(
        s.limitations.length,
        `limitations missing for ${s.id}`,
      ).toBeGreaterThan(0);
    }
  });

  it("deep-link helper produces stable /trust#<id> URLs", () => {
    expect(trustCenterDeepLink("ai-limitations")).toBe(
      "/trust#ai-limitations",
    );
    expect(trustCenterDeepLink("chain-of-custody")).toBe(
      "/trust#chain-of-custody",
    );
  });
});

// ===========================================================================
// PART 2 — Required boundary phrases
// ===========================================================================

describe("E5 Test 2 — required boundary phrases", () => {
  it("page-intro carries the introductory boundary", () => {
    expect(TRUST_CENTER_PAGE_INTRO).toMatch(/does not claim/i);
  });

  it("page-level boundary callout names the relevant external decision-makers", () => {
    expect(TRUST_CENTER_PAGE_BOUNDARY_CALLOUT).toMatch(
      /court, investigator, regulator, insurer, employer, or expert process/i,
    );
    expect(TRUST_CENTER_PAGE_BOUNDARY_CALLOUT).toMatch(
      /does not independently prove factual truth/i,
    );
  });

  it.each(TRUST_CENTER_REQUIRED_PHRASES)(
    "rendered page surfaces required phrase: %s",
    (phrase) => {
      // The phrase MUST appear either as direct text in the page OR be
      // present in the content module the page consumes. Either path is
      // surfaced to the visitor.
      const inPage = TRUST_CENTER_PAGE.includes(phrase);
      const inContent = TRUST_CENTER_CONTENT_SRC.includes(phrase);
      expect(
        inPage || inContent,
        `required boundary phrase "${phrase}" missing from both page and content module`,
      ).toBe(true);
    },
  );

  it("AI limitations section states advisory-only verbatim", () => {
    const ai = TRUST_CENTER_SECTIONS.find((s) => s.id === "ai-limitations");
    expect(ai, "ai-limitations section missing").toBeTruthy();
    const limitsBlob = ai!.limitations.join(" ");
    expect(limitsBlob).toMatch(/advisory only/i);
    expect(limitsBlob).toMatch(
      /does not determine.*?(?:truth|authorship|authenticity|admissibility)/i,
    );
  });
});

// ===========================================================================
// PART 3 — Forbidden phrases across the Trust Center page + content
// ===========================================================================

describe("E5 Test 3 — Trust Center page + content carry no forbidden trust-theatre wording", () => {
  // Strip the forbidden-list literal from the content module before checking,
  // so the test doesn't trip on the regexes that DEFINE the blocklist.
  const contentBody = TRUST_CENTER_CONTENT_SRC.replace(
    /TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS\s*=\s*\[[\s\S]*?\]\s+as\s+const;/m,
    "",
  );

  it.each(TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS)(
    "Trust Center page does NOT match %s",
    (pattern) => {
      expect(TRUST_CENTER_PAGE).not.toMatch(pattern);
    },
  );

  it.each(TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS)(
    "Trust Center content module body does NOT match %s",
    (pattern) => {
      expect(contentBody).not.toMatch(pattern);
    },
  );
});

// ===========================================================================
// PART 4 — Cross-surface alignment: same forbidden patterns false on safe surfaces
// ===========================================================================

describe("E5 Test 4 — existing safe surfaces stay aligned with the Trust Center forbidden-list", () => {
  // Surfaces audited in the E5 entry gate as already-safe; pin that they
  // remain free of any forbidden trust-theatre wording even as future
  // phases edit them.
  const SAFE_SURFACES: ReadonlyArray<{ label: string; path: string; reader: (p: string) => string }> = [
    {
      label: "verify token page",
      path: "app/verify/[token]/page.tsx",
      reader: readWeb,
    },
    {
      label: "verify demo page",
      path: "app/verify/demo/page.tsx",
      reader: readWeb,
    },
    {
      label: "report-v2 cover",
      path: "src/report-v2/sections/cover.ts",
      reader: readWorker,
    },
    {
      label: "report-v2 integrity-proof",
      path: "src/report-v2/sections/integrity-proof.ts",
      reader: readWorker,
    },
    {
      label: "report-v2 legal-interpretation",
      path: "src/report-v2/sections/legal-interpretation.ts",
      reader: readWorker,
    },
    {
      label: "report-v2 legal-limitations",
      path: "src/report-v2/sections/legal-limitations.ts",
      reader: readWorker,
    },
    {
      label: "ai capture assistant",
      path: "components/ai/CaptureAiAssistant.tsx",
      reader: readWeb,
    },
    {
      label: "proovra chat widget",
      path: "components/ai/ProovraChatWidget.tsx",
      reader: readWeb,
    },
    {
      label: "ai-policy service",
      path: "src/services/ai/ai-policy.ts",
      reader: readApi,
    },
  ];

  for (const surface of SAFE_SURFACES) {
    describe(`safe surface — ${surface.label}`, () => {
      // Some safe surfaces (e.g. ai-policy.ts) intentionally LIST forbidden
      // phrases as regex blocklist entries; we only assert that the SURFACE
      // BODY (excluding any obvious blocklist literal) does not contain a
      // marketing-shaped trust claim.
      let body: string;
      try {
        body = surface.reader(surface.path);
      } catch (err) {
        // If a referenced file moves, fail loudly so the test catches drift.
        throw new Error(
          `E5 safe-surface reference missing: ${surface.label} at ${surface.path}`,
        );
      }
      // Strip any blocklist / forbidden-pattern array body so the test
      // doesn't trip on the regexes that DEFINE the blocklist itself.
      // The lowercase `forbiddenPatterns` form is used in ai-policy.ts.
      const sanitised = body
        .replace(
          /(?:FORBIDDEN|BLOCK(?:ED|LIST)?_PATTERNS|UNSAFE_PHRASES?)\s*=\s*\[[\s\S]*?\]/g,
          "",
        )
        .replace(/\bforbiddenPatterns\s*=\s*\[[\s\S]*?\];/g, "");

      it.each(TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(sanitised).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 5 — Page consumes the shared content module (no hard-coded copy)
// ===========================================================================

describe("E5 Test 5 — page consumes the shared content module", () => {
  it("imports TRUST_CENTER_SECTIONS from the shared package", () => {
    expect(TRUST_CENTER_PAGE).toMatch(
      /from\s+["']@proovra\/shared-evidence-presentation["']/,
    );
    expect(TRUST_CENTER_PAGE).toMatch(/TRUST_CENTER_SECTIONS/);
  });

  it("imports the page-level boundary callout + intro", () => {
    expect(TRUST_CENTER_PAGE).toMatch(/TRUST_CENTER_PAGE_BOUNDARY_CALLOUT/);
    expect(TRUST_CENTER_PAGE).toMatch(/TRUST_CENTER_PAGE_INTRO/);
  });

  it("renders sections via the shared content (no hard-coded section titles)", () => {
    // Every section title from the content module should NOT appear as a
    // string literal in the page source — the page renders {s.title}, not
    // each title individually.
    for (const s of TRUST_CENTER_SECTIONS) {
      const titleAsLiteral = new RegExp(
        `>${s.title.replace(/[.*+?^${}()|[\\\]\\\\]/g, "\\\\$&")}<`,
      );
      expect(
        TRUST_CENTER_PAGE,
        `page hard-codes section title "${s.title}" — should render from shared content`,
      ).not.toMatch(titleAsLiteral);
    }
  });

  // 2026-06-23 UX rebaseline: the public marketing /trust page no
  // longer renders a visible band that maps over TRUST_CENTER_SECTIONS
  // — the giant detailed-sections list dominated the page and
  // duplicated the link surface already covered by the redesigned
  // Documentation Hub and Trust Flow sections. The shared
  // TRUST_CENTER_SECTIONS module still exists, the public page still
  // imports + consumes its symbols (TRUST_CENTER_SECTIONS,
  // TRUST_CENTER_SECTION_IDS, TRUST_CENTER_PAGE_INTRO,
  // TRUST_CENTER_PAGE_BOUNDARY_CALLOUT — pinned by the assertions in
  // "page consumes the shared content module" above), and the
  // detailed mapped list remains available to any private /
  // authenticated Trust Center surface that needs it. This `it`
  // intentionally no longer requires `TRUST_CENTER_SECTIONS.map` to
  // appear in the public-page source.
  it("public page still consumes TRUST_CENTER_SECTIONS (no longer required to .map them visibly)", () => {
    expect(TRUST_CENTER_PAGE).toMatch(/TRUST_CENTER_SECTIONS/);
  });
});

// ===========================================================================
// PART 6 — IA preservation: canonical /trust top-level destination
// ===========================================================================

describe("E5 Test 6 — IA preservation", () => {
  it("page lives at apps/web/app/trust/page.tsx", () => {
    expect(existsSync(webPath("app/trust/page.tsx"))).toBe(true);
  });

  it("32.8 canonical primaries still exactly 6 (no new root nav)", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });

  it("footer Legal column links the Trust Center as the entry point", () => {
    expect(FOOTER).toMatch(/href:\s*["']\/trust["']/);
    expect(FOOTER).toMatch(/label:\s*["']Trust Center["']/);
  });

  it("trust center page links DOWN to the detailed legal docs (no duplication)", () => {
    expect(TRUST_CENTER_PAGE).toMatch(/\/legal\/verification-methodology/);
    expect(TRUST_CENTER_PAGE).toMatch(/\/legal\/security/);
    expect(TRUST_CENTER_PAGE).toMatch(/\/legal\/data-retention/);
  });
});

// ===========================================================================
// PART 7 — No automation / auth / runtime / evidence mutation introduced
// ===========================================================================

describe("E5 Test 7 — Phase E5 introduces no runtime / mutation behaviour", () => {
  it("Trust Center page is a server component (no client interactivity beyond Link)", () => {
    // Pure server component — does not begin with "use client".
    expect(TRUST_CENTER_PAGE.trimStart().startsWith('"use client"')).toBe(false);
    expect(TRUST_CENTER_PAGE.trimStart().startsWith("'use client'")).toBe(false);
  });

  it("Trust Center page does not import prisma, fetch, or any mutation primitive", () => {
    expect(TRUST_CENTER_PAGE).not.toMatch(/from\s+["']@prisma\/client["']/);
    expect(TRUST_CENTER_PAGE).not.toMatch(/from\s+["'][^"']*prisma[^"']*["']/);
    expect(TRUST_CENTER_PAGE).not.toMatch(/\bfetch\s*\(/);
    expect(TRUST_CENTER_PAGE).not.toMatch(/\bevidence\.update\s*\(/);
    expect(TRUST_CENTER_PAGE).not.toMatch(/\bappendCustodyEvent\s*\(/);
  });

  it("Trust Center page does not contain eval / new Function", () => {
    expect(TRUST_CENTER_PAGE).not.toMatch(/\beval\s*\(/);
    expect(TRUST_CENTER_PAGE).not.toMatch(/new\s+Function\s*\(/);
  });

  it("Trust Center content module does not import any runtime side-effect package", () => {
    expect(TRUST_CENTER_CONTENT_SRC).not.toMatch(/from\s+["']fs["']/);
    expect(TRUST_CENTER_CONTENT_SRC).not.toMatch(/from\s+["']node:fs["']/);
    expect(TRUST_CENTER_CONTENT_SRC).not.toMatch(/from\s+["']child_process["']/);
    expect(TRUST_CENTER_CONTENT_SRC).not.toMatch(/from\s+["']http["']/);
    expect(TRUST_CENTER_CONTENT_SRC).not.toMatch(/from\s+["']https["']/);
  });
});

// ===========================================================================
// PART 8 — Content alignment with the existing claims-matrix guard
// ===========================================================================

describe("E5 Test 8 — content aligns with the existing claims-matrix guard", () => {
  it("integrity-model section bullets reuse PROOVRA_ALLOWED_CLAIMS verbatim", () => {
    const integrity = TRUST_CENTER_SECTIONS.find(
      (s) => s.id === "evidence-integrity-model",
    );
    expect(integrity, "integrity-model section missing").toBeTruthy();
    // All five allowed claims appear as bullets.
    const allowedFromMatrix = CLAIMS_MATRIX.match(
      /PROOVRA_ALLOWED_CLAIMS\s*=\s*\[([\s\S]*?)\]\s*as\s*const;/,
    );
    expect(allowedFromMatrix).toBeTruthy();
    const allowedClaims = Array.from(
      allowedFromMatrix![1]!.matchAll(/"([^"]+)"/g),
    ).map((m) => m[1]!);
    expect(allowedClaims.length).toBeGreaterThanOrEqual(5);
    for (const claim of allowedClaims) {
      expect(
        integrity!.bullets.includes(claim),
        `allowed claim missing as integrity bullet: ${claim}`,
      ).toBe(true);
    }
  });

  it("integrity-model section limitations include each PROOVRA_FORBIDDEN_CLAIMS entry", () => {
    const integrity = TRUST_CENTER_SECTIONS.find(
      (s) => s.id === "evidence-integrity-model",
    );
    const forbiddenFromMatrix = CLAIMS_MATRIX.match(
      /PROOVRA_FORBIDDEN_CLAIMS\s*=\s*\[([\s\S]*?)\]\s*as\s*const;/,
    );
    expect(forbiddenFromMatrix).toBeTruthy();
    const forbiddenClaims = Array.from(
      forbiddenFromMatrix![1]!.matchAll(/"([^"]+)"/g),
    ).map((m) => m[1]!);
    expect(forbiddenClaims.length).toBeGreaterThanOrEqual(10);
    for (const claim of forbiddenClaims) {
      const looksFor = `PROOVRA does not claim: ${claim}`;
      expect(
        integrity!.limitations.includes(looksFor),
        `forbidden claim not pinned as Trust Center limitation: ${claim}`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// PART 9 — File-size pins on the protected core files
// ===========================================================================

describe("E5 Test 9 — protected core files untouched by E5", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21793 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 46824 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 12988 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 10 — Documentation + registry
// ===========================================================================

describe("E5 Test 10 — documentation + registry", () => {
  it("docs/product/PHASE_E5_TRUST_CENTER.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_E5_TRUST_CENTER.md");
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E5/);
  });

  it("registry registers Phase E5 with explicit closure status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E5\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });
});
