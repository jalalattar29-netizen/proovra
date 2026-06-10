/**
 * PHASE 38.18 — Final product completion source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. CaptureOperationalSummary — integrated readiness + top-
 *      suggestion band positioned at the finalize area; reads
 *      from existing pure helpers; non-blocking; a11y-correct.
 *   2. Real analyst-grade density CSS extended to canonical
 *      enterprise classes (cc-page, cc-section, cc-title, cc-meta,
 *      cc-tile-grid, cc-tile, ec-grid-2col, ec-grid-3col, cases-row).
 *   3. HelpSurface enum extended to include `teams` + `search` +
 *      DEFAULTS entries; ContextualHelp mounted on both surfaces.
 *   4. Cumulative ContextualHelp mount count ≥ 9.
 *   5. Copy safety locks held on newly-touched surfaces.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Phase 38.18 test perf cache — same shape as 38.13 / 38.17. The
// previous in-describe walker descended into `.next/`, `node_modules/`,
// `dist/` and timed out on Windows CI. Exclude bulk build dirs and
// build the listing once per test-file load.
// ---------------------------------------------------------------------------
const TSX_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "out",
  ".git",
]);

function listAllTsxFilesShared(dirAbs: string): string[] {
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
      if (TSX_EXCLUDED_DIRS.has(name)) continue;
      const full = `${dir}/${name}`;
      try {
        const stat = statSync(full);
        if (stat.isFile() && /\.tsx$/.test(name)) out.push(full);
        else if (stat.isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

let WEB_TSX_FILES_CACHE: string[] | null = null;
function getWebTsxFiles(): string[] {
  if (WEB_TSX_FILES_CACHE === null) {
    WEB_TSX_FILES_CACHE = listAllTsxFilesShared(webPath("."));
  }
  return WEB_TSX_FILES_CACHE;
}

const OPSUMMARY = readWeb(
  "app/(app)/capture/_lib/CaptureOperationalSummary.tsx",
);
const CAPTURE = readWeb("app/(app)/capture/page.tsx");
const SHELL_CSS = readWeb("components/app-shell-v2/app-shell-v2.css");
const WORKFLOW_HELP = readWeb("lib/platform-context/workflowHelp.ts");
const TEAMS_HOME = readWeb(
  "components/workspace-admin/WorkspaceAdministrationHome.tsx",
);
const SEARCH = readWeb("app/(app)/search/page.tsx");

// =============================================================================
// PART 1 — CaptureOperationalSummary integrated band
// =============================================================================

describe("Phase 38.18 — CaptureOperationalSummary integrated band", () => {
  it("derives state from the existing readiness + suggestions helpers (no new data sources)", () => {
    expect(OPSUMMARY).toMatch(/computeCaptureReadiness/);
    expect(OPSUMMARY).toMatch(/computeCaptureSuggestions/);
    // Caps suggestions to 1 — the band shows the SINGLE top action.
    expect(OPSUMMARY).toMatch(/maxSuggestions:\s*1/);
  });

  it("renders nothing when no items are staged", () => {
    expect(OPSUMMARY).toMatch(
      /if\s*\(items\.length\s*===\s*0\)\s*return\s+null/,
    );
  });

  it("uses role=\"status\" so screen readers announce readiness changes", () => {
    expect(OPSUMMARY).toMatch(/role="status"/);
    expect(OPSUMMARY).toMatch(/aria-label=/);
  });

  it("emits structured data attributes for level/workflow/score/top-suggestion", () => {
    expect(OPSUMMARY).toMatch(/data-capture-operational-summary-level=/);
    expect(OPSUMMARY).toMatch(/data-capture-operational-summary-workflow=/);
    expect(OPSUMMARY).toMatch(/data-capture-operational-summary-score=/);
    expect(OPSUMMARY).toMatch(
      /data-capture-operational-summary-top-suggestion=/,
    );
  });

  it("consumes density CSS variables (not hard-coded)", () => {
    expect(OPSUMMARY).toMatch(/var\(--proovra-density-/);
  });

  it("operational-tone — no legal/forensic overclaim labels", () => {
    const FORBIDDEN = [
      /\bcourt-ready\b/i,
      /\btamper-proof\b/i,
      /\blegally admissible\b/i,
      /\bproves the truth\b/i,
      /\bauthenticity guaranteed\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      expect(OPSUMMARY).not.toMatch(pattern);
    }
  });

  it("capture page mounts the summary band between session panel and finalize bar", () => {
    expect(CAPTURE).toMatch(/CaptureOperationalSummary/);
    // The mount must appear AFTER CaptureSessionPanel and BEFORE
    // CaptureBottomBar in the source order so the operator sees it
    // immediately before the finalize controls.
    const sessionIdx = CAPTURE.indexOf("<CaptureSessionPanel");
    const summaryIdx = CAPTURE.indexOf("<CaptureOperationalSummary");
    const bottomBarIdx = CAPTURE.indexOf("<CaptureBottomBar");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(sessionIdx);
    expect(bottomBarIdx).toBeGreaterThan(summaryIdx);
  });

  it("operational summary is informational only — does NOT block finalization", () => {
    // Capture must not consume the summary's data attributes / state
    // to disable the bottom bar.
    expect(CAPTURE).not.toMatch(
      /CaptureBottomBar[\s\S]{0,400}finishDisabled=\{[\s\S]{0,80}operationalSummary/,
    );
  });
});

// =============================================================================
// PART 2 — Real analyst-grade density on canonical enterprise classes
// =============================================================================

describe("Phase 38.18 — analyst-grade density on canonical enterprise classes", () => {
  const COMPACT_TARGETS = [
    ".cc-page",
    ".cc-page-header",
    ".cc-section",
    ".cc-title",
    ".cc-kicker",
    ".cc-subtitle",
    ".cc-meta",
    ".cc-tile-grid",
    ".cc-tile",
    ".ec-grid-2col",
    ".ec-grid-3col",
    ".cases-row",
  ];

  for (const cls of COMPACT_TARGETS) {
    it(`compact-mode rule exists for ${cls}`, () => {
      const escaped = cls.replace(/[.\-]/g, (m) => `\\${m}`);
      expect(
        SHELL_CSS,
        `compact-mode rule must target ${cls}`,
      ).toMatch(
        new RegExp(
          `data-operational-density="compact"\\][^{]*${escaped}`,
        ),
      );
    });
  }

  it("spacious-mode rules also extend the canonical classes (not just owned panels)", () => {
    expect(SHELL_CSS).toMatch(
      /data-operational-density="spacious"\][^{]*\.cc-page/,
    );
    expect(SHELL_CSS).toMatch(
      /data-operational-density="spacious"\][^{]*\.cc-section/,
    );
  });
});

// =============================================================================
// PART 3 — HelpSurface enum extension + teams/search mounts
// =============================================================================

describe("Phase 38.18 — HelpSurface enum extension", () => {
  it("HelpSurface includes 'teams' and 'search'", () => {
    expect(WORKFLOW_HELP).toMatch(/"teams"/);
    expect(WORKFLOW_HELP).toMatch(/"search"/);
  });

  it("DEFAULTS catalog has entries for 'teams' and 'search'", () => {
    expect(WORKFLOW_HELP).toMatch(/teams:\s*\{\s*title:/);
    expect(WORKFLOW_HELP).toMatch(/search:\s*\{\s*title:/);
  });

  it("teams + search default copy is operational tone (no POSITIVE legal overclaim)", () => {
    // Positive-claim form only — workflowHelp.ts has pre-existing
    // disclaimer copy that REJECTS these claims (e.g. the reports
    // default body says "they do not assert legal admissibility,
    // authenticity, or 'court-ready' status"). Disclaimers stay
    // allowed; affirmative assertions stay banned.
    const FORBIDDEN_POSITIVE = [
      /\b(is|are|will be|guaranteed)\s+legally admissible\b/i,
      /\bauthenticity\s+(is\s+)?guaranteed\b/i,
      /\b(is|are)\s+tamper-proof\b/i,
      /\b(is|are)\s+court-ready\b/i,
      /\b(it\s+)?proves the truth\b/i,
    ];
    for (const pattern of FORBIDDEN_POSITIVE) {
      expect(WORKFLOW_HELP).not.toMatch(pattern);
    }
  });
});

describe("Phase 38.18 — ContextualHelp mounted on /teams + /search", () => {
  it("WorkspaceAdministrationHome (/teams) mounts ContextualHelp surface=\"teams\"", () => {
    expect(TEAMS_HOME).toMatch(/ContextualHelp/);
    expect(TEAMS_HOME).toMatch(/surface="teams"/);
    expect(TEAMS_HOME).toMatch(/usePersonaProfile/);
    expect(TEAMS_HOME).toMatch(/workflowFromPersona/);
  });

  it("SearchInner (/search) mounts ContextualHelp surface=\"search\"", () => {
    expect(SEARCH).toMatch(/ContextualHelp/);
    expect(SEARCH).toMatch(/surface="search"/);
    expect(SEARCH).toMatch(/usePersonaProfile/);
    expect(SEARCH).toMatch(/workflowFromPersona/);
  });

  it("both new mounts are collapsedByDefault", () => {
    expect(TEAMS_HOME).toMatch(
      /<ContextualHelp[\s\S]{0,300}collapsedByDefault/,
    );
    expect(SEARCH).toMatch(
      /<ContextualHelp[\s\S]{0,300}collapsedByDefault/,
    );
  });
});

// =============================================================================
// PART 4 — Cumulative ContextualHelp mounts ≥ 9
// =============================================================================

describe("Phase 38.18 — total ContextualHelp mounts across codebase", () => {
  // Phase IA-OTS-info-fallback (test perf) — uses module-level
  // `getWebTsxFiles()` (cached, bulk-dirs excluded) and a 30s vitest
  // timeout. The assertion (≥ 9 mounts) is unchanged.
  it(
    "at least 9 .tsx files mount <ContextualHelp (full HelpSurface enum coverage)",
    () => {
      const all = getWebTsxFiles();
      let mountCount = 0;
      for (const file of all) {
        const normalized = file.replace(/\\/g, "/");
        if (normalized.endsWith("/ContextualHelp.tsx")) continue;
        const src = readFileSync(file, "utf8");
        if (/<ContextualHelp\b/.test(src)) {
          mountCount += 1;
        }
      }
      expect(
        mountCount,
        `expected ≥ 9 ContextualHelp mounts, found ${mountCount}`,
      ).toBeGreaterThanOrEqual(9);
    },
    30000,
  );
});

// =============================================================================
// PART 5 — Copy safety locks held on every newly-touched surface
// =============================================================================

describe("Phase 38.18 — copy safety locks", () => {
  const FILES = [
    "app/(app)/capture/_lib/CaptureOperationalSummary.tsx",
    "lib/platform-context/workflowHelp.ts",
    "components/workspace-admin/WorkspaceAdministrationHome.tsx",
    "app/(app)/search/page.tsx",
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
