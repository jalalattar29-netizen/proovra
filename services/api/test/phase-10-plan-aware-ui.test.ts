/**
 * PROOVRA Phase 10 — Plan-aware UI source-contract test.
 *
 * Pins the existence and shape of the canonical `PlanLimitBadge`
 * component, and verifies that the Collaboration Team pages that
 * surface plan-bounded counters import it.
 *
 * Constitutional rules (Phase 10):
 *   - Billing controls capacity, not the definition of Team.
 *   - The Upgrade affordance MUST point at the canonical billing
 *     surface `/billing`, NOT a fake "Team Workspace" upgrade path.
 *   - The badge is a pure presentational chip; it does not perform
 *     network I/O.
 *
 * Production reality (Phase 10 wiring as of test authorship):
 *   - `apps/web/components/billing/PlanLimitBadge.tsx`  → exists.
 *   - `app/(app)/collaboration-teams/page.tsx`          → imports.
 *   - `app/(app)/collaboration-teams/[teamId]/page.tsx` → imports.
 *   - `app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx`
 *     → does NOT import the badge today (the collaboration hub is a
 *       comment / notification surface; plan counters live one level
 *       up on the team detail page). The test asserts the present
 *       canonical state — Phase 10 closure may extend the badge into
 *       this sub-page, at which point the assertion will widen.
 *
 * Test style: source-contract (file-text assertions). No DOM render.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");

const BADGE_PATH = resolve(
  WEB_ROOT,
  "components/billing/PlanLimitBadge.tsx",
);
const TEAMS_INDEX_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/collaboration-teams/page.tsx",
);
const TEAM_DETAIL_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/collaboration-teams/[teamId]/page.tsx",
);
const COLLAB_HUB_PAGE = resolve(
  WEB_ROOT,
  "app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
);

// ---------------------------------------------------------------------------
// Component shape
// ---------------------------------------------------------------------------

describe("Phase 10 — PlanLimitBadge component shape", () => {
  it("the canonical PlanLimitBadge component file exists", () => {
    expect(existsSync(BADGE_PATH)).toBe(true);
  });

  it("the component declares the canonical Phase 10 prop shape (kind, current, max, planLabel)", () => {
    const src = readFileSync(BADGE_PATH, "utf8");
    // Prop names are part of the public contract — pin them.
    expect(src).toMatch(/\bkind\b/);
    expect(src).toMatch(/\bcurrent\b/);
    expect(src).toMatch(/\bmax\b/);
    expect(src).toMatch(/\bplanLabel\b/);
    // The component exports a named `PlanLimitBadge` symbol the
    // pages import.
    expect(src).toMatch(
      /export\s+(?:function\s+PlanLimitBadge|const\s+PlanLimitBadge|default\s+function\s+PlanLimitBadge|\{[^}]*PlanLimitBadge[^}]*\})/,
    );
  });

  it("the Upgrade affordance points at the canonical /billing surface", () => {
    const src = readFileSync(BADGE_PATH, "utf8");
    // Bounded: an Upgrade link rendered when over the cap. The literal
    // /billing href is the constitutional Phase 10 destination.
    expect(src).toMatch(/href=["']\/billing["']/);
    expect(src).toMatch(/Upgrade/);
  });
});

// ---------------------------------------------------------------------------
// Page-level wiring
// ---------------------------------------------------------------------------

describe("Phase 10 — Collaboration Team pages surface PlanLimitBadge", () => {
  it("/collaboration-teams (index page) imports PlanLimitBadge", () => {
    const src = readFileSync(TEAMS_INDEX_PAGE, "utf8");
    expect(src).toMatch(
      /import\s+(?:\{[^}]*PlanLimitBadge[^}]*\}|PlanLimitBadge)\s+from\s+["'][^"']*PlanLimitBadge["']/,
    );
  });

  it("/collaboration-teams/[teamId] (detail page) imports PlanLimitBadge", () => {
    const src = readFileSync(TEAM_DETAIL_PAGE, "utf8");
    expect(src).toMatch(
      /import\s+(?:\{[^}]*PlanLimitBadge[^}]*\}|PlanLimitBadge)\s+from\s+["'][^"']*PlanLimitBadge["']/,
    );
  });

  it("/collaboration-teams/[teamId]/collaboration sub-page exists (badge wiring is page-level for plan counters)", () => {
    // Production-state assertion: the collaboration hub page exists as
    // the comment / notification surface. Plan counters are surfaced
    // on the parent /collaboration-teams + /collaboration-teams/[teamId]
    // pages (where actual team-creation / member-add CTAs live). This
    // assertion documents the present canonical UX. If a future
    // Phase 10 closure adds PlanLimitBadge to this sub-page, it
    // strengthens — does not contradict — this contract.
    expect(existsSync(COLLAB_HUB_PAGE)).toBe(true);
  });
});
