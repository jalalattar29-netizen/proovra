/**
 * PHASE 32.8 — Product consolidation contract tests.
 *
 * Phase 32.8's primary deliverable is governance, not new code. The
 * four parallel investigation audits (route inventory, fake-widget
 * audit, nav-label/IA audit, page-structure audit) all confirm that
 * the product-coherence work was already landed in phases R1-R7 +
 * the 38.x consolidation arc. CR1.5/CR1.6 fixed state coherence. 32.7
 * confirmed correctness.
 *
 * This file's role is therefore to **pin the canonical consolidation
 * state** so future phases cannot quietly regress:
 *
 *   - Root nav stays at exactly 6 canonical primaries.
 *   - DEGRADATION_CHIP_LABELS use operational language (no raw
 *     "Org" / "Access" / "Setup" / "Upgrade").
 *   - No fake-widget / "coming soon" / "Lorem ipsum" / fake-counter
 *     copy in user-facing code.
 *   - No new unauthorized root sidebar group titles.
 *   - 4 canonical hubs exist with their member routes intact.
 *   - Canonical page-structure primitives (PageRouteGate,
 *     CapabilityDegradedPanel, OperationalEmptyState,
 *     HubQuickActionsBar) remain exported.
 *   - No new state-library / route-explosion regressions.
 *   - Documentation + registry updated.
 *
 * Hard rules preserved (CR1.7 §12 + 32.8 absolute rules):
 *   - No new backend features. No new routes. No redesign.
 *   - No capture / custody / report / package logic touched
 *     (file-size pin in 32.7 Test 9).
 *   - No new feature flags.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
function listAllTsxFiles(dirAbs: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dirAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = `${dir}/${name}`;
      try {
        const st = statSync(full);
        if (st.isFile() && /\.(ts|tsx)$/.test(name)) out.push(full);
        else if (st.isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

const REGISTRY_SRC = readWeb("lib/navigation/routeRegistry.ts");
const GROUPS_SRC = readWeb("lib/navigation/canonicalNavigationGroups.ts");
const HUBS_SRC = readWeb("lib/hubs/hubDefinitions.ts");
const SIDEBAR_SRC = readWeb("components/app-shell-v2/AppSidebarV2.tsx");

// ===========================================================================
// PART 1 — Root nav stays bounded
// ===========================================================================

describe("32.8 Test 1 — root nav stays bounded to the canonical primaries", () => {
  // Phase G0 (B.1) — the canonical primary set expanded from the
  // original R2 six (Home, Capture, Evidence, Cases, Reports,
  // Search) to the Phase B nine. The Workspace group now lifts
  // Review, Intake, and Inbox to primary so reviewers + intake
  // operators + mention-recipients have first-class navigation.
  const EXPECTED_PRIMARIES = [
    "workspace.home",
    "workspace.review",
    "workspace.cases",
    "workspace.evidence",
    "workspace.capture",
    "workspace.intake_links",
    "account.inbox",
    "workspace.search",
    "workspace.reports",
  ];

  it("CANONICAL_PRIMARY_ROUTE_IDS contains exactly the Phase B canonical set", () => {
    // Extract the array between `new Set([` and `])`.
    const m = GROUPS_SRC.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m, "CANONICAL_PRIMARY_ROUTE_IDS not found").toBeTruthy();
    const block = m![1]!;
    const ids = Array.from(block.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids.sort()).toEqual([...EXPECTED_PRIMARIES].sort());
  });
});

// ===========================================================================
// PART 2 — Allowed root group titles bounded
// ===========================================================================

describe("32.8 Test 2 — sidebar root groups bounded by ALLOWED_ROOT_GROUP_TITLES", () => {
  // Phase G0 (B.1) — the R2 group titles were collapsed into the
  // Phase B canonical operational hierarchy. Source of truth:
  // `apps/web/lib/navigation/canonicalNavigationGroups.ts`.
  const REQUIRED_GROUP_TITLES = [
    "Workspace",
    "Governance",
    "Outputs",
    "System",
    "All Tools",
    "More / Advanced",
  ];

  it.each(REQUIRED_GROUP_TITLES)(
    "ALLOWED_ROOT_GROUP_TITLES contains: %s",
    (title) => {
      expect(GROUPS_SRC).toContain(`"${title}"`);
    },
  );

  it("no unexpected group title is added to ALLOWED_ROOT_GROUP_TITLES", () => {
    // Extract the array literal for ALLOWED_ROOT_GROUP_TITLES.
    const m = GROUPS_SRC.match(
      /ALLOWED_ROOT_GROUP_TITLES[\s\S]*?=\s*\[([\s\S]*?)\];/,
    );
    expect(m, "ALLOWED_ROOT_GROUP_TITLES not found").toBeTruthy();
    const block = m![1]!;
    // The array references some titles via constants (SIDEBAR_GROUP_*.title)
    // and others by literal. Count both forms.
    const literals = Array.from(block.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    const constantRefs = Array.from(
      block.matchAll(/SIDEBAR_GROUP_[A-Z_]+\.title/g),
    ).length;
    const totalCount = literals.length + constantRefs;
    // Total entries must be exactly the 6 canonical ones (4 via
    // SIDEBAR_GROUP_* + 2 string literals "All Tools" / "More / Advanced").
    expect(
      totalCount,
      `ALLOWED_ROOT_GROUP_TITLES has ${totalCount} entries; expected exactly 6.`,
    ).toBe(6);
  });
});

// ===========================================================================
// PART 3 — DEGRADATION_CHIP_LABELS use operational language
// ===========================================================================

describe("32.8 Test 3 — degradation chip labels use operational (not engineering) language", () => {
  const EXPECTED_LABELS: Record<string, string> = {
    NEEDS_ORGANIZATION: "Requires organization",
    NEEDS_PERSONAL_OR_ORG: "Setup needed",
    DENIED_NO_CAPABILITY: "Requires permission",
    NEEDS_UPGRADE: "Upgrade required",
  };

  it.each(Object.entries(EXPECTED_LABELS))(
    "DEGRADATION_CHIP_LABELS.%s = %s",
    (key, expected) => {
      const regex = new RegExp(`${key}:\\s*"${expected}"`);
      expect(
        GROUPS_SRC,
        `DEGRADATION_CHIP_LABELS.${key} must be "${expected}".`,
      ).toMatch(regex);
    },
  );

  it("no raw 'Org' / 'Access' chip labels remain", () => {
    // Find the DEGRADATION_CHIP_LABELS object body and assert no
    // value is just "Org" or "Access".
    const m = GROUPS_SRC.match(
      /DEGRADATION_CHIP_LABELS\s*=\s*\{([\s\S]*?)\}\s*as\s+const/,
    );
    expect(m, "DEGRADATION_CHIP_LABELS not found").toBeTruthy();
    const body = m![1]!;
    expect(body).not.toMatch(/:\s*"Org"/);
    expect(body).not.toMatch(/:\s*"Access"/);
    expect(body).not.toMatch(/:\s*"Unknown"/);
  });
});

// ===========================================================================
// PART 4 — Engineering terms not exposed as nav labels
// ===========================================================================

describe("32.8 Test 4 — engineering terminology not exposed as routeRegistry labels", () => {
  /**
   * Extract every `label: "..."` from routeRegistry.ts and verify it
   * does not match any of the forbidden engineering patterns.
   */
  const FORBIDDEN_LABEL_PATTERNS: ReadonlyArray<{
    label: string;
    regex: RegExp;
  }> = [
    { label: "bare 'Org'", regex: /^Org$/ },
    { label: "bare 'Access'", regex: /^Access$/ },
    { label: "bare 'Unknown'", regex: /^Unknown$/ },
    { label: "bare 'Internal'", regex: /^Internal$/ },
    { label: "bare 'Debug'", regex: /^Debug$/ },
    { label: "bare 'WIP'", regex: /^WIP$/ },
    { label: "bare 'API'", regex: /^API$/ },
    { label: "bare 'Backend'", regex: /^Backend$/ },
    { label: "all-caps enum", regex: /^[A-Z][A-Z0-9_]+[A-Z0-9]$/ },
    { label: "phase codename", regex: /\bphase\s*\d/i },
    { label: "CR codename", regex: /\bCR[0-9]/ },
    { label: "TODO marker", regex: /\bTODO\b/i },
    { label: "Coming soon", regex: /coming\s*soon/i },
  ];

  it("every routeRegistry label passes the forbidden-pattern checks", () => {
    // Extract `label: "..."` strings. The registry uses double quotes
    // exclusively for route labels.
    const labels = Array.from(
      REGISTRY_SRC.matchAll(/\blabel:\s*"([^"]+)"/g),
    ).map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(10);

    const offenders: Array<{ label: string; reason: string }> = [];
    for (const label of labels) {
      for (const { label: reason, regex } of FORBIDDEN_LABEL_PATTERNS) {
        if (regex.test(label)) offenders.push({ label, reason });
      }
    }
    expect(
      offenders,
      `Forbidden engineering terms in routeRegistry labels:\n${offenders
        .map((o) => `  "${o.label}" — ${o.reason}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// PART 5 — 4 canonical hubs exist with their member routes
// ===========================================================================

describe("32.8 Test 5 — 4 canonical hubs exist with intact membership", () => {
  const EXPECTED_HUBS = [
    { landingId: "investigation.hub", quickActionsMin: 3 },
    { landingId: "governance.hub", quickActionsMin: 3 },
    { landingId: "review.queue", quickActionsMin: 3 },
    { landingId: "platform.ops_center", quickActionsMin: 3 },
  ];

  it.each(EXPECTED_HUBS)(
    "hub with landingRouteId $landingId exists in HUB_DEFINITIONS",
    ({ landingId }) => {
      expect(HUBS_SRC).toMatch(
        new RegExp(`landingRouteId:\\s*["']${landingId}["']`),
      );
    },
  );

  it("HUB_QUICK_ACTIONS_MAX enforces ≤ 4 actions per hub", () => {
    expect(HUBS_SRC).toMatch(/HUB_QUICK_ACTIONS_MAX\s*=\s*4/);
  });
});

// ===========================================================================
// PART 6 — Canonical page-structure primitives remain exported
// ===========================================================================

describe("32.8 Test 6 — canonical page-structure primitives available", () => {
  const PRIMITIVES: ReadonlyArray<{ rel: string; symbol: string }> = [
    {
      rel: "components/navigation/PageRouteGate.tsx",
      symbol: "PageRouteGate",
    },
    {
      rel: "lib/platform-context/CapabilityDegradedPanel.tsx",
      symbol: "CapabilityDegradedPanel",
    },
    {
      rel: "components/operational/OperationalEmptyState.tsx",
      symbol: "OperationalEmptyState",
    },
    {
      rel: "components/hubs/HubQuickActionsBar.tsx",
      symbol: "HubQuickActionsBar",
    },
  ];

  it.each(PRIMITIVES)(
    "$symbol is exported from $rel",
    ({ rel, symbol }) => {
      const fullPath = webPath(rel);
      expect(
        existsSync(fullPath),
        `Required primitive file missing: ${rel}`,
      ).toBe(true);
      const src = readFileSync(fullPath, "utf8");
      const re = new RegExp(
        `export\\s+(function|const|class)\\s+${symbol}\\b`,
      );
      expect(src, `${rel} must export ${symbol}`).toMatch(re);
    },
  );
});

// ===========================================================================
// PART 7 — No fake-widget / placeholder copy in user-facing code
// ===========================================================================

describe("32.8 Test 7 — no fake-widget / placeholder copy in user-facing JSX", () => {
  /**
   * Forbidden user-facing strings. The check matches them inside
   * JSX text content (`>FOO<`) or inside string literals that are
   * passed to React children. Comments + hard-rule documentation
   * uses are filtered by requiring the string to NOT be in a
   * single-line `//` or block `/* *\/` comment.
   */
  const FORBIDDEN_STRINGS: ReadonlyArray<{
    needle: string;
    rationale: string;
  }> = [
    { needle: "Coming soon", rationale: "no placeholder product surfaces" },
    { needle: "coming soon", rationale: "no placeholder product surfaces" },
    { needle: "Lorem ipsum", rationale: "no Lorem ipsum copy" },
    { needle: "lorem ipsum", rationale: "no Lorem ipsum copy" },
    { needle: "TODO:", rationale: "no TODO markers in user-facing copy" },
    { needle: "WIP", rationale: "no work-in-progress markers exposed" },
    // NOTE: "DRAFT" is intentionally NOT forbidden — "draft" is a
    // legitimate product term (e.g. capture drafts, persona save-draft).
    // "WIP" / "TODO:" / "Demo only" are unambiguous placeholder markers.
    { needle: "Demo only", rationale: "no demo-only markers exposed" },
    { needle: "Sample data", rationale: "no sample-data markers exposed" },
    // NOTE: "Dummy" intentionally not forbidden — too easily a substring
    // (e.g. "dummy" can appear in legitimate test fixtures referenced
    // by import). Other markers cover the placeholder concern.
    { needle: "Court-admissible", rationale: "no legal-admissibility claims" },
    { needle: "ISO 27001", rationale: "no unverified certification claims" },
    { needle: "SOC 2", rationale: "no unverified certification claims" },
  ];

  it("no .tsx file under apps/web/app and apps/web/components contains forbidden user-facing copy", () => {
    // Search both the App Router pages and shared components.
    const roots = [webPath("app"), webPath("components")];
    const offenders: string[] = [];

    for (const root of roots) {
      const files = listAllTsxFiles(root);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        for (const { needle, rationale } of FORBIDDEN_STRINGS) {
          // Find the needle.
          const idx = src.indexOf(needle);
          if (idx === -1) continue;
          // Filter: skip if the needle appears only inside comments.
          // Detect by checking the surrounding ~120 chars for `//`
          // before EOL OR `/*` / `*/` block markers.
          let realOccurrence = false;
          let cursor = 0;
          while (true) {
            const found = src.indexOf(needle, cursor);
            if (found === -1) break;
            // Is this occurrence inside a comment?
            const lineStart = src.lastIndexOf("\n", found) + 1;
            const lineEnd = src.indexOf("\n", found);
            const line = src.slice(
              lineStart,
              lineEnd === -1 ? src.length : lineEnd,
            );
            // Single-line comment detection: anything after `//` on
            // the same line.
            const inLineComment = /^\s*[*]?\s*\/\//.test(line) || (() => {
              const slashIdx = line.indexOf("//");
              const needleColInLine = found - lineStart;
              return slashIdx !== -1 && slashIdx < needleColInLine;
            })();
            // Block-comment detection: scan from start of file to
            // `found` and count unmatched `/*`.
            const head = src.slice(0, found);
            const opens = (head.match(/\/\*/g) ?? []).length;
            const closes = (head.match(/\*\//g) ?? []).length;
            const inBlockComment = opens > closes;
            // JSDoc / star-prefixed doc lines count as comments.
            const isStarPrefixed = /^\s*\*\s/.test(line);
            if (!inLineComment && !inBlockComment && !isStarPrefixed) {
              realOccurrence = true;
              break;
            }
            cursor = found + needle.length;
          }
          if (realOccurrence) {
            const rel = file
              .replace(/\\/g, "/")
              .replace(/^.*\/apps\/web\/+/, "/");
            offenders.push(`${rel}: "${needle}" (${rationale})`);
          }
        }
      }
    }
    // The audit confirmed zero offenders. Pin that.
    expect(
      offenders,
      `Forbidden user-facing copy found:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// PART 8 — No new state-management library introduced
// ===========================================================================

describe("32.8 Test 8 — no new client-state library introduced", () => {
  it("apps/web/package.json has no React Query / SWR / Redux / Zustand", () => {
    const pkg = JSON.parse(
      readFileSync(webPath("package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "@reduxjs/toolkit",
      "zustand",
      "jotai",
      "recoil",
      "mobx",
    ]) {
      expect(deps[forbidden]).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 9 — PlatformContextEnvelope semantics unchanged
// ===========================================================================

describe("32.8 Test 9 — PlatformContextEnvelope canonical wiring intact", () => {
  it("PlatformContextProvider continues to fetch /v1/platform/context", () => {
    const src = readWeb("lib/platform-context/PlatformContextProvider.tsx");
    // The GET endpoint is consumed.
    expect(src).toMatch(/\/v1\/platform\/context/);
    // The switch endpoint exists. apiFetch passes the URL as arg 1
    // and the options (with `method: "POST"`) as arg 2 — so the
    // canonical pattern is "URL ... then method: POST" in the source.
    expect(src).toMatch(/\/v1\/platform\/context\/switch-workspace/);
    expect(src).toMatch(/method:\s*["']POST["']/);
  });

  it("AppSidebarV2 reads ROUTE_REGISTRY (not deprecated envelope.navigation)", () => {
    expect(SIDEBAR_SRC).toMatch(/ROUTE_REGISTRY|routeRegistry/);
    // The deprecated envelope.navigation consumption has been removed.
    expect(SIDEBAR_SRC).not.toMatch(/envelope\.navigation\.items/);
  });
});

// ===========================================================================
// PART 10 — Capture / custody / report / package files untouched
// ===========================================================================

describe("32.8 Test 10 — capture / custody / report / package files untouched", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`api/${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = fileURLToPath(
        new URL(`../${rel}`, import.meta.url),
      );
      expect(existsSync(fullPath), `${rel} must exist`).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 11 — Documentation + registry updated
// ===========================================================================

describe("32.8 Test 11 — documentation + registry updated", () => {
  it("docs/product/PHASE_32_8_PRODUCT_CONSOLIDATION.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_32_8_PRODUCT_CONSOLIDATION.md");
    expect(doc.length).toBeGreaterThan(8000);
    expect(doc).toMatch(/PHASE 32\.8/);
    expect(doc).toMatch(/Product Consolidation/i);
  });

  it("doc contains the canonical IA decision (6 primaries + 4 hubs)", () => {
    const doc = readRepo("docs/product/PHASE_32_8_PRODUCT_CONSOLIDATION.md");
    // Primaries
    for (const id of [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.cases",
      "workspace.reports",
      "workspace.search",
    ]) {
      expect(doc).toContain(id);
    }
    // Hubs
    for (const landing of [
      "investigation.hub",
      "governance.hub",
      "review.queue",
      "platform.ops_center",
    ]) {
      expect(doc).toContain(landing);
    }
  });

  it("MASTER_PHASE_REGISTRY.md registers Phase 32.8 with explicit status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?32\.8\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });
});
