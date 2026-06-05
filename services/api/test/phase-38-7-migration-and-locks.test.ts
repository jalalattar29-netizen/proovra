/**
 * PHASE 38.7 — Migration + architectural lock source-contract tests.
 *
 * Covers:
 *   1. Reports / Cases / Search pages migrated to <PageRouteGate>
 *   2. NEW callsites of useTeamWorkspaceGate are blocked (allow-list
 *      enumerates the legitimately-remaining consumers)
 *   3. No page contains workflow-based route gating
 *   4. No user-facing copy contains profession-locking language
 *      ("lawyer mode", "journalist mode", etc.)
 *   5. PageRouteGate import + routeId attribute pinned per migrated page
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listAllFiles } from "./_helpers/file-walker";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

// =============================================================================
// PART 1 — Page migrations
// =============================================================================

describe("Phase 38.7 — pages wrapped in PageRouteGate", () => {
  const PAGES_WITH_GATE: Array<{ page: string; routeId: string }> = [
    { page: "app/(app)/reports/page.tsx", routeId: "workspace.reports" },
    { page: "app/(app)/cases/page.tsx", routeId: "workspace.cases" },
    { page: "app/(app)/search/page.tsx", routeId: "workspace.search" },
  ];

  for (const entry of PAGES_WITH_GATE) {
    it(`${entry.page} imports PageRouteGate + wraps the page in routeId="${entry.routeId}"`, () => {
      const src = readWeb(entry.page);
      expect(src).toMatch(/PageRouteGate/);
      expect(src).toMatch(
        new RegExp(`routeId="${entry.routeId.replace(".", "\\.")}"`),
      );
    });
  }

  it("PageRouteGate imports point at the canonical navigation module", () => {
    for (const entry of [
      "app/(app)/reports/page.tsx",
      "app/(app)/cases/page.tsx",
      "app/(app)/search/page.tsx",
    ]) {
      const src = readWeb(entry);
      expect(src).toMatch(
        /from\s+["'].*navigation\/PageRouteGate["']/,
      );
    }
  });
});

// =============================================================================
// PART 2 — Legacy hook grep block (allow-list current consumers)
// =============================================================================

describe("Phase 38.7 — useTeamWorkspaceGate allow-list", () => {
  // Files that are currently allowed to use the legacy hook. NEW
  // consumers must NOT land outside this list — they should migrate to
  // <PageRouteGate>. Use absolute glob-style suffix matching.
  const ALLOWED_SUFFIXES = [
    // Canonical declaration + index re-export.
    "lib/platform-context/useTeamWorkspaceGate.ts",
    "lib/platform-context/useTenantModel.ts",
    "lib/platform-context/index.ts",
    // Existing team-only operator surfaces. Each is a candidate for
    // migration to PageRouteGate in a follow-up session.
    "components/command-center/CommandCenter.tsx",
    // Phase 38.13 — WorkspaceAdminPanel migrated to useActiveSpaceId; removed.
    // Phase 38.15 — GovernanceControlPlane migrated to useActiveSpaceId; removed.
    // Phase 38.14 — ReviewerCommandConsole migrated to useActiveSpaceId; removed.
    // Phase 38.11 — governance/policy migrated to PageRouteGate; removed.
    // Phase 38.12 — reviewer-ops/[reviewId] migrated to PageRouteGate; removed.
    // Phase 38.10 — escalations migrated to PageRouteGate; removed.
    // Phase 38.11 — reviewer-ops/sla migrated to PageRouteGate; removed.
    // Phase 38.11 — ops/observability migrated to PageRouteGate; removed.
    "app/(app)/ops/page.tsx",
  ];

  it("no new consumer references useTeamWorkspaceGate outside the allow-list", () => {
    const root = webPath(".");
    const all = listAllFiles(root);
    const offenders: string[] = [];
    for (const file of all) {
      const normalized = file.replace(/\\/g, "/");
      // Skip allowed files.
      if (ALLOWED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        continue;
      }
      const src = readFileSync(file, "utf8");
      if (/useTeamWorkspaceGate\b/.test(src)) {
        offenders.push(normalized.replace(/^.*apps\/web\//, ""));
      }
    }
    expect(
      offenders,
      `New code must NOT use useTeamWorkspaceGate. Migrate to <PageRouteGate>. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 3 — No workflow-based route gating
// =============================================================================

describe("Phase 38.7 — no workflow-based route gating", () => {
  it("no page returns null based on workflow / persona checks", () => {
    const root = webPath("app");
    const all = listAllFiles(root);
    const offenders: string[] = [];
    // Patterns that indicate workflow / persona is being used as a
    // route gate. (Reordering / labelling is fine; returning null is
    // a route gate.)
    const forbidden = [
      /if\s*\(\s*workflow\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
      /if\s*\(\s*persona\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
      /if\s*\(\s*primaryProfile\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
    ];
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(src)) {
          offenders.push(file.replace(/\\/g, "/").replace(/^.*apps\/web\//, ""));
          break;
        }
      }
    }
    expect(
      offenders,
      `Pages must NOT use workflow/persona as a route gate. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 4 — No profession-locking copy in user-facing files
// =============================================================================

describe("Phase 38.7 — no profession-locking copy", () => {
  // Banned user-facing strings. Matched case-insensitive. Internal
  // enum keys like `LAWYER` / `INSURANCE` are NOT banned — they're
  // implementation detail that never reaches the UI.
  const BANNED_USER_FACING = [
    /"lawyer mode"/i,
    /"journalist mode"/i,
    /"insurance mode"/i,
    /"investigator mode"/i,
    /"only for lawyers"/i,
    /"only for journalists"/i,
    /"only for insurance"/i,
    /"not available for your workflow"/i,
  ];

  it("no .tsx file in apps/web contains profession-locking user-facing strings", () => {
    const root = webPath(".");
    const all = listAllFiles(root, { extensions: [".tsx"] });
    const offenders: string[] = [];
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      for (const pattern of BANNED_USER_FACING) {
        if (pattern.test(src)) {
          offenders.push(
            `${file.replace(/\\/g, "/").replace(/^.*apps\/web\//, "")} — ${pattern}`,
          );
        }
      }
    }
    expect(
      offenders,
      `Profession-locking copy is banned. Use workflow-oriented framing instead. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 5 — Canonical safety copy on workflow surfaces
// =============================================================================

describe("Phase 38.7 — workflow safety copy on relevant surfaces", () => {
  it("/tools page renders the canonical 'do not change permissions or remove tools' safety copy", () => {
    const src = readWeb("app/(app)/tools/page.tsx");
    expect(src).toMatch(
      /Workflow profiles personalize layout, defaults, and\s+recommendations\. They do not change permissions or remove tools\./,
    );
  });

  it("persona settings wizard footnote retains the canonical safety statement", () => {
    const src = readWeb("app/(app)/settings/persona/page.tsx");
    expect(src).toMatch(
      /workflow profile tunes ordering, defaults, and labels\. It does\s+NOT change/i,
    );
  });
});
