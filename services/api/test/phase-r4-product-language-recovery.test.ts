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

import { readFileSync } from "node:fs";
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


const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const TOPBAR = readWeb("components/app-shell-v2/AppAccountToolbar.tsx");
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
  { name: "AppAccountToolbar.tsx", src: TOPBAR },
  { name: "AppShellV2.tsx", src: SHELL },
  { name: "CommandPalette.tsx", src: PALETTE },
  { name: "CommandCenter.tsx", src: COMMAND_CENTER },
  { name: "GlobalRuntimeIndicator.tsx", src: RUNTIME_INDICATOR },
];

// Forbidden-vocabulary patterns. Module-scoped so Part 6 can assert that
// none of them can ever match a preserved forensic-trust term.
//
// Specific backend enums that have appeared as raw user-visible labels.
const FORBIDDEN_ALL_CAPS_LEAKS: ReadonlyArray<RegExp> = [
  />\s*STATUS_PENDING\s*</,
  />\s*PERMISSION_DENIED\s*</,
  />\s*WORKSPACE_MEMBERSHIP_REQUIRED\s*</,
  />\s*AUTH_REQUIRED\s*</,
  />\s*UNKNOWN\s*</,
];

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

// =============================================================================
// PART 1 — Canonical language dictionary exists + non-trivial
// =============================================================================

// Phase 12 Point 4 (Pass E) — Part 1 used to assert that
// `apps/web/lib/product-language/*` existed and was "non-trivial" (file
// byte-length > N) and that its barrel re-exported four symbols. That
// dictionary had ZERO importers anywhere in the app: every live surface
// carries its own label table, so none of those assertions constrained a
// single rendered string. It was deleted as a shadow implementation, and
// with it these vacuous pins.
//
// The load-bearing half of R4 is untouched below: Parts 2–5 and 8 sweep
// the REAL primary-UX sources (`PRIMARY_UX_SOURCES` + the route registry)
// for architecture-chip leakage, raw ALL_CAPS backend states, and
// marketing/dramatic/debug phrasing, using patterns defined in this file.
// Those are what actually keep the shipped copy honest.
describe("R4 Part 1 — the language sweep runs on real product surfaces", () => {
  it("the swept set is the primary UX, not a dictionary of intentions", () => {
    // Guards against this suite degrading back into self-referential
    // checks: every swept source must be a real app file with content.
    expect(PRIMARY_UX_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const { name, src } of PRIMARY_UX_SOURCES) {
      expect(src.length, `${name} must be a real, non-empty surface`).toBeGreaterThan(500);
    }
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
    { name: "AppAccountToolbar.tsx", src: TOPBAR },
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
        `${name} has a fallback "?? "Unknown""`,
      ).not.toMatch(/\?\?\s*"Unknown"/);
    });
  }
});

// =============================================================================
// PART 4 — No raw ALL_CAPS backend states in primary UX
// =============================================================================

describe("R4 Part 4 — no raw ALL_CAPS backend states leak as user-facing labels", () => {
  // Patterns are module-scoped (see FORBIDDEN_ALL_CAPS_LEAKS above) so
  // Part 6 can prove none of them can ever match a forensic term.
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
  // Patterns are module-scoped (see MARKETING_DRAMATIC_DEBUG above).
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

const FORENSIC_TERMS_PRESERVED = [
  "custody",
  "verification",
  "integrity",
  "timestamp",
  "anchor",
  "tamper-evident",
  "hash chain",
  "audit log",
] as const;

describe("R4 Part 6 — forensic-trust terms preserved verbatim", () => {
  // Phase 12 Point 4 (Pass E) — retargeted. This used to assert that the
  // deleted dictionary file listed these eight strings, which constrained
  // nothing about the shipped product. The rule R4 actually protects is
  // that the language sweep must never soften forensic vocabulary, so it
  // is now enforced against the sweep itself.
  it("no forbidden-phrase pattern in this suite can match a forensic term", () => {
    for (const term of FORENSIC_TERMS_PRESERVED) {
      for (const pattern of [...FORBIDDEN_ALL_CAPS_LEAKS, ...MARKETING_DRAMATIC_DEBUG]) {
        expect(
          pattern.test(term),
          `forensic term "${term}" must never be treated as forbidden vocabulary (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("forensic vocabulary is still present in the shipped primary UX", () => {
    const allPrimaryUx = PRIMARY_UX_SOURCES.map((s) => s.src).join("\n").toLowerCase();
    for (const term of ["custody", "verification", "integrity"]) {
      expect(allPrimaryUx, `"${term}" must survive the language sweep`).toContain(term);
    }
  });
});

// =============================================================================
// PART 7 — Canonical state labels exist + no Unknown in mapping
// =============================================================================

describe("R4 Part 7 — canonical state labels on the live surfaces", () => {
  // Phase 12 Point 4 (Pass E) — retargeted from the deleted dictionary to
  // the components that actually render these labels.
  it("the runtime indicator maps UNKNOWN to 'Status pending' (R1 cleanup pinned)", () => {
    const indicator = readWeb("components/operational/GlobalRuntimeIndicator.tsx");
    expect(indicator).toMatch(/UNKNOWN:\s*"Status pending"/);
  });

  it("an unmapped backend enum degrades to 'Status pending', never a raw value", () => {
    const addons = readWeb("components/billing/StorageAddonsPanel.tsx");
    expect(addons).toMatch(/return "Status pending";\s*\n\s*}/);
    expect(addons).not.toMatch(/return\s+normalized\s*;/);
  });

  it("neither surface renders a bare 'Unknown' label", () => {
    for (const rel of [
      "components/operational/GlobalRuntimeIndicator.tsx",
      "components/billing/StorageAddonsPanel.tsx",
    ]) {
      const executable = readWeb(rel)
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(executable, `${rel} must not label state as "Unknown"`).not.toMatch(
        /["'`]Unknown["'`]/,
      );
    }
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
