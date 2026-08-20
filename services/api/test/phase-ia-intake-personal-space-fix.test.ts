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

import { intakeLinksFile } from "./_helpers/intake-links-surface";

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
    // The workspace is resolved synchronously from the envelope now — the
    // effect + local `currentTeam` state it used to be copied into was pure
    // duplication of a value the provider already holds.
    expect(PAGE).toMatch(/envelope\?\.activeSpace/);
    expect(PAGE).toMatch(/activeSpace\?\.id/);
  });

  it("Personal Space falls through to the rendered UI with the personal teamId", () => {
    // The personal teamId is the same row the backend's TeamMember lookup
    // expects, and every read is scoped to it.
    expect(PAGE).toMatch(/const teamId = activeSpace\?\.id \?\? null/);
    expect(PAGE).toMatch(/teamId=\$\{encodeURIComponent\(workspaceId\)\}/);
  });

  it("PERSONAL active space is labelled \"Personal Space\" (no team jargon)", () => {
    expect(PAGE).toMatch(
      /activeSpace\?\.type === "PERSONAL"[\s\S]{0,200}"Personal Space"/,
    );
  });

  it("the deprecated `workspace.scope` field is not consulted at all", () => {
    // Phase 12 Point 4 (Pass E) — this used to assert that the fallback
    // branch reading the deprecated `workspace` envelope had been WIDENED
    // from `scope === "TEAM"` to accept any active workspace, which is what
    // originally stranded Personal Space users on "Switch to a workspace".
    //
    // That branch existed only to cover "older deployments that haven't
    // projected `activeSpace` yet"; the API projects `activeSpace` on every
    // envelope build, so the branch was unreachable and has been deleted.
    // The bug it was widened to fix can no longer recur, because the only
    // path left is the canonical one asserted above — and the file's own
    // guidance ("the legacy `workspace.scope` field is deprecated and
    // should not be consulted here") is now literally true.
    // Comments are stripped: the file documents the historical bug, and
    // that history is worth keeping. What must be gone is the code.
    const executable = PAGE.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(executable).not.toMatch(/const ws = ctxEnvelope\.workspace;/);
    expect(executable).not.toMatch(/scope === "TEAM"/);
    // The single remaining resolution path falls through to null rather
    // than guessing a workspace, and a null id renders the loading state
    // instead of reading some other workspace's links.
    expect(PAGE).toMatch(/activeSpace\?\.id \?\? null/);
    expect(PAGE).toMatch(/teamId \? load : \{ kind: "loading" \}/);
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
    // Intake-link redesign — the empty-state copy was rewritten into
    // a richer EmptyState component with a title + body + actions +
    // concrete examples. The original requirement (a welcoming,
    // action-oriented message) is satisfied by the new title +
    // first-paragraph copy below. The workspace-nag negative pin
    // above still holds.
    // The non-content states moved into `_components/States.tsx`, which is
    // the whole point of that module — one anatomy for loading / empty /
    // no-match / error / restricted, instead of five inline branches.
    const STATES = intakeLinksFile("_components/States.tsx");
    expect(STATES).toMatch(/No intake links yet/);
    expect(STATES).toMatch(
      /Create a secure upload link to request evidence from someone outside/,
    );
  });

  it("the empty-list state carries a stable e2e selector", () => {
    expect(intakeLinksFile("_components/States.tsx")).toMatch(
      /data-intake-links-empty/,
    );
  });

  it("the workspace-loading state is a neutral loading hint, not a switch instruction", () => {
    // The transient no-workspace state shows up between mount and envelope
    // hydration. The copy must NOT instruct the user to switch workspace.
    const STATES = intakeLinksFile("_components/States.tsx");
    expect(STATES).toMatch(/data-intake-links-loading/);
    expect(STATES).toMatch(/Loading intake links/);
    expect(STATES).not.toMatch(/Switch to a workspace/);
  });
});

// ============================================================================
// 3. Backend still works for PERSONAL workspaces (no contract change)
// ============================================================================

describe("Phase IA-intake-personal-space-fix — backend works for PERSONAL", () => {
  const ROUTE = readApi("src/routes/workflow-intake-links.routes.ts");

  it("authorization composes the canonical primitive keyed by the target teamId (works for personal workspaces)", () => {
    // PHASE 1 (2026-07-21): the auth helpers route through authorizeOrFail,
    // which resolves the actor's ACTIVE membership by teamId + userId (via
    // loadMemberAccessSnapshot). Personal workspaces are PERSONAL-kind Team
    // rows with an ACTIVE OWNER TeamMember and are exempt from CUSTOMER-org
    // lifecycle, so the canonical gate succeeds for PERSONAL workspaces
    // without ANY backend change.
    expect(ROUTE).toMatch(/authorizeOrFail\(/);
    // requireAdmin's informational OWNER/ADMIN role read is keyed by
    // teamId + the authorized actor userId.
    expect(ROUTE).toMatch(
      /teamId_userId:\s*\{\s*teamId,\s*userId:\s*outcome\.actorUserId\s*\}/,
    );
    // No path filters out PERSONAL scope.
    expect(ROUTE).not.toMatch(/scope:\s*"PERSONAL"/);
    expect(ROUTE).not.toMatch(/scope:\s*"TEAM"/);
  });

  it("POST /v1/workflow/intake-links gates the admin create path on workflow.intake_link.create", () => {
    expect(ROUTE).toMatch(
      /app\.post\(\s*"\/v1\/workflow\/intake-links"[\s\S]{0,1500}requireAdmin\(req, reply, body\.teamId, "workflow\.intake_link\.create"\)/,
    );
  });

  it("Send / revoke endpoints reuse the same requireAdmin path with the right capability", () => {
    expect(ROUTE).toMatch(
      /\/v1\/workflow\/intake-links\/:id\/revoke[\s\S]{0,1500}requireAdmin\(req, reply, existing\.teamId, "workflow\.intake_link\.revoke"\)/,
    );
    expect(ROUTE).toMatch(
      /\/v1\/workflow\/intake-links\/:id\/send[\s\S]{0,1500}requireAdmin\(req, reply, existing\.teamId, "workflow\.intake_link\.create"\)/,
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
    // (2026-07-21) Migrated onto ProovraDenialState: "Browse all tools" is
    // an admin-only action pushed via `isPlatformAdmin === true ? [ … ] : []`.
    const gated = (
      stripped.match(/isPlatformAdmin === true[\s\S]{0,40}\?\s*\[[\s\S]*?Browse all tools/g) ??
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
