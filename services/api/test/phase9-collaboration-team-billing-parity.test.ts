/**
 * Phase 9 — Collaboration-team billing parity regression guard.
 *
 * Purpose: this is an AUDIT artifact. It encodes the Phase 9 finding
 * that the two team-creation endpoints disagree on plan-limit
 * enforcement and pins the gap as a failing test until Phase 10
 * closes it.
 *
 * Finding (Phase 9 Billing audit):
 *   - `POST /v1/teams` (legacy workspace-admin route) enforces the
 *     PROOVRA per-user plan ceiling via `assertUserCanCreateAnotherTeam`
 *     in `services/api/src/routes/teams.routes.ts`, which reads
 *     `getPlanCapabilities(personalScope.plan).maxOwnedTeams` and
 *     refuses creation when the actor would exceed it
 *     (`TEAM_CREATION_NOT_ALLOWED` / `TEAM_WORKSPACE_LIMIT_REACHED`).
 *   - `POST /v1/collaboration-teams` (Phase 5 collaboration route)
 *     in `services/api/src/services/collaboration-team/collaboration-team.service.ts`
 *     enforces only a workspace-scoped `maxTeams` ceiling from
 *     `getCollaborationTeamPlanLimits` — it never consults the
 *     per-user `maxOwnedTeams` capability that the legacy `/v1/teams`
 *     route uses.
 *
 * Why this matters:
 *   A FREE-plan user blocked by `assertUserCanCreateAnotherTeam` on
 *   `/v1/teams` can today create additional teams via
 *   `/v1/collaboration-teams` — the per-user plan ceiling is
 *   bypassable. The two routes must enforce IDENTICAL plan rules or
 *   we are not selling one product, we are selling two.
 *
 * Phase 9 scope rules forbid us from FIXING this (only nav hides,
 * legacy redirects, label clarifications, route registry metadata,
 * regression tests, and docs are allowed). The fix is Phase 10 work.
 *
 * Test style: source-contract (file-text assertions). No DB I/O.
 *
 * Status: `describe.skip` — these assertions FAIL today. They are
 * left skipped so CI stays green while the debt is tracked in code.
 *
 * TODO(Phase 10): remove `.skip` once
 * `services/api/src/services/collaboration-team/collaboration-team.service.ts`
 * (or the route wrapper at
 * `services/api/src/routes/collaboration-teams.routes.ts`) enforces
 * the same `maxOwnedTeams` per-user ceiling as `/v1/teams`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TEAMS_ROUTES_PATH = fileURLToPath(
  new URL("../src/routes/teams.routes.ts", import.meta.url),
);

const COLLAB_TEAMS_ROUTES_PATH = fileURLToPath(
  new URL("../src/routes/collaboration-teams.routes.ts", import.meta.url),
);

const COLLAB_TEAMS_SERVICE_PATH = fileURLToPath(
  new URL(
    "../src/services/collaboration-team/collaboration-team.service.ts",
    import.meta.url,
  ),
);

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Phase 9 Billing-parity contract.
 *
 * SKIPPED INTENTIONALLY — these assertions describe the Phase 10
 * blocking debt. Removing `.skip` will turn the gap into a CI failure
 * the moment Phase 10 starts. Do NOT remove `.skip` here without
 * landing the matching enforcement in the collaboration-team
 * creation path.
 */
describe.skip("Phase 9 — /v1/teams vs /v1/collaboration-teams plan-limit parity (Phase 10 debt)", () => {
  it("legacy /v1/teams route enforces maxOwnedTeams (baseline)", () => {
    // Baseline sanity: the legacy route DOES enforce maxOwnedTeams.
    // This assertion is the "control" — if it ever fails, the
    // baseline behavior regressed and Phase 10 has a bigger problem.
    const src = readSource(TEAMS_ROUTES_PATH);
    expect(
      src.includes("maxOwnedTeams"),
      "teams.routes.ts must reference maxOwnedTeams (legacy enforcement baseline). If this assertion fails, the legacy per-user plan ceiling has been removed and Phase 10 parity work has lost its reference implementation.",
    ).toBe(true);
    expect(
      src.includes("assertUserCanCreateAnotherTeam") ||
        src.includes("TEAM_WORKSPACE_LIMIT_REACHED") ||
        src.includes("TEAM_CREATION_NOT_ALLOWED"),
      "teams.routes.ts must invoke the per-user plan-ceiling guard (assertUserCanCreateAnotherTeam) or emit one of its canonical error codes.",
    ).toBe(true);
  });

  it("collaboration-teams creation enforces the SAME maxOwnedTeams ceiling", () => {
    // The fix: either the service or the route wrapper must consult
    // `maxOwnedTeams` for the actor (NOT just the workspace-scoped
    // `maxTeams`). Phase 10 may choose to share the helper from
    // teams.routes.ts; either path is acceptable as long as the
    // capability is referenced.
    const serviceSrc = readSource(COLLAB_TEAMS_SERVICE_PATH);
    const routeSrc = readSource(COLLAB_TEAMS_ROUTES_PATH);
    const combined = `${serviceSrc}\n${routeSrc}`;
    expect(
      combined.includes("maxOwnedTeams"),
      "Phase 10 debt: neither collaboration-teams.routes.ts nor collaboration-team.service.ts references maxOwnedTeams. The Phase 9 Billing audit found that POST /v1/collaboration-teams bypasses the per-user plan ceiling that POST /v1/teams enforces via assertUserCanCreateAnotherTeam.",
    ).toBe(true);
  });

  it("collaboration-teams creation emits a TEAM_WORKSPACE_LIMIT_REACHED-equivalent denial code", () => {
    // The denial code does not have to be byte-identical, but the
    // collaboration path MUST surface a stable denial code when the
    // per-user ceiling is hit so the UI can distinguish "workspace
    // full" (maxTeams) from "your plan is full" (maxOwnedTeams).
    const serviceSrc = readSource(COLLAB_TEAMS_SERVICE_PATH);
    const routeSrc = readSource(COLLAB_TEAMS_ROUTES_PATH);
    const combined = `${serviceSrc}\n${routeSrc}`;
    const hasOwnedCeilingDenial =
      combined.includes("TEAM_WORKSPACE_LIMIT_REACHED") ||
      combined.includes("TEAM_CREATION_NOT_ALLOWED") ||
      combined.includes("MAX_OWNED_TEAMS_REACHED");
    expect(
      hasOwnedCeilingDenial,
      "Phase 10 debt: collaboration-team creation does not emit a stable per-user-ceiling denial code. Choose one of TEAM_WORKSPACE_LIMIT_REACHED, TEAM_CREATION_NOT_ALLOWED, or MAX_OWNED_TEAMS_REACHED and emit it from the collaboration-team creation path when the actor's maxOwnedTeams is exhausted.",
    ).toBe(true);
  });

  it("collaboration-teams creation reads the actor's personal-workspace plan (not just the active workspace plan)", () => {
    // The per-user ceiling is anchored to the personal workspace
    // scope (PROOVRA: `getPersonalWorkspaceScope(ownerUserId)`), not
    // the active workspace, because a personal user creating a team
    // inside an ORGANIZATION still counts against THEIR personal
    // plan. Phase 10 must wire `getPersonalWorkspaceScope` (or an
    // equivalent helper) into the collaboration creation path.
    const serviceSrc = readSource(COLLAB_TEAMS_SERVICE_PATH);
    const routeSrc = readSource(COLLAB_TEAMS_ROUTES_PATH);
    const combined = `${serviceSrc}\n${routeSrc}`;
    expect(
      combined.includes("getPersonalWorkspaceScope") ||
        combined.includes("personalScope"),
      "Phase 10 debt: collaboration-team creation does not consult the actor's personal-workspace plan. The legacy /v1/teams route calls getPersonalWorkspaceScope(ownerUserId) before reading maxOwnedTeams — mirror that here.",
    ).toBe(true);
  });
});

/**
 * Active (non-skipped) sanity test — pins the audit FINDING itself
 * so the test file is not literally a no-op while the debt sits.
 *
 * If a future PR accidentally closes the gap WITHOUT removing the
 * `.skip` above, this assertion will start failing and force the
 * removal. That is intentional: it keeps the audit honest.
 */
describe("Phase 9 — collaboration-team billing-parity audit finding (active)", () => {
  it("documents the gap: collaboration-team service does not reference maxOwnedTeams today", () => {
    const serviceSrc = readSource(COLLAB_TEAMS_SERVICE_PATH);
    const routeSrc = readSource(COLLAB_TEAMS_ROUTES_PATH);
    const combined = `${serviceSrc}\n${routeSrc}`;
    expect(
      combined.includes("maxOwnedTeams"),
      "Phase 9 audit invariant broken: collaboration-team creation now references maxOwnedTeams. The Phase 10 debt may be closed — remove `.skip` from the parity describe block above and let those assertions run for real.",
    ).toBe(false);
  });
});
