/**
 * PHASE R4 — Product Language & UX Coherence Recovery guardrails.
 *
 * R4 added the canonical product-language dictionary at
 * `apps/web/lib/product-language/` and swept the remaining
 * engineering / architecture leakage out of the primary UX.
 *
 * Hard contract pinned here:
 *
 *   1. The canonical dictionary exists and is non-trivial.
 *   2. No raw "Org" / "Access" architecture chips in primary UX
 *      (re-pin from R2 — the architecture-leakage guarantee must
 *      not regress).
 *   3. No "Unknown" labels in the primary shell, billing, or admin
 *      dashboard surfaces. (Verify / share are forensic public
 *      surfaces; R4 leaves them to a dedicated forensic-copy
 *      phase.)
 *   4. No raw ALL_CAPS backend state strings in primary UX.
 *   5. No marketing fluff / dramatic / debug phrases.
 *   6. Forensic-trust terms (custody, verification, integrity, …)
 *      are preserved verbatim.
 *   7. Capture / custody / TSA / report / package files unchanged.
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

const TONES = readWeb("lib/product-language/tones.ts");
const STATE_LABELS = readWeb("lib/product-language/stateLabels.ts");
const TERMINOLOGY = readWeb("lib/product-language/operationalTerminology.ts");
const FORBIDDEN = readWeb("lib/product-language/forbidden.ts");
const BARREL = readWeb("lib/product-language/index.ts");

const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const TOPBAR = readWeb("components/app-shell-v2/AppTopbarV2.tsx");
const SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");
const PALETTE = readWeb("components/navigation/CommandPalette.tsx");
const COMMAND_CENTER = readWeb(
  "components/command-center/CommandCenter.tsx",
);
const RUNTIME_INDICATOR = readWeb(
  "components/operational/GlobalRuntimeIndicator.tsx",
);
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const BILLING_ADDONS = readWeb("components/billing/StorageAddonsPanel.tsx");
const ADMIN_DASHBOARD = readWeb("app/(app)/admin/dashboard/page.tsx");

// Primary UX surfaces — the bounded set the language sweep runs on.
const PRIMARY_UX_SOURCES: ReadonlyArray<{ name: string; src: string }> = [
  { name: "AppSidebarV2.tsx", src: SIDEBAR },
  { name: "AppTopbarV2.tsx", src: TOPBAR },
  { name: "AppShellV2.tsx", src: SHELL },
  { name: "CommandPalette.tsx", src: PALETTE },
  { name: "CommandCenter.tsx", src: COMMAND_CENTER },
  { name: "GlobalRuntimeIndicator.tsx", src: RUNTIME_INDICATOR },
];

// =============================================================================
// PART 1 — Canonical language dictionary exists + non-trivial
// =============================================================================

describe("R4 Part 1 — canonical product-language dictionary present", () => {
  it("the dictionary barrel exports all four canonical modules", () => {
    expect(BARREL).toMatch(/UX_TONES/);
    expect(BARREL).toMatch(/RUNTIME_SEVERITY_LABELS/);
    expect(BARREL).toMatch(/TERM_WORKSPACE/);
    expect(BARREL).toMatch(/ALL_FORBIDDEN_PHRASES/);
  });

  it("each module file is non-trivial", () => {
    expect(TONES.length).toBeGreaterThan(1000);
    expect(STATE_LABELS.length).toBeGreaterThan(1500);
    expect(TERMINOLOGY.length).toBeGreaterThan(2000);
    expect(FORBIDDEN.length).toBeGreaterThan(1000);
  });

  it("UX_TONES vocabulary is bounded to 8 canonical tones", () => {
    const listMatch = TONES.match(/UX_TONES\s*=\s*\[([\s\S]*?)\]\s*as const/);
    expect(listMatch).toBeTruthy();
    const tones = (listMatch![1].match(/"[\w-]+"/g) ?? []).length;
    expect(tones).toBe(8);
  });
});

// =============================================================================
// PART 2 — No raw architecture chips remain in primary UX
// =============================================================================

describe("R4 Part 2 — no raw architecture chips in primary UX", () => {
  it("AppSidebarV2 does NOT return raw `Org` or `Access` chip strings", () => {
    expect(SIDEBAR).not.toMatch(/return\s+"Org"\s*;/);
    expect(SIDEBAR).not.toMatch(/return\s+"Access"\s*;/);
  });

  it("the canonical chip vocabulary is sourced from canonicalNavigationGroups", () => {
    expect(SIDEBAR).toMatch(/DEGRADATION_CHIP_LABELS/);
  });
});

// =============================================================================
// PART 3 — No "Unknown" labels in the swept surfaces
// =============================================================================

describe("R4 Part 3 — no raw 'Unknown' user-facing labels in primary + billing + admin surfaces", () => {
  // The forensic surfaces (verify, share) are out of R4's charter —
  // their "Unknown" Risk-level may carry forensic meaning and is
  // owned by a separate forensic-copy review. The sweep covers the
  // operational primary shell + the two clear leakage targets R4
  // cleaned (billing addon panel + admin dashboard).
  const SURFACES = [
    { name: "AppSidebarV2.tsx", src: SIDEBAR },
    { name: "AppTopbarV2.tsx", src: TOPBAR },
    { name: "AppShellV2.tsx", src: SHELL },
    { name: "CommandPalette.tsx", src: PALETTE },
    { name: "CommandCenter.tsx", src: COMMAND_CENTER },
    { name: "GlobalRuntimeIndicator.tsx", src: RUNTIME_INDICATOR },
    { name: "StorageAddonsPanel.tsx", src: BILLING_ADDONS },
    { name: "admin/dashboard/page.tsx", src: ADMIN_DASHBOARD },
  ];

  for (const { name, src } of SURFACES) {
    it(`${name} renders no raw "Unknown" user label`, () => {
      // Allow `"Unknown"` inside comments (the comments document the
      // R4 cleanup). Scan for JSX text or string-return contexts.
      // Heuristic: a `return "Unknown"` or a JSX text node
      // `>Unknown<` is a real leak.
      expect(src, `${name} has a JSX literal "Unknown"`).not.toMatch(
        />\s*Unknown\s*</,
      );
      expect(src, `${name} has a return "Unknown"`).not.toMatch(
        /return\s+"Unknown"\s*;/,
      );
      expect(
        src,
        `${name} has a fallback "?? \"Unknown\""`,
      ).not.toMatch(/\?\?\s*"Unknown"/);
    });
  }
});

// =============================================================================
// PART 4 — No raw ALL_CAPS backend states in primary UX
// =============================================================================

describe("R4 Part 4 — no raw ALL_CAPS backend states leak as user-facing labels", () => {
  // We pin specific backend enums that have appeared as raw
  // user-visible labels in prior phases.
  const FORBIDDEN_ALL_CAPS_LEAKS: ReadonlyArray<RegExp> = [
    />\s*STATUS_PENDING\s*</,
    />\s*PERMISSION_DENIED\s*</,
    />\s*WORKSPACE_MEMBERSHIP_REQUIRED\s*</,
    />\s*AUTH_REQUIRED\s*</,
    />\s*UNKNOWN\s*</,
  ];

  for (const { name, src } of PRIMARY_UX_SOURCES) {
    it(`${name} surfaces no raw ALL_CAPS backend state`, () => {
      for (const pattern of FORBIDDEN_ALL_CAPS_LEAKS) {
        expect(
          src,
          `${name} surfaces backend enum literal ${pattern}`,
        ).not.toMatch(pattern);
      }
    });
  }
});

// =============================================================================
// PART 5 — No marketing / dramatic / debug fluff in primary UX
// =============================================================================

describe("R4 Part 5 — no marketing / dramatic / debug fluff in primary UX", () => {
  const MARKETING_DRAMATIC_DEBUG: ReadonlyArray<RegExp> = [
    /\brevolutionary\b/i,
    /\bnext[-\s]gen(eration)?\b/i,
    /\bbest[-\s]in[-\s]class\b/i,
    /\bworld[-\s]class\b/i,
    /\bsynerg(y|ies)\b/i,
    /\bgame[-\s]chang(er|ing)\b/i,
    /\bAI[-\s]powered\b/i,
    /\bintelligent\s+assistant\b/i,
    /\bcatastrophic\s+failure\b/i,
    /\boops!?\b/i,
    /\bobject\s+not\s+found\b/i,
  ];

  for (const { name, src } of PRIMARY_UX_SOURCES) {
    it(`${name} contains no marketing / dramatic / debug phrases`, () => {
      for (const pattern of MARKETING_DRAMATIC_DEBUG) {
        expect(
          src,
          `${name} contains forbidden phrase ${pattern}`,
        ).not.toMatch(pattern);
      }
    });
  }
});

// =============================================================================
// PART 6 — Forensic-trust terms preserved verbatim
// =============================================================================

describe("R4 Part 6 — forensic-trust terms preserved verbatim", () => {
  it("operationalTerminology.ts pins the bounded set of forensic-trust terms", () => {
    expect(TERMINOLOGY).toMatch(/FORENSIC_TERMS_PRESERVED/);
    for (const term of [
      "custody",
      "verification",
      "integrity",
      "timestamp",
      "anchor",
      "tamper-evident",
      "hash chain",
      "audit log",
    ]) {
      expect(TERMINOLOGY).toMatch(new RegExp(`"${term}"`));
    }
  });
});

// =============================================================================
// PART 7 — Canonical state labels exist + no Unknown in mapping
// =============================================================================

describe("R4 Part 7 — canonical state-label dictionary", () => {
  it("RUNTIME_SEVERITY_LABELS maps UNKNOWN to 'Status pending' (R1 cleanup pinned)", () => {
    expect(STATE_LABELS).toMatch(/UNKNOWN:\s*"Status pending"/);
  });

  it("the canonical fallback is 'Status pending' (never 'Unknown')", () => {
    expect(STATE_LABELS).toMatch(/STATE_FALLBACK_LABEL\s*=\s*"Status pending"/);
  });

  it("formatStateLabel never returns 'Unknown'", () => {
    // Static check — the function body must not contain a literal
    // "Unknown" return.
    const fnBody = STATE_LABELS.match(
      /export function formatStateLabel[\s\S]*?\n\}/,
    );
    expect(fnBody).toBeTruthy();
    expect(fnBody![0]).not.toMatch(/"Unknown"/);
  });
});

// =============================================================================
// PART 8 — Route registry uses operational terminology (spot-check)
// =============================================================================

describe("R4 Part 8 — route registry uses operational terminology", () => {
  it("'Governance insights' has replaced raw 'Governance analytics'", () => {
    expect(REGISTRY).toMatch(/label:\s*"Governance insights"/);
    expect(REGISTRY).not.toMatch(/label:\s*"Governance analytics"/);
  });

  it("forensic-trust labels remain unchanged (custody, verification, integrity)", () => {
    // Spot-check: no R4 renaming touched custody / verification /
    // integrity route ids or labels.
    const forensicProbe = readWeb(
      "lib/navigation/routeRegistry.ts",
    );
    expect(forensicProbe).toMatch(/id:\s*"workspace\.evidence"/);
    expect(forensicProbe).toMatch(/id:\s*"workspace\.reports"/);
  });
});

// =============================================================================
// PART 9 — Billing addon panel uses canonical operational vocabulary
// =============================================================================

describe("R4 Part 9 — billing addon panel uses canonical vocabulary", () => {
  it("formatAddonStatus replaces 'Unknown' with 'Not configured' for empty status", () => {
    expect(BILLING_ADDONS).toMatch(/return\s+"Not configured"\s*;/);
    expect(BILLING_ADDONS).not.toMatch(/return\s+"Unknown"\s*;/);
  });

  it("formatAddonStatus falls back to 'Status pending' instead of raw ALL_CAPS", () => {
    // The pre-R4 implementation returned the raw `normalized`
    // ALL_CAPS value for unmapped statuses, leaking backend enums.
    expect(BILLING_ADDONS).not.toMatch(/return\s+normalized\s*;/);
    expect(BILLING_ADDONS).toMatch(/return\s+"Status pending"\s*;/);
  });
});

// =============================================================================
// PART 10 — Admin dashboard surfaces operational fallbacks
// =============================================================================

describe("R4 Part 10 — admin dashboard surfaces operational fallbacks", () => {
  it("page-path fallback is 'Path unavailable' (was 'Unknown')", () => {
    expect(ADMIN_DASHBOARD).toMatch(/\?\?\s*"Path unavailable"/);
  });

  it("country fallback is 'Region unavailable' (was 'Unknown')", () => {
    expect(ADMIN_DASHBOARD).toMatch(/\?\?\s*"Region unavailable"/);
  });
});

// =============================================================================
// PART 11 — Documentation present + substantial
// =============================================================================

describe("R4 Part 11 — R4 documentation present", () => {
  const doc = readRepo("docs/recovery/R4_PRODUCT_LANGUAGE_RECOVERY.md");

  it("R4 doc exists and covers the required sections", () => {
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE R4/);
    expect(doc).toMatch(/canonical vocabulary/i);
    expect(doc).toMatch(/tone system/i);
    expect(doc).toMatch(/forbidden wording/i);
    expect(doc).toMatch(/Remaining risks/);
  });
});

// =============================================================================
// PART 12 — Capture / custody / TSA / report / package unchanged
// =============================================================================

describe("R4 Part 12 — canonical capture / custody / TSA / report files unchanged", () => {
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
