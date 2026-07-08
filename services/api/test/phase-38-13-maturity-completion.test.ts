/**
 * PHASE 38.13 — Enterprise UX maturity completion source-contract tests.
 *
 * Covers (the subset honestly delivered):
 *   1. Dashboard band ordering — persona-aware, paired sections always
 *      stay together (no more order-sensitivity bug).
 *   2. Long-tail dynamic route migrations to PageRouteGate (6 more
 *      pages: evidence/[id], cases/[id], reports/[id] already exempted
 *      via no detail page, workflows/[id], investigation/{graph,
 *      duplicates, reviewers}).
 *   3. Route registry expansion (3 new entries for investigation
 *      subroutes).
 *   4. WorkspaceAdminPanel migrated off useTeamWorkspaceGate.
 *   5. Cumulative <PageRouteGate> adoption ≥ 40 pages.
 *   6. Copy-safety lock expansion (5 new forbidden phrases pinned).
 *   7. Required safety statement still present on every required
 *      surface.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
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
// Phase 38.13 test perf cache — walk the apps/web .tsx tree exactly ONCE
// per test-file load so every it() that scans the source tree reuses the
// same listing. The previous in-describe walker re-traversed the tree
// per assertion AND descended into `.next/` / `node_modules/` / `dist/` /
// build artefacts, which pushed the test over the 5-second vitest
// timeout on Windows CI. Excluding those bulk directories makes the
// walker ~20× faster while keeping every real source file in scope.
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

// Single shared listing — built lazily so other test files that don't
// touch the apps/web tree don't pay the I/O cost.
let WEB_TSX_FILES_CACHE: string[] | null = null;
function getWebTsxFiles(): string[] {
  if (WEB_TSX_FILES_CACHE === null) {
    WEB_TSX_FILES_CACHE = listAllTsxFiles(webPath("."));
  }
  return WEB_TSX_FILES_CACHE;
}

const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const WORKSPACE_ADMIN = readWeb(
  "components/workspace-admin/WorkspaceAdminPanel.tsx",
);

// =============================================================================
// PART 1 — Persona-aware band ordering
// =============================================================================

describe("Phase 38.13 — dashboard band ordering keeps pairs grouped", () => {
  it("buildSectionRenderPlan uses a partition-then-sort algorithm", () => {
    // The new plan algorithm partitions sections by gridGroup first,
    // then sorts bands by min(orderedIds.indexOf(...)) of their
    // members. The presence of `bandsByKey` + the priority-min update
    // pin this.
    expect(COMMAND_CENTER).toMatch(/bandsByKey/);
    expect(COMMAND_CENTER).toMatch(/positionIdx\s*<\s*band\.priority/);
  });

  it("bands sort by min position of their members (workflow priority wins)", () => {
    // Trailing comma after the arrow expression is allowed.
    expect(COMMAND_CENTER).toMatch(
      /\.sort\(\s*\(a,\s*b\)\s*=>\s*a\.priority\s*-\s*b\.priority/,
    );
  });

  it("paired sections never get separated by other workflow-elevated sections", () => {
    // The legacy 38.12 algorithm walked the ordered list and started a
    // new band as soon as the gridGroup changed — so workflow ordering
    // that interleaved non-paired sections could split pairs. The 38.13
    // algorithm partitions by group FIRST so members of the same group
    // always end up in the same band regardless of interleaving.
    // Sanity-check: the band initialization keys by `g:${group}` for
    // grouped sections, ensuring all same-group sections collapse into
    // one band entry.
    expect(COMMAND_CENTER).toMatch(/`g:\$\{group\}`/);
  });

  it("solo (no gridGroup) sections render with unique band keys", () => {
    expect(COMMAND_CENTER).toMatch(/`solo:\$\{soloIdx\.n\+\+\}`/);
  });

  it("band size remains capped at 3 (overflow spills to solo)", () => {
    expect(COMMAND_CENTER).toMatch(/band\.entries\.length\s*<\s*3/);
    expect(COMMAND_CENTER).toMatch(/`spill:\$\{sectionId\}`/);
  });
});

// =============================================================================
// PART 2 — Route registry expansion (investigation subroutes)
// =============================================================================

describe("Phase 38.13 — route registry expansion (3 new investigation routes)", () => {
  const NEW_ROUTES: Array<{ id: string; href: string }> = [
    { id: "investigation.graph", href: "/investigation/graph" },
    { id: "investigation.duplicates", href: "/investigation/duplicates" },
    { id: "investigation.reviewers", href: "/investigation/reviewers" },
  ];

  for (const r of NEW_ROUTES) {
    it(`declares ${r.id} as a canonical route mapped to ${r.href}`, () => {
      expect(REGISTRY).toMatch(
        new RegExp(`id:\\s*"${r.id.replace(/\./g, "\\.")}"`),
      );
      expect(REGISTRY).toMatch(
        new RegExp(`href:\\s*"${r.href.replace(/\//g, "\\/")}"`),
      );
    });
  }
});

// =============================================================================
// PART 3 — Long-tail dynamic-route PageRouteGate migrations
// =============================================================================

describe("Phase 38.13 — dynamic / long-tail PageRouteGate migrations", () => {
  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    {
      page: "app/(app)/evidence/[id]/page.tsx",
      routeId: "workspace.evidence",
    },
    { page: "app/(app)/cases/[id]/page.tsx", routeId: "workspace.cases" },
    {
      page: "app/(app)/workflows/[id]/page.tsx",
      routeId: "workspace.workflows",
    },
    {
      page: "app/(app)/investigation/graph/page.tsx",
      routeId: "investigation.graph",
    },
    {
      page: "app/(app)/investigation/duplicates/page.tsx",
      routeId: "investigation.duplicates",
    },
    {
      page: "app/(app)/investigation/reviewers/page.tsx",
      routeId: "investigation.reviewers",
    },
  ];

  for (const entry of MIGRATIONS) {
    it(`${entry.page} wraps in <PageRouteGate routeId="${entry.routeId}">`, () => {
      const src = readWeb(entry.page);
      expect(src).toMatch(/PageRouteGate/);
      expect(src).toMatch(
        new RegExp(`routeId="${entry.routeId.replace(/\./g, "\\.")}"`),
      );
      expect(src).toMatch(/from\s+["'].*navigation\/PageRouteGate["']/);
    });
  }
});

// =============================================================================
// PART 4 — WorkspaceAdminPanel migrated off useTeamWorkspaceGate
// =============================================================================

describe("Phase 38.13 — WorkspaceAdminPanel migrated off useTeamWorkspaceGate", () => {
  it("does not import useTeamWorkspaceGate anymore", () => {
    expect(WORKSPACE_ADMIN).not.toMatch(/useTeamWorkspaceGate/);
  });
  it("reads the canonical activeSpaceId instead", () => {
    expect(WORKSPACE_ADMIN).toMatch(/useActiveSpaceId/);
  });
  it("relies on PageRouteGate for structured recovery (not on a local workspace gate)", () => {
    // No `workspace.status !== "ready"` branching remains. The
    // component now only handles the API-level error state machine.
    expect(WORKSPACE_ADMIN).not.toMatch(/workspace\.status\s*!==\s*"ready"/);
  });
});

// =============================================================================
// PART 5 — Cumulative migration tally (≥ 40 pages)
// =============================================================================

describe("Phase 38.13 — cumulative <PageRouteGate> adoption", () => {
  it("at least 40 canonical pages now wrap in <PageRouteGate>", () => {
    const PAGES = [
      // Phase 38.7
      "app/(app)/reports/page.tsx",
      "app/(app)/cases/page.tsx",
      "app/(app)/search/page.tsx",
      // Phase 38.8
      "app/(app)/home/page.tsx",
      "app/(app)/governance/page.tsx",
      // Phase Final-Vocab-Alignment — canonical reviewer console is
      // `/review/page.tsx`; the legacy `/reviewer-ops/page.tsx` was
      // deleted and the URL redirects via `next.config.js`.
      "app/(app)/review/page.tsx",
      "app/(app)/operations/page.tsx",
      // Phase Final-Closure-Remediation — canonical surface is
      // `/workspaces`; the duplicate `/teams/page.tsx` was deleted.
      "app/(app)/workspaces/page.tsx",
      // Phase 38.9
      "app/(app)/evidence/page.tsx",
      "app/(app)/capture/page.tsx",
      "app/(app)/notifications/page.tsx",
      "app/(app)/integrations/page.tsx",
      "app/(app)/settings/page.tsx",
      "app/(app)/billing/page.tsx",
      "app/(app)/governance/retention/page.tsx",
      "app/(app)/settings/persona/page.tsx",
      // Phase 38.10
      "app/(app)/workflows/page.tsx",
      "app/(app)/intake-links/page.tsx",
      "app/(app)/security-center/page.tsx",
      "app/(app)/operations/runbooks/page.tsx",
      "app/(app)/reviewer-ops/escalations/page.tsx",
      // Phase 38.11
      "app/(app)/governance/policy/page.tsx",
      "app/(app)/governance/analytics/page.tsx",
      "app/(app)/governance/lifecycle/page.tsx",
      "app/(app)/governance/destruction/page.tsx",
      "app/(app)/governance/notifications/page.tsx",
      "app/(app)/operations/observability/page.tsx",
      "app/(app)/reviewer-ops/sla/page.tsx",
      "app/(app)/investigation/page.tsx",
      // Phase 38.12
      "app/(app)/reviewer-ops/[reviewId]/page.tsx",
      "app/(app)/communications/page.tsx",
      "app/(app)/intelligence/page.tsx",
      "app/(app)/investigation/timeline/page.tsx",
      "app/(app)/investigation/relationships/page.tsx",
      // Phase 38.13
      "app/(app)/evidence/[id]/page.tsx",
      "app/(app)/cases/[id]/page.tsx",
      "app/(app)/workflows/[id]/page.tsx",
      "app/(app)/investigation/graph/page.tsx",
      "app/(app)/investigation/duplicates/page.tsx",
      "app/(app)/investigation/reviewers/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
    expect(PAGES.length).toBeGreaterThanOrEqual(40);
  });
});

// =============================================================================
// PART 6 — Copy safety lock expansion
// =============================================================================

describe("Phase 38.13 — expanded copy safety lock (positive overclaim only)", () => {
  // Phase 38.13 — bans POSITIVE overclaim assertions. Disclaimers that
  // explicitly REJECT the claim (e.g. "we do NOT make court-ready
  // claims", "no legal-admissibility guarantee", "evidence is not
  // certified as tamper-proof") are NOT banned — they are the right
  // copy. The patterns below pin the affirmative form only: a claim
  // applied to the platform / a record / a package / a workflow, not
  // a negation of such a claim.
  //
  // If a future surface needs to discuss these concepts, it must do so
  // in operational + bounded language (e.g. "integrity record" instead
  // of "tamper-proof", "verification flow" instead of "court-ready").
  const FORBIDDEN_POSITIVE_OVERCLAIM = [
    // Positive-claim regex patterns: noun → "is" / "are" → forbidden
    // term. e.g. "this package is legally admissible".
    /\b(is|are|will be|guaranteed)\s+legally admissible\b/i,
    /\bauthenticity\s+(is\s+)?guaranteed\b/i,
    /\b(is|are)\s+tamper-proof\b/i,
    /\b(is|are)\s+court-ready\b/i,
    /\b(it\s+)?proves the truth\b/i,
    // Marketing-style overclaim phrases that don't need a verb anchor:
    /"tamper-proof evidence"/i,
    /"court-ready evidence"/i,
    /"court-ready package"/i,
  ];

  // Phase IA-OTS-info-fallback (test perf) — the inner walker that
  // used to live here is gone. Module-level `getWebTsxFiles()` returns
  // a memoized listing built once per test-file load with bulk-build
  // directories excluded. The assertion below now scans only real
  // source files and completes well under the bumped 30s timeout on
  // Windows CI.
  it(
    "no .tsx file under apps/web makes positive legal / forensic overclaim assertions",
    () => {
      const all = getWebTsxFiles();
      const offenders: string[] = [];
      for (const file of all) {
        const src = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN_POSITIVE_OVERCLAIM) {
          if (pattern.test(src)) {
            offenders.push(
              `${file.replace(/\\/g, "/").replace(/^.*apps\/web\//, "")} — ${pattern}`,
            );
          }
        }
      }
      expect(
        offenders,
        `Positive legal / forensic overclaim copy is banned. Disclaimers ("we do NOT claim …") remain allowed. Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
    30000,
  );
});

// =============================================================================
// PART 7 — Required safety statement still present on required surfaces
// =============================================================================

describe("Phase 38.13 — required workflow-safety statement still mounted", () => {
  it("required statement present on All Tools", () => {
    const src = readWeb("app/(app)/tools/page.tsx");
    expect(src).toMatch(
      /Workflow profiles personalize layout, defaults, and\s+recommendations\. They do not change permissions or remove tools\./,
    );
  });

  it("required statement variant present in persona wizard", () => {
    const src = readWeb("app/(app)/settings/persona/page.tsx");
    expect(src).toMatch(
      /workflow profile tunes ordering, defaults, and labels\. It does\s+NOT change/i,
    );
  });

  it("required statement present in command palette via WORKFLOW_SAFETY_STATEMENT", () => {
    const src = readWeb("components/navigation/CommandPalette.tsx");
    expect(src).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
  });

  it("required statement present in capture guidance via WORKFLOW_SAFETY_STATEMENT", () => {
    const src = readWeb(
      "app/(app)/capture/_lib/CaptureWorkflowGuidance.tsx",
    );
    expect(src).toMatch(/WORKFLOW_SAFETY_STATEMENT/);
  });
});

// =============================================================================
// PART 8 — CR1 Part 2 superseded: redirect-only page exemption check
// =============================================================================
//
// All five redirect-only pages this test originally guarded (security,
// archive, deleted, locked, operations) were deleted by CR1 Part 2
// and replaced by canonical `next.config.js` `redirects()` entries.
// The new pin lives in `phase-cr1-legacy-purge.test.ts > CR1 Part 2`
// (asserts file absence + next.config.js entry presence). This Phase
// 38.13 describe block is intentionally left as a documentation
// tombstone.
