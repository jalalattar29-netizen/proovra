/**
 * Phase IA-self-serve-regression-fix — pin the three concrete UI
 * regressions the operator brief called out.
 *
 *   BUG 1 — `All Tools` was rendered in the production sidebar for every
 *           plan even though `/tools` is INTERNAL (notFound). Pin the
 *           `isPlatformAdmin` gate around the sidebar block AND the
 *           command-palette fallback target.
 *
 *   BUG 2 — `Invite teammate` on the self-serve Home opened a blank
 *           page because /teams/page.tsx wrapped content in
 *           `<PageRouteGate routeId="admin.teams">`. That routeId maps
 *           to /workspaces in the registry (requiredCapabilities:
 *           ["TEAM_VIEW"]) — a solo PRO user without a team has no
 *           TEAM_VIEW capability and saw the resolver denial panel.
 *           Pin that PageRouteGate is no longer used at /teams AND
 *           that FREE/PAYG never see the Invite teammate CTA.
 *
 *   BUG 3 — Reports page used the workspace-scoped /v1/reports/artifacts
 *           which 404s when the caller is not an ACTIVE TeamMember of
 *           the supplied teamId. Self-serve PERSONAL workspace
 *           bootstrap sometimes misses that membership row. Pin
 *           (a) the new user-scoped GET /v1/reports endpoint exists
 *           with proper safety filters and (b) the Reports page falls
 *           back to it on empty / 404.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// BUG 1 — All Tools gated to platform admins
// ============================================================================

describe("Phase IA-self-serve-regression-fix — BUG 1: All Tools visibility", () => {
  const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
  const PALETTE = readWeb("components/navigation/CommandPalette.tsx");

  it("the All Tools sidebar group renders only for platform admins", () => {
    // `isPlatformAdmin ? (<div … data-sidebar-group="All Tools" …>…</div>) : null`
    expect(SIDEBAR).toMatch(
      /isPlatformAdmin \? \([\s\S]{0,500}data-sidebar-group="All Tools"/,
    );
    // The closing ternary right after the inline All Tools block
    // must be present — otherwise the group renders unconditionally.
    expect(SIDEBAR).toMatch(
      /data-sidebar-group="All Tools"[\s\S]{0,2000}\) : null\}/,
    );
  });

  it("`/tools` stays classified as INTERNAL with notFound direct-access policy", () => {
    const TIERS = readWeb("lib/surface/tiers.ts");
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/tools",\s*tier:\s*"INTERNAL",\s*directAccessPolicy:\s*"notFound"/,
    );
  });

  it("the command-palette fallback no longer pushes non-admins to /tools", () => {
    // Every `router.push(...)` fallback in the palette now uses /home.
    expect(PALETTE).not.toMatch(/router\.push\("\/tools"\)/);
    expect(PALETTE).toMatch(/router\.push\("\/home"\)/);
  });
});

// ============================================================================
// BUG 2 — Invite teammate + /teams render
// ============================================================================

describe("Phase IA-self-serve-regression-fix — BUG 2: Invite teammate + /teams", () => {
  const HOME = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
  const TEAMS = readWeb("app/(app)/teams/page.tsx");

  it("Invite teammate row is plan-gated on isProOrTeam (FREE/PAYG hidden)", () => {
    // Phase IA-self-serve-home-rebuild — the Invite teammate CTA is
    // now driven by the home view model's checklist `visible` flag
    // (`invite_first_teammate` step), gated on `isProOrTeam(plan)`.
    // The same shape pins the Intake-link step.
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(VM).toMatch(
      /isProOrTeam\(args\.plan\)[\s\S]{0,800}invite_first_teammate/,
    );
  });

  it("FREE/PAYG do NOT receive the Invite teammate step in the checklist", () => {
    // The view model's `buildChecklist` derives `visible: pro` for
    // intake/invite — pinning the function name + the `pro` flag
    // ensures the FREE/PAYG branch can't accidentally widen it.
    const VM = readWeb("components/home-experience/home-view-model.ts");
    expect(VM).toMatch(
      /function buildChecklist\([\s\S]{0,2000}invite_first_teammate[\s\S]{0,400}visible:\s*pro/,
    );
  });

  it("/teams/page.tsx no longer wraps content in JSX `<PageRouteGate routeId=\"admin.teams\">`", () => {
    // `admin.teams` maps to /workspaces and requires TEAM_VIEW.
    // A solo PRO user has no team → no TEAM_VIEW → denial panel.
    // The new landing relies on the surface-tier middleware
    // (PROFESSIONAL with redirect) instead, and renders an
    // explicit empty state for users with no teams.
    //
    // Strip JS comments before pattern matching so explanatory
    // comments that mention `<PageRouteGate>` (to document the
    // removal) don't trip the assertion. We only care about live
    // JSX usage + live imports.
    const stripped = TEAMS
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/<\s*PageRouteGate\b/);
    expect(stripped).not.toMatch(/import\s*\{[^}]*\bPageRouteGate\b[^}]*\}/);
  });

  it("/teams renders an explicit `No teams yet` empty state for users with no orgs", () => {
    expect(TEAMS).toMatch(/data-teams-landing-empty/);
    expect(TEAMS).toMatch(/No teams yet/);
    expect(TEAMS).toMatch(/Go to Billing/);
  });

  it("/teams renders the org list when `useOrganizations()` returns entries", () => {
    expect(TEAMS).toMatch(/organizations\.map\(/);
    expect(TEAMS).toMatch(/href=\{`\/teams\/\$\{org\.id\}`\}/);
  });
});

// ============================================================================
// BUG 3 — Reports list endpoint + page fallback
// ============================================================================

describe("Phase IA-self-serve-regression-fix — BUG 3: user-scoped reports", () => {
  it("the new reports.routes.ts file exists", () => {
    const path = fileURLToPath(
      new URL("../src/routes/reports.routes.ts", import.meta.url),
    );
    expect(existsSync(path)).toBe(true);
  });

  const ROUTE = readApi("src/routes/reports.routes.ts");

  it("declares GET /v1/reports gated by requireAuth", () => {
    expect(ROUTE).toMatch(/app\.get\(\s*"\/v1\/reports",\s*\{\s*preHandler:\s*requireAuth\s*\}/);
  });

  it("scopes the evidence query to caller-owned OR active-team-membership rows (strict safety)", () => {
    // The access clause MUST OR over `ownerUserId` AND `teamId in teamIds`.
    expect(ROUTE).toMatch(/ownerUserId:\s*userId/);
    expect(ROUTE).toMatch(/teamId:\s*\{\s*in:\s*teamIds\s*\}/);
    // teamIds is sourced from ACTIVE memberships only.
    expect(ROUTE).toMatch(
      /prisma\.teamMember\.findMany\(\s*\{\s*where:\s*\{\s*userId,\s*status:\s*"ACTIVE"/,
    );
  });

  it("applies the existing SIGNED/REPORTED status filter (no visibility widening)", () => {
    expect(ROUTE).toMatch(
      /status:\s*\{\s*in:\s*\[\s*"SIGNED",\s*"REPORTED"\s*\]\s*\}/,
    );
  });

  it("excludes soft-deleted evidence when the schema carries `deletedAt`", () => {
    expect(ROUTE).toMatch(/deletedAt:\s*null/);
  });

  it("never mints download URLs — page still routes downloads through the per-evidence endpoints", () => {
    // The new endpoint MUST NOT call any presign / download helper.
    expect(ROUTE).not.toMatch(/presignGetObject/);
    expect(ROUTE).not.toMatch(/headObject/);
    // It MUST NOT touch the workspace-scoped requireWorkspaceMember
    // (that function is the source of the 404 bug it's working around).
    expect(ROUTE).not.toMatch(/requireWorkspaceMember/);
  });

  it("is registered in server.ts so Fastify mounts the handler", () => {
    const SERVER = readApi("src/server.ts");
    expect(SERVER).toMatch(/import\s+registerReportsRoutes\s+from\s+["']\.\/routes\/reports\.routes\.js["']/);
    expect(SERVER).toMatch(/app\.register\(registerReportsRoutes\)/);
  });

  it("the Reports page falls back to /v1/reports when the workspace endpoint returns empty or 404", () => {
    const INDEX = readWeb("components/reports-experience/ReportsIndex.tsx");
    // The fallback helper is wired:
    expect(INDEX).toMatch(/tryUserScopedReports/);
    // Trigger 1: empty workspace result → recover via user-scoped.
    expect(INDEX).toMatch(
      /envelope\.sections\.artifacts\.status === "ok"[\s\S]{0,200}items\.length === 0[\s\S]{0,400}tryUserScopedReports\(\)/,
    );
    // Trigger 2: 404 from workspace endpoint → recover.
    expect(INDEX).toMatch(
      /e\.statusCode === 404[\s\S]{0,200}tryUserScopedReports\(\)/,
    );
    // The fallback adapter calls GET /v1/reports.
    expect(INDEX).toMatch(/apiFetch\(`?\/v1\/reports`?/);
  });
});
