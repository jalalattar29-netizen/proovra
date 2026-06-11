/**
 * Phase IA-intake-personal-space-fix — pin the stale page-level
 * workspace guard regression.
 *
 * After Phase IA-intake-access-fix granted INTAKE_LINKS_MANAGE to a
 * PRO Personal OWNER and the sidebar moved Intake Links out of
 * "More / Advanced", the /intake-links page still rendered:
 *
 *   "Switch to a workspace to manage intake links."
 *
 * because the page's local guard required `workspace.scope === "TEAM"`.
 * Personal Space users (PERSONAL scope) were forced into the dead
 * end. Personal workspaces are stored as Team rows with the user as
 * OWNER, so the backend's prisma.teamMember lookup already worked —
 * this was a frontend-only bug.
 *
 * These tests pin the fix at the source-contract level so the bug
 * cannot regress.
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
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const PAGE = readWeb("app/(app)/intake-links/page.tsx");

// ============================================================================
// 1. The TEAM-only guard is gone
// ============================================================================

describe("Phase IA-intake-personal-space-fix — guard semantics", () => {
  it("page does NOT require workspace.scope === \"TEAM\" before rendering", () => {
    // The original bug: `ws.scope === "TEAM"` forced the page into a
    // disabled state for any non-team workspace. The fix reads
    // `activeSpace` first and treats PERSONAL spaces as valid.
    expect(PAGE).not.toMatch(/ws\.scope === "TEAM"/);
  });

  it("page reads the canonical activeSpace first", () => {
    expect(PAGE).toMatch(/ctxEnvelope\.activeSpace/);
    expect(PAGE).toMatch(/active\?\.id/);
  });

  it("Personal Space falls through to the rendered UI with the personal teamId", () => {
    // The handler must set currentTeam from `active.id` when the
    // active space is present. The personal teamId is the same row
    // the backend's TeamMember lookup expects.
    expect(PAGE).toMatch(
      /active\?\.id[\s\S]{0,400}setCurrentTeam\(\{\s*id:\s*active\.id/,
    );
  });

  it("PERSONAL active space is labelled \"Personal Space\" (no team jargon)", () => {
    expect(PAGE).toMatch(/active\.type === "PERSONAL"[\s\S]{0,200}"Personal Space"/);
  });

  it("the legacy `workspace.scope === \"TEAM\"` branch was widened to accept any active workspace", () => {
    // The fallback that reads the deprecated `workspace` field now
    // accepts ANY non-empty workspace id (PERSONAL or TEAM), not just
    // the TEAM scope. The conditional must NOT carry the `=== "TEAM"`
    // gate anymore.
    const fallback =
      PAGE.match(/const ws = ctxEnvelope\.workspace;[\s\S]{0,500}\}/)?.[0] ?? "";
    expect(fallback).not.toMatch(/scope === "TEAM"/);
    expect(fallback).toMatch(/ws\.status === "active" && ws\.id/);
  });
});

// ============================================================================
// 2. Copy update
// ============================================================================

describe("Phase IA-intake-personal-space-fix — copy", () => {
  it("the dead-end \"Switch to a workspace\" string is gone", () => {
    // Strip JS comments so explanatory docs that mention the legacy
    // string (to document its removal) don't trip the assertion. Only
    // user-facing text matters.
    const stripped = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/Switch to a workspace/);
  });

  it("the empty-list state shows action-oriented copy, not a workspace nag", () => {
    // The brief mandates the exact welcoming copy for an empty
    // intake-links list.
    expect(PAGE).toMatch(
      /Create a secure intake link to request evidence from a\s+client, source, witness, or contributor/,
    );
  });

  it("the empty-list state carries a stable e2e selector", () => {
    expect(PAGE).toMatch(/data-intake-links-empty/);
  });

  it("the workspace-loading state is a neutral loading hint, not a switch instruction", () => {
    // The transient null-currentTeam state shows up between mount and
    // envelope hydration. The copy must NOT instruct the user to
    // switch workspace.
    expect(PAGE).toMatch(/data-intake-links-loading/);
    expect(PAGE).toMatch(/Loading workspace/);
  });
});

// ============================================================================
// 3. Backend still works for PERSONAL workspaces (no contract change)
// ============================================================================

describe("Phase IA-intake-personal-space-fix — backend works for PERSONAL", () => {
  const ROUTE = readApi("src/routes/workflow-intake-links.routes.ts");

  it("requireAdmin / requireMember check TeamMember by teamId + userId (works for personal workspaces)", () => {
    // The auth helpers do a plain TeamMember lookup keyed by
    // teamId+userId. Personal workspaces are Team rows with an OWNER
    // TeamMember row, so the lookup succeeds for PERSONAL workspaces
    // without ANY backend change.
    expect(ROUTE).toMatch(
      /prisma\.teamMember\.findUnique\(\s*\{\s*where:\s*\{\s*teamId_userId:\s*\{\s*teamId,\s*userId\s*\}\s*\}/,
    );
    // No path filters out PERSONAL scope.
    expect(ROUTE).not.toMatch(/scope:\s*"PERSONAL"/);
    expect(ROUTE).not.toMatch(/scope:\s*"TEAM"/);
  });

  it("POST /v1/workflow/intake-links accepts a teamId for any workspace the caller is ADMIN of", () => {
    expect(ROUTE).toMatch(
      /app\.post\(\s*"\/v1\/workflow\/intake-links"[\s\S]{0,1500}requireAdmin\(req, reply, body\.teamId\)/,
    );
  });

  it("Send / revoke endpoints reuse the same requireAdmin path", () => {
    // Two distinct routes (send + revoke) call requireAdmin with the
    // link's teamId.
    expect(ROUTE).toMatch(
      /\/v1\/workflow\/intake-links\/:id\/revoke[\s\S]{0,1500}requireAdmin\(req, reply, existing\.teamId\)/,
    );
    expect(ROUTE).toMatch(
      /\/v1\/workflow\/intake-links\/:id\/send[\s\S]{0,1500}requireAdmin\(req, reply, existing\.teamId\)/,
    );
  });
});

// ============================================================================
// 4. Cross-cut invariants — previous phases still hold
// ============================================================================

describe("Phase IA-intake-personal-space-fix — invariants", () => {
  it("Intake Links stays in CANONICAL_PRIMARY_ROUTE_IDS (sidebar primary, not advanced)", () => {
    const GROUPS = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    expect(GROUPS).toMatch(/"workspace\.intake_links"/);
  });

  it("workspace.intake_links route still has advancedByDefault: false", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    const block =
      REGISTRY.match(/id:\s*"workspace\.intake_links"[\s\S]{0,2000}\}/)?.[0] ??
      "";
    expect(block).toMatch(/advancedByDefault:\s*false/);
  });

  it("INTAKE_LINKS_MANAGE still granted in BOTH personal + team capability branches", () => {
    const REG = readApi(
      "src/services/platform-context/capability-registry.ts",
    );
    const personal =
      REG.match(/if \(isPersonal\)[\s\S]*?if \(isTeam\)/)?.[0] ?? "";
    expect(personal).toContain("INTAKE_LINKS_MANAGE");
    const team =
      REG.match(/if \(isTeam\)[\s\S]*?Platform admin elevation/)?.[0] ?? "";
    expect(team.match(/INTAKE_LINKS_MANAGE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("VIEWER role still excluded — isWriter narrows to non-viewer paths only", () => {
    const REG = readApi(
      "src/services/platform-context/capability-registry.ts",
    );
    expect(REG).toMatch(/isWriter = isMember && !isViewer/);
  });

  it("denial panel still hides \"Browse all tools\" from non-platform-admin", () => {
    const GATE = readWeb("components/navigation/PageRouteGate.tsx");
    const stripped = GATE
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const browseCount = (stripped.match(/Browse all tools/g) ?? []).length;
    const gated = (
      stripped.match(/isPlatformAdmin === true \? \([\s\S]*?Browse all tools/g) ??
      []
    ).length;
    expect(gated).toBe(browseCount);
  });

  it("All Tools sidebar group still gated to platform admins (regression check)", () => {
    const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(SIDEBAR).toMatch(
      /isPlatformAdmin \? \([\s\S]{0,800}data-sidebar-group="All Tools"/,
    );
  });
});
