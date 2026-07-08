/**
 * Final consolidation — Workspace/Tenancy vs Collaboration API separation lock.
 *
 * The final product model separates two model-disjoint surfaces:
 *
 *   - `/v1/teams` (teams.routes.ts) — WORKSPACE / TENANCY / BILLING API.
 *     Operates on the tenancy `Team` model + `TeamMember` / `TeamInvite`
 *     (workspace members/invites, tied to seats/billing/subscriptions),
 *     `Evidence.teamId` ownership, and `CaseAccess` governance. `/v1/workspaces`
 *     is an alias onto it.
 *
 *   - `/v1/collaboration-teams` (+ `/v1/collaboration-team-invites`) — the
 *     user-facing collaboration Teams product. Operates on the SEPARATE
 *     `CollaborationTeam*` models. Never mutates subscription/billing or
 *     evidence ownership.
 *
 * There is intentionally NO collaboration behaviour on `/v1/teams` to migrate
 * (its members are workspace/tenancy members) and NO tenancy/billing behaviour
 * on `/v1/collaboration-teams`. This test LOCKS that separation so neither
 * surface can drift into the other (which would either duplicate the product
 * Teams surface or couple collaboration to billing/tenancy/evidence).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  readFileSync(resolve(__dirname, "..", "src", rel), "utf8");

const TEAMS = src("routes/teams.routes.ts");
const COLLAB = src("routes/collaboration-teams.routes.ts");

describe("Final — /v1/teams is WORKSPACE/TENANCY only (no collaboration leak)", () => {
  it("teams.routes.ts NEVER uses the CollaborationTeam model (comment mentions are fine; code usage is not)", () => {
    // Meaningful coupling = a Prisma model access or an import of the
    // collaboration models/services. Prose mentions in the classification
    // header are allowed (this file documents the separation).
    const usesCollabModel = /prisma\.collaborationTeam/i.test(TEAMS);
    const importsCollab =
      /import[^;]*[Cc]ollaboration[- ]?[Tt]eam[^;]*from/.test(TEAMS);
    expect(
      usesCollabModel || importsCollab,
      "teams.routes.ts must not USE CollaborationTeam models/services — that is " +
        "the separate /v1/collaboration-teams product surface.",
    ).toBe(false);
  });

  it("teams.routes.ts carries the tenancy/billing anchors (proves it is the workspace API)", () => {
    expect(TEAMS).toMatch(/prisma\.team\b/);
    expect(TEAMS).toMatch(/teamInvite/);
    expect(TEAMS).toMatch(/subscription/);
    // Seat / plan enforcement lives here (workspace membership is seat-gated).
    expect(TEAMS).toMatch(/assertTeamSeatAvailable|getWorkspaceUsage/);
  });

  it("teams.routes.ts is documented as the workspace/tenancy/billing API", () => {
    expect(TEAMS).toMatch(/WORKSPACE \/ TENANCY \/ BILLING API/);
  });
});

describe("Final — /v1/collaboration-teams is COLLABORATION only (no billing/evidence coupling)", () => {
  it("collaboration-teams.routes.ts NEVER mutates subscriptions/billing", () => {
    expect(COLLAB).not.toMatch(/prisma\.subscription\.(create|update|delete|upsert)/);
    expect(COLLAB).not.toMatch(/\bbillingPlan\s*:/);
    expect(COLLAB).not.toMatch(/\b(stripe|paypal)\b/i);
  });

  it("collaboration-teams.routes.ts NEVER mutates evidence ownership", () => {
    expect(COLLAB).not.toMatch(/prisma\.evidence\.(update|delete|updateMany)/);
  });

  it("collaboration-teams.routes.ts carries the collaboration anchors", () => {
    expect(COLLAB).toMatch(/collaborationTeam|CollaborationTeam/);
    expect(COLLAB).toMatch(/acceptInvite/);
  });

  it("the collaboration invite-accept endpoint exists (parity — no need to fall back to /v1/teams)", () => {
    expect(COLLAB).toMatch(/collaboration-team-invites\/:token\/accept/);
  });
});
