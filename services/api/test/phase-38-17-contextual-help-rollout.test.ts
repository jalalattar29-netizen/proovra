/**
 * PHASE 38.17 — ContextualHelp rollout source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. ContextualHelp mounted on 5 additional surfaces:
 *      - Evidence (EvidenceLibraryPageInner)
 *      - Cases (CasesIndex)
 *      - Reports (ReportsIndex)
 *      - Governance (GovernanceControlPlane)
 *      - Reviewer Ops (ReviewerCommandConsole)
 *   2. Each mount uses surface= from the canonical HelpSurface enum.
 *   3. Each mount drives workflow= from usePersonaProfile +
 *      workflowFromPersona — never hard-coded.
 *   4. Each mount is collapsedByDefault to preserve operator focus
 *      on the primary surface.
 *   5. Copy-safety locks held on the touched components.
 *   6. Total ContextualHelp mounts ≥ 7 across the codebase
 *      (capture + dashboard from 38.16 + the 5 from 38.17).
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
// Phase 38.17 test perf cache — same shape as 38.13 / 38.18. The
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

// =============================================================================
// PART 1 — ContextualHelp mounts on 5 new surfaces
// =============================================================================

describe("Phase 38.17 — ContextualHelp mounted on 5 additional surfaces", () => {
  const MOUNTS: Array<{
    file: string;
    surfaceEnum: string;
    name: string;
  }> = [
    {
      file: "app/(app)/evidence/page.tsx",
      surfaceEnum: "evidence",
      name: "Evidence library",
    },
    {
      file: "components/cases-experience/CasesIndex.tsx",
      surfaceEnum: "cases",
      name: "Matter operations queue",
    },
    {
      file: "components/reports-experience/ReportsIndex.tsx",
      surfaceEnum: "reports",
      name: "Reports + artifacts",
    },
    {
      file: "components/governance-experience/GovernanceControlPlane.tsx",
      surfaceEnum: "governance",
      name: "Governance control plane",
    },
    {
      file: "components/reviewer-experience/ReviewerCommandConsole.tsx",
      surfaceEnum: "reviewer-ops",
      name: "Reviewer command console",
    },
  ];

  for (const entry of MOUNTS) {
    it(`${entry.name} (${entry.file}) imports and renders <ContextualHelp surface="${entry.surfaceEnum}">`, () => {
      const src = readWeb(entry.file);
      expect(src).toMatch(/ContextualHelp/);
      expect(src).toMatch(
        new RegExp(
          `surface="${entry.surfaceEnum.replace(/\W/g, "\\$&")}"`,
        ),
      );
    });

    it(`${entry.name} drives workflow= from workflowFromPersona(usePersonaProfile())`, () => {
      const src = readWeb(entry.file);
      // Each mount must derive the workflow code from the canonical
      // persona profile hook — not from a hard-coded constant.
      expect(src).toMatch(/usePersonaProfile/);
      expect(src).toMatch(/workflowFromPersona/);
      // The mount itself references workflow= from a derived variable
      // (naming convention: `<surface>WorkflowCode` OR plain
      // `workflowCode` where the component scope is already narrow).
      expect(src).toMatch(/workflow=\{(?:[A-Za-z]+W|w)orkflowCode\}/);
    });

    it(`${entry.name} mounts ContextualHelp as collapsedByDefault`, () => {
      const src = readWeb(entry.file);
      // The `collapsedByDefault` prop preserves operator focus on the
      // primary surface; pinned per mount to prevent accidental
      // expansion that would push primary controls below the fold.
      // We look for the prop within ~400 chars of the ContextualHelp
      // import / usage block.
      const block = src.match(
        /<ContextualHelp[\s\S]{0,400}collapsedByDefault/,
      );
      expect(
        block,
        `${entry.file} must mount ContextualHelp with collapsedByDefault`,
      ).not.toBeNull();
    });
  }
});

// =============================================================================
// PART 2 — Canonical HelpSurface enum coverage (sanity check)
// =============================================================================

describe("Phase 38.17 — surface= values are within the bounded HelpSurface enum", () => {
  it("the canonical HelpSurface enum lists every value used in mounts", () => {
    const helpSrc = readWeb("lib/platform-context/workflowHelp.ts");
    for (const surface of [
      "capture",
      "evidence",
      "cases",
      "reports",
      "governance",
      "reviewer-ops",
      "ops",
    ]) {
      expect(
        helpSrc,
        `HelpSurface enum must include "${surface}"`,
      ).toMatch(new RegExp(`"${surface.replace(/\W/g, "\\$&")}"`));
    }
  });
});

// =============================================================================
// PART 3 — Cumulative ContextualHelp mounts ≥ 7
// =============================================================================

describe("Phase 38.17 — total ContextualHelp mounts across codebase", () => {
  // Phase IA-OTS-info-fallback (test perf) — uses module-level
  // `getWebTsxFiles()` (cached, bulk-dirs excluded) and a 30s vitest
  // timeout. The assertion (≥ 7 mounts) is unchanged.
  it(
    "at least 7 .tsx files render <ContextualHelp (component definition + 7 mounts)",
    () => {
      const all = getWebTsxFiles();
      let mountCount = 0;
      for (const file of all) {
        // Skip the component definition itself + its docs.
        const normalized = file.replace(/\\/g, "/");
        if (normalized.endsWith("/ContextualHelp.tsx")) continue;
        const src = readFileSync(file, "utf8");
        if (/<ContextualHelp\b/.test(src)) {
          mountCount += 1;
        }
      }
      expect(
        mountCount,
        `expected ≥ 7 ContextualHelp mounts, found ${mountCount}`,
      ).toBeGreaterThanOrEqual(7);
    },
    30000,
  );
});

// =============================================================================
// PART 4 — Copy safety locks on touched components
// =============================================================================

describe("Phase 38.17 — copy safety locks held on touched surfaces", () => {
  const FILES = [
    "app/(app)/evidence/page.tsx",
    "components/cases-experience/CasesIndex.tsx",
    "components/reports-experience/ReportsIndex.tsx",
    "components/governance-experience/GovernanceControlPlane.tsx",
    "components/reviewer-experience/ReviewerCommandConsole.tsx",
  ];

  // Positive-claim patterns only — disclaimers ("we do NOT claim X")
  // remain allowed per the Phase 38.13 lock design.
  const BANNED_POSITIVE = [
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
      for (const pattern of BANNED_POSITIVE) {
        expect(src, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
