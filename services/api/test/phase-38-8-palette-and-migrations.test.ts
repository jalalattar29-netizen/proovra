/**
 * PHASE 38.8 — Command palette + additional page migration tests.
 *
 * Covers:
 *   1. Command palette structural contract (dialog semantics, search
 *      input labelling, registry-driven results, capability-gated
 *      reasons, keyboard shortcut wiring).
 *   2. Command palette is workflow-aware (ranking only) but never
 *      bypasses access — denied routes route the user to the access
 *      resolver's primary action, not to the route itself.
 *   3. App shell mounts the command palette globally.
 *   4. Additional page migrations (Home, Governance, ReviewerOps,
 *      Ops, Teams) wrap canonical content in <PageRouteGate>.
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

const PALETTE = readWeb("components/navigation/CommandPalette.tsx");
const SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");

// =============================================================================
// PART 1 — Command palette contract
// =============================================================================

describe("Phase 38.8 — command palette", () => {
  it("indexes ROUTE_REGISTRY + uses resolveRouteAccess", () => {
    expect(PALETTE).toMatch(/ROUTE_REGISTRY/);
    expect(PALETTE).toMatch(/resolveRouteAccess/);
  });

  it("opens on Cmd+K / Ctrl+K", () => {
    expect(PALETTE).toMatch(/metaKey \|\| e\.ctrlKey/);
    expect(PALETTE).toMatch(/e\.key\.toLowerCase\(\)\s*===\s*"k"/);
  });

  it("closes on Escape", () => {
    expect(PALETTE).toMatch(/e\.key === "Escape"/);
  });

  it("dialog has proper semantics + accessible name", () => {
    expect(PALETTE).toMatch(/role="dialog"/);
    expect(PALETTE).toMatch(/aria-modal="true"/);
    expect(PALETTE).toMatch(/aria-label="Command palette"/);
  });

  it("search input is labelled (a11y)", () => {
    expect(PALETTE).toMatch(/aria-label="Search tools and routes"/);
    expect(PALETTE).toMatch(/data-command-palette-input/);
  });

  it("results list uses listbox semantics + aria-selected", () => {
    expect(PALETTE).toMatch(/role="listbox"/);
    expect(PALETTE).toMatch(/role="option"/);
    expect(PALETTE).toMatch(/aria-selected=\{isHighlighted\}/);
  });

  it("excludes hidden routes from results (canSeeNav: false)", () => {
    expect(PALETTE).toMatch(/if \(!access\.canSeeNav\) continue/);
  });

  it("excludes routes that opt out of command-palette via the registry", () => {
    expect(PALETTE).toMatch(/if \(!route\.commandPaletteVisible\) continue/);
  });

  it("denied routes route to access.primaryAction OR /tools (never the denied page)", () => {
    // The Enter / click handlers must check access.canLoad first; if
    // false, they route to access.primaryAction.href OR /tools.
    expect(PALETTE).toMatch(
      /if \(target\.access\.canLoad\) \{[\s\S]*?\} else if \(target\.access\.primaryAction\)/,
    );
    expect(PALETTE).toMatch(/router\.push\("\/tools"\)/);
  });

  it("renders bounded status badges with bounded labels", () => {
    expect(PALETTE).toMatch(/Available/);
    expect(PALETTE).toMatch(/Requires organization/);
    expect(PALETTE).toMatch(/Requires permission/);
    expect(PALETTE).toMatch(/Requires upgrade/);
  });

  it("workflow only RANKS results — primary-workflow match adds rank, never bypasses access", () => {
    // The rank computation references workflow tags but the access
    // outcome (canLoad/canSeeNav) is fully decided before the rank
    // adjustment. Sanity-check the source structure.
    expect(PALETTE).toMatch(/rank \+= 20/);
    expect(PALETTE).toMatch(/workflowTags\.includes\(primaryWorkflow\)/);
    // Workflow is not part of the access decision.
    expect(PALETTE).not.toMatch(
      /resolveRouteAccess\([\s\S]{0,200}workflow/,
    );
  });

  it("renders denial reason for capability-denied results", () => {
    expect(PALETTE).toMatch(/data-command-palette-reason/);
    expect(PALETTE).toMatch(/item\.access\.reason/);
  });

  it("focuses the input on open + restores focus to trigger on close", () => {
    expect(PALETTE).toMatch(/inputRef\.current\?\.focus\(\)/);
    expect(PALETTE).toMatch(/triggerRef/);
  });
});

// =============================================================================
// PART 2 — App shell mounts the palette
// =============================================================================

describe("Phase 38.8 — app shell mounts the command palette", () => {
  it("imports the CommandPalette component", () => {
    expect(SHELL).toMatch(
      /import \{ CommandPalette \} from\s+["'].*navigation\/CommandPalette["']/,
    );
  });

  it("renders <CommandPalette /> at the shell level", () => {
    expect(SHELL).toMatch(/<CommandPalette\s*\/>/);
  });
});

// =============================================================================
// PART 3 — Additional page migrations
// =============================================================================

describe("Phase 38.8 — additional PageRouteGate migrations", () => {
  const MIGRATIONS: Array<{ page: string; routeId: string }> = [
    { page: "app/(app)/home/page.tsx", routeId: "workspace.home" },
    { page: "app/(app)/governance/page.tsx", routeId: "governance.hub" },
    // Phase Final-Vocab-Alignment — legacy `/reviewer-ops/page.tsx` was
    // deleted; the canonical reviewer console at `/review/page.tsx` is
    // now where the `review.queue` route id's PageRouteGate wrap lives.
    {
      page: "app/(app)/review/page.tsx",
      routeId: "review.queue",
    },
    { page: "app/(app)/ops/page.tsx", routeId: "platform.ops_center" },
    // Phase Final-Closure-Remediation — the canonical surface for the
    // `admin.teams` route id moved to `/workspaces` (the duplicate
    // `/teams/page.tsx` was deleted; the legacy URL redirects via
    // `next.config.js`). The PageRouteGate wrap now lives on the
    // canonical page.
    { page: "app/(app)/workspaces/page.tsx", routeId: "admin.teams" },
  ];

  for (const entry of MIGRATIONS) {
    it(`${entry.page} wraps canonical content in <PageRouteGate routeId="${entry.routeId}">`, () => {
      const src = readWeb(entry.page);
      expect(src).toMatch(/PageRouteGate/);
      expect(src).toMatch(
        new RegExp(`routeId="${entry.routeId.replace(/\./g, "\\.")}"`),
      );
      expect(src).toMatch(
        /from\s+["'].*navigation\/PageRouteGate["']/,
      );
    });
  }
});

// =============================================================================
// PART 4 — Cumulative migration tally
// =============================================================================

describe("Phase 38.8 — cumulative <PageRouteGate> adoption", () => {
  it("at least 8 canonical pages now wrap in <PageRouteGate>", () => {
    const PAGES = [
      "app/(app)/reports/page.tsx",
      "app/(app)/cases/page.tsx",
      "app/(app)/search/page.tsx",
      "app/(app)/home/page.tsx",
      "app/(app)/governance/page.tsx",
      // Phase Final-Vocab-Alignment — canonical reviewer console is
      // `/review/page.tsx`; the legacy `/reviewer-ops/page.tsx` was
      // deleted and the URL redirects via `next.config.js`.
      "app/(app)/review/page.tsx",
      "app/(app)/ops/page.tsx",
      // Phase Final-Closure-Remediation — canonical surface is
      // `/workspaces`; the duplicate `/teams/page.tsx` was deleted.
      "app/(app)/workspaces/page.tsx",
    ];
    for (const page of PAGES) {
      const src = readWeb(page);
      expect(src, `${page} must wrap in <PageRouteGate>`).toMatch(
        /PageRouteGate/,
      );
    }
  });
});
