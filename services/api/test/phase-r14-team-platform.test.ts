/**
 * Phase R14 — Team Collaboration Platform source-contract test.
 *
 * Pins the Phase 5 deliverables produced under
 * docs/architecture/phase-5-team-platform-final.md. Like R11/R12/R13,
 * this is a source-contract test: it greps the codebase + asserts
 * shared-package surface area without booting the database.
 *
 * Stages covered:
 *
 *   - Stage 2 — Prisma models + migration exist (5 collaboration_*
 *     tables, additive, Phase-O hardened).
 *   - Stage 3 — Service module exports the canonical public API.
 *   - Stage 4 — Routes module mounts under /v1/collaboration-teams.
 *   - Stage 5 — Permissions vocabulary in @proovra/shared exports
 *     bounded roles + permissions + plan limits.
 *   - Stage 7 — Email + SMS + link delivery wrappers exist.
 *   - Stage 8 — Activity vocabulary covers every documented event type.
 *   - Stage 11 — Plan-limits table is non-empty for every tier.
 *   - Constitutional rules — Team is NOT a workspace; personal users
 *     can create teams without an organization.
 *
 * Adding/changing any contract requires:
 *   1. Editing docs/architecture/phase-5-team-platform-final.md
 *   2. Editing this test
 *   3. Architecture board approval.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES,
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_DELIVERY_STATUSES,
  COLLABORATION_TEAM_INVITE_CHANNELS,
  COLLABORATION_TEAM_INVITE_STATUSES,
  COLLABORATION_TEAM_INVITE_TOKEN_PREFIX,
  COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES,
  COLLABORATION_TEAM_MEMBER_STATUSES,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_STATUSES,
  COLLABORATION_TEAM_TYPES,
  collaborationTeamRoleHasPermission,
  isWellFormedCollaborationTeamInviteToken,
  renderCollaborationTeamInvitationSmsBody,
} from "@proovra/shared";
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the collaboration-limits
// adapter was deleted; these assertions now read the canonical capability
// record, where each limit has its own name.
import { getPlanCapabilities } from "@proovra/shared-billing";

// =============================================================================
// Path helpers
// =============================================================================

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(rel: string): string {
  const full = join(repoRoot, rel);
  if (!existsSync(full)) throw new Error(`R14: missing required file: ${rel}`);
  return readFileSync(full, "utf8");
}

function exists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

// =============================================================================
// Stage 5 — shared vocabulary
// =============================================================================

describe("Phase R14 — Stage 5: shared vocabulary", () => {
  it("exports the bounded role list (LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL)", () => {
    expect(COLLABORATION_TEAM_ROLES).toEqual([
      "LEAD",
      "ADMIN",
      "MEMBER",
      "VIEWER",
      "EXTERNAL",
    ]);
  });

  it("exports the bounded team status list (ACTIVE/ARCHIVED)", () => {
    expect(COLLABORATION_TEAM_STATUSES).toEqual(["ACTIVE", "ARCHIVED"]);
  });

  it("exports the bounded member status list (ACTIVE/SUSPENDED/REMOVED)", () => {
    expect(COLLABORATION_TEAM_MEMBER_STATUSES).toEqual([
      "ACTIVE",
      "SUSPENDED",
      "REMOVED",
    ]);
  });

  it("exports the bounded team type list (5 templates)", () => {
    expect(COLLABORATION_TEAM_TYPES).toEqual([
      "GENERAL",
      "INVESTIGATION",
      "LEGAL",
      "REVIEW",
      "COMPLIANCE",
    ]);
  });

  it("exports the 3 invite channels (EMAIL/SMS/LINK)", () => {
    expect(COLLABORATION_TEAM_INVITE_CHANNELS).toEqual([
      "EMAIL",
      "SMS",
      "LINK",
    ]);
  });

  it("exports the 4 invite statuses", () => {
    expect(COLLABORATION_TEAM_INVITE_STATUSES).toEqual([
      "PENDING",
      "ACCEPTED",
      "REVOKED",
      "EXPIRED",
    ]);
  });

  it("exports the 5 delivery statuses", () => {
    expect(COLLABORATION_TEAM_DELIVERY_STATUSES).toEqual([
      "PENDING",
      "SENT",
      "DELIVERED",
      "FAILED",
      "BOUNCED",
    ]);
  });

  it("exports the 5 assignment statuses + 4 priorities + 3 targets", () => {
    expect(COLLABORATION_TEAM_ASSIGNMENT_STATUSES.length).toBe(5);
    expect(COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES).toEqual([
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ]);
    expect(COLLABORATION_TEAM_ASSIGNMENT_TARGETS).toEqual([
      "CASE",
      "EVIDENCE",
      "REVIEW",
    ]);
  });

  it("exports the canonical activity event types covering every documented mutation", () => {
    const required = [
      "TEAM_CREATED",
      "TEAM_RENAMED",
      "TEAM_ARCHIVED",
      "MEMBER_INVITED",
      "INVITE_REVOKED",
      "INVITE_ACCEPTED",
      "MEMBER_ADDED",
      "MEMBER_SUSPENDED",
      "MEMBER_REMOVED",
      "MEMBER_ROLE_CHANGED",
      "LEAD_TRANSFERRED",
      "ASSIGNMENT_CREATED",
      "ASSIGNMENT_REASSIGNED",
      "ASSIGNMENT_COMPLETED",
      "ASSIGNMENT_CANCELLED",
    ];
    for (const evt of required) {
      expect(COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES).toContain(evt);
    }
  });
});

// =============================================================================
// Stage 5 — role permissions
// =============================================================================

describe("Phase R14 — Stage 5: role permissions", () => {
  it("LEAD has all management permissions", () => {
    expect(collaborationTeamRoleHasPermission("LEAD", "team.update_settings")).toBe(true);
    expect(collaborationTeamRoleHasPermission("LEAD", "team.member.invite")).toBe(true);
    expect(collaborationTeamRoleHasPermission("LEAD", "team.transfer_lead")).toBe(true);
    expect(collaborationTeamRoleHasPermission("LEAD", "team.archive")).toBe(true);
  });

  it("ADMIN can invite but cannot transfer leadership", () => {
    expect(collaborationTeamRoleHasPermission("ADMIN", "team.member.invite")).toBe(true);
    expect(collaborationTeamRoleHasPermission("ADMIN", "team.transfer_lead")).toBe(false);
    expect(collaborationTeamRoleHasPermission("ADMIN", "team.archive")).toBe(false);
  });

  it("MEMBER can read + complete assignments but cannot manage", () => {
    expect(collaborationTeamRoleHasPermission("MEMBER", "team.read")).toBe(true);
    expect(collaborationTeamRoleHasPermission("MEMBER", "team.assignment.complete")).toBe(true);
    expect(collaborationTeamRoleHasPermission("MEMBER", "team.member.invite")).toBe(false);
    expect(collaborationTeamRoleHasPermission("MEMBER", "team.update_settings")).toBe(false);
  });

  it("VIEWER is read-only", () => {
    expect(collaborationTeamRoleHasPermission("VIEWER", "team.read")).toBe(true);
    expect(collaborationTeamRoleHasPermission("VIEWER", "team.activity.read")).toBe(true);
    expect(collaborationTeamRoleHasPermission("VIEWER", "team.assignment.complete")).toBe(false);
  });

  it("EXTERNAL is strictly bounded (read only; no team write or activity read)", () => {
    expect(collaborationTeamRoleHasPermission("EXTERNAL", "team.read")).toBe(true);
    expect(collaborationTeamRoleHasPermission("EXTERNAL", "team.activity.read")).toBe(false);
    expect(collaborationTeamRoleHasPermission("EXTERNAL", "team.member.invite")).toBe(false);
  });

  it("null/undefined role grants nothing", () => {
    expect(collaborationTeamRoleHasPermission(null, "team.read")).toBe(false);
    expect(collaborationTeamRoleHasPermission(undefined, "team.read")).toBe(false);
  });
});

// =============================================================================
// Stage 11 — plan limits
// =============================================================================

describe("Phase R14 — Stage 11: plan limits", () => {
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the four limits are now four
  // independently-named capabilities. The tests that used to pin
  // `COLLABORATION_TEAM_PLAN_LIMITS.maxTeams` were asserting that the
  // Collaboration Team cap EQUALS the Owned Workspace cap, which is the exact
  // conflation that let one published "Up to 2" grant a PRO account two owned
  // workspaces AND two collaboration teams. They are pinned separately here.
  //
  // WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION (2026-09-06) —
  // three numbers moved, by approved product decision, and the table follows
  // the decision rather than the other way round:
  //
  //   * FREE and PAYG seats 0 → 1. Zero seats meant a workspace whose OWNER
  //     did not occupy a seat, which made "1 of 0 used" the honest reading of
  //     every free workspace. The owner counts as one seat; a free workspace
  //     holds exactly its owner and nobody else.
  //   * TEAM seats 5 → 10, and TEAM members-per-group 5 → 10 with it. The
  //     group ceiling is reconciled to the seat entitlement instead of
  //     contradicting it: a group may contain everyone in the workspace, and
  //     cannot contain anyone else, because assignment refuses a non-member.
  //     A group is not a second seat pool.
  //
  // The `workspaces` column is unchanged and still asserted as an absence.
  const CANONICAL = {
    FREE: { workspaces: 0, teams: 0, members: 0, seats: 1, pending: 0, rate: 0 },
    PAYG: { workspaces: 0, teams: 0, members: 0, seats: 1, pending: 0, rate: 0 },
    PRO: { workspaces: 2, teams: 2, members: 5, seats: 5, pending: 10, rate: 50 },
    TEAM: { workspaces: 5, teams: 5, members: 10, seats: 10, pending: 25, rate: 100 },
    ENTERPRISE: {
      workspaces: 1000,
      teams: 1000,
      members: 500,
      seats: 500,
      pending: 1000,
      rate: 5000,
    },
  } as const;

  it("ships the exact limits table for every plan tier", () => {
    for (const [plan, want] of Object.entries(CANONICAL)) {
      const caps = getPlanCapabilities(plan as keyof typeof CANONICAL);
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the workspaces
      // column was removed from this table with the capability it described.
      // `want.workspaces` is asserted as an ABSENCE instead, so the table stays
      // a complete description of the plan rather than quietly dropping a row.
      expect(Object.keys(caps), `${plan}.maxOwnedWorkspaces`).not.toContain(
        "maxOwnedWorkspaces",
      );
      expect(
        caps.maxCollaborationTeamsPerWorkspace,
        `${plan}.maxCollaborationTeamsPerWorkspace`,
      ).toBe(want.teams);
      expect(
        caps.maxAcceptedMembersPerCollaborationTeam,
        `${plan}.maxAcceptedMembersPerCollaborationTeam`,
      ).toBe(want.members);
      expect(caps.maxWorkspaceSeats, `${plan}.maxWorkspaceSeats`).toBe(want.seats);
      expect(
        caps.maxPendingInvitesPerTeam,
        `${plan}.maxPendingInvitesPerTeam`,
      ).toBe(want.pending);
      expect(caps.maxInvitesPer24h, `${plan}.maxInvitesPer24h`).toBe(want.rate);
    }
  });

  it("plan tiers are monotonically increasing in capacity", () => {
    const order = ["FREE", "PRO", "TEAM", "ENTERPRISE"] as const;
    for (let i = 1; i < order.length; i += 1) {
      const lower = getPlanCapabilities(order[i - 1]);
      const higher = getPlanCapabilities(order[i]);
      expect(lower.maxCollaborationTeamsPerWorkspace).toBeLessThanOrEqual(
        higher.maxCollaborationTeamsPerWorkspace,
      );
      expect(lower.maxAcceptedMembersPerCollaborationTeam).toBeLessThanOrEqual(
        higher.maxAcceptedMembersPerCollaborationTeam,
      );
    }
  });

  it("FREE and PAYG include zero Collaboration Teams", () => {
    expect(getPlanCapabilities("FREE").maxCollaborationTeamsPerWorkspace).toBe(0);
    expect(getPlanCapabilities("PAYG").maxCollaborationTeamsPerWorkspace).toBe(0);
  });

  it("no plan carries a workspace-count allowance, and the Collaboration Team cap is its own field", () => {
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — this test used to
    // assert that the Owned Workspace cap and the Collaboration Team cap were
    // SEPARATE fields, because they had once been a single overloaded integer
    // that granted a PRO account two workspaces AND two collaboration teams.
    //
    // The conflation it guards against can no longer be reintroduced by
    // merging the two, because there is only one of them left: no plan sells
    // additional workspaces. So the test now asserts the stronger thing —
    // that the workspace count is absent entirely — while keeping the
    // collaboration cap's independence from the two retired overloaded names.
    const caps = getPlanCapabilities("PRO");
    expect(Object.keys(caps)).not.toContain("maxOwnedWorkspaces");
    expect(Object.keys(caps)).toContain("maxCollaborationTeamsPerWorkspace");
    expect(Object.keys(caps)).not.toContain("maxOwnedTeams");
    expect(Object.keys(caps)).not.toContain("maxMembersPerTeam");
  });
});

// =============================================================================
// Stage 7 — token format
// =============================================================================

describe("Phase R14 — Stage 7: invite token format", () => {
  it("token prefix is well-defined and namespaced", () => {
    expect(COLLABORATION_TEAM_INVITE_TOKEN_PREFIX).toBe("ctit_v1_");
  });

  it("token random bytes >= 32 (256-bit entropy)", () => {
    expect(COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES).toBeGreaterThanOrEqual(32);
  });

  it("isWellFormedCollaborationTeamInviteToken validates shape", () => {
    expect(isWellFormedCollaborationTeamInviteToken("")).toBe(false);
    expect(isWellFormedCollaborationTeamInviteToken(null)).toBe(false);
    expect(isWellFormedCollaborationTeamInviteToken("ctit_v1_short")).toBe(false);
    expect(
      isWellFormedCollaborationTeamInviteToken(
        "ctit_v1_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ",
      ),
    ).toBe(true);
  });

  it("renderCollaborationTeamInvitationSmsBody fits in a single SMS frame (≤320 chars)", () => {
    const body = renderCollaborationTeamInvitationSmsBody({
      teamName: "Insurance Investigations Team",
      workspaceName: "Acme Insurance Co",
      inviterDisplay: "Jane Smith",
      acceptUrl: "https://app.proovra.com/collaboration-teams/invites/ctit_v1_ABCDEFGH/accept",
    });
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body).toContain("Insurance Investigations Team");
    expect(body).toContain("Jane Smith");
    expect(body).toContain("STOP");
  });
});

// =============================================================================
// Stage 2 — migration + schema
// =============================================================================

describe("Phase R14 — Stage 2: schema + migration", () => {
  const schema = read("services/api/prisma/schema.prisma");

  it("declares the 5 collaboration_* Prisma models", () => {
    expect(schema).toMatch(/model CollaborationTeam\b/);
    expect(schema).toMatch(/model CollaborationTeamMember\b/);
    expect(schema).toMatch(/model CollaborationTeamInvite\b/);
    expect(schema).toMatch(/model CollaborationTeamActivity\b/);
    expect(schema).toMatch(/model CollaborationTeamAssignment\b/);
  });

  it("CollaborationTeam.workspaceId references the legacy `Team` row (workspace; rule 1)", () => {
    expect(schema).toMatch(
      /model CollaborationTeam[\s\S]{0,2000}workspace Team @relation\("CollaborationTeamWorkspace"/,
    );
  });

  it("CollaborationTeamInvite.tokenHash is unique and persisted as a hash (no raw token column)", () => {
    expect(schema).toMatch(/tokenHash\s+String\s+@map\("token_hash"\)/);
    // No `tokenRaw` / `token` column.
    expect(schema).not.toMatch(/tokenRaw\s+String/);
    expect(schema).not.toMatch(/\n\s*token\s+String\s+@db\.VarChar/);
    // Unique index pinned.
    expect(schema).toMatch(/collaboration_team_invite_token_hash_uniq/);
  });

  it("ships the Phase-O hardened migration", () => {
    const migPath =
      "services/api/prisma/migrations/20270201000000_phase_5_collaboration_teams/migration.sql";
    expect(exists(migPath)).toBe(true);
    const sql = read(migPath);
    // Hardening signature: every CREATE TABLE inside a DO block with
    // pg_tables existence check.
    expect(sql).toMatch(/DO \$\$[\s\S]{0,2000}pg_tables[\s\S]{0,2000}CREATE TABLE/);
    // Every indexed table guarded by per-column existence checks.
    expect(sql).toMatch(/information_schema\.columns/);
    // No raw token column.
    expect(sql).not.toMatch(/"token"\s+VARCHAR/);
    // Unique index on token_hash present.
    expect(sql).toMatch(/collaboration_team_invite_token_hash_uniq/);
  });
});

// =============================================================================
// Stage 3 — service module exposes the canonical API
// =============================================================================

describe("Phase R14 — Stage 3: service module public surface", () => {
  const svc = read(
    "services/api/src/services/collaboration-team/collaboration-team.service.ts",
  );

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. `createSmsInvite` / `createLinkInvite`
  // are DELETED from the service surface.
  it("exports the canonical functions for CRUD + members + invites (EMAIL-only) + activity + assignments", () => {
    const requiredExports = [
      "createCollaborationTeam",
      "listCollaborationTeams",
      "getCollaborationTeamDetail",
      "updateCollaborationTeam",
      "archiveCollaborationTeam",
      "addExistingMember",
      "changeMemberRole",
      "suspendMember",
      "removeMember",
      // CLOSURE (2026-09-06) — `createEmailInvite` left this list because the
      // writer was DELETED: there is ONE invitation authority and it invites
      // into the WORKSPACE, where acceptance atomically claims a seat.
      // `revokeInvite` and `acceptInvite` stay for links already in flight;
      // the set of rows they act on only shrinks.
      "revokeInvite",
      "acceptInvite",
      "listTeamActivity",
      "createAssignment",
      "updateAssignment",
      "listAssignments",
      "recordInviteDeliveryResult",
    ];
    for (const sym of requiredExports) {
      expect(svc, `missing export ${sym}`).toMatch(
        new RegExp(`export (async function|function|const) ${sym}\\b`),
      );
    }
    for (const gone of ["createSmsInvite", "createLinkInvite"]) {
      expect(svc, `deleted export ${gone} must be absent`).not.toContain(
        gone,
      );
    }
  });

  it("never stores the raw invite token (only sha256 hash)", () => {
    // The service code must hash tokens; the raw value lives only on
    // the wire (return type). The Prisma write uses `tokenHash`.
    expect(svc).toMatch(/createHash\("sha256"\)/);
    expect(svc).toMatch(/tokenHash:\s*hash/);
    expect(svc).not.toMatch(/tokenRaw:/);
  });

  it("creator is auto-added as LEAD on team creation", () => {
    expect(svc).toMatch(
      /createCollaborationTeam[\s\S]{0,2500}collaborationTeamMember\.create[\s\S]{0,400}role:\s*"LEAD"/,
    );
  });
});

// =============================================================================
// Stage 4 — routes
// =============================================================================

describe("Phase R14 — Stage 4: API routes", () => {
  const routes = read("services/api/src/routes/collaboration-teams.routes.ts");
  const server = read("services/api/src/server.ts");

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. The /invites/sms and /invites/link
  // endpoints are DELETED (email invite + revoke + accept remain).
  it("registers all required endpoints under /v1/collaboration-teams (no sms/link invite routes)", () => {
    // Just check the route paths exist as quoted strings — the
    // Fastify generic shape (`<{ Params: { teamId: string } }>`) has
    // nested braces that are awkward to regex; the route path string
    // is the load-bearing contract.
    const requiredPaths = [
      '"/v1/collaboration-teams"',
      '"/v1/collaboration-teams/:teamId"',
      '"/v1/collaboration-teams/:teamId/archive"',
      '"/v1/collaboration-teams/:teamId/members"',
      '"/v1/collaboration-teams/:teamId/members/:memberId"',
      '"/v1/collaboration-teams/:teamId/invites/email"',
      '"/v1/collaboration-teams/:teamId/invites/:inviteId/revoke"',
      '"/v1/collaboration-team-invites/:token/accept"',
      '"/v1/collaboration-teams/:teamId/activity"',
      '"/v1/collaboration-teams/:teamId/assignments"',
      '"/v1/collaboration-teams/:teamId/assignments/:assignmentId"',
    ];
    for (const path of requiredPaths) {
      expect(routes, `missing route ${path}`).toContain(path);
    }
    expect(routes).not.toContain("invites/sms");
    expect(routes).not.toContain("invites/link");
  });

  it("routes are wired into the Fastify app via server.ts", () => {
    expect(server).toMatch(/collaborationTeamsRoutes/);
    expect(server).toMatch(/await app\.register\(collaborationTeamsRoutes\)/);
  });

  it("every mutation emits a tenant-audit event via the canonical facade", () => {
    // We just spot-check that the audit helper exists and is called.
    // PHASE 11 §3 Batch C — migrated off appendPlatformAuditLog onto the
    // canonical emitTenantAudit facade (writes category "tenant_audit").
    expect(routes).toMatch(/emitTenantAudit/);
    expect(routes).toMatch(/workspaceId: args\.workspaceId/);
  });

  it("uses the Phase 3 canonical resolveActiveOperationalWorkspace helper", () => {
    expect(routes).toMatch(/resolveActiveOperationalWorkspace/);
  });

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. There is no LINK invite; the raw
  // token now NEVER crosses the HTTP surface — the service returns it
  // once (rawToken + acceptUrl) solely so the delivery wrapper can
  // embed the accept link in the invite EMAIL.
  // CLOSURE (2026-09-06) — the property SHARPENED. The group service no longer
  // MINTS a token at all, because it no longer issues invitations: the writer
  // is deleted. So "the raw token never crosses the HTTP surface" is now the
  // weaker half of "this service produces no raw token to cross it", and the
  // one remaining occurrence in the routes file is the accept path CONSUMING a
  // token someone was already sent.
  //
  // The workspace invitation — the one that does mint — is held to the
  // original rule at its own level: it returns the raw value exactly once, to
  // the caller that will put it in an email, and never persists or projects
  // it. That is asserted here and proven end-to-end against live PostgreSQL in
  // `wcr-invitation-closure.integration.test.ts`.
  it("no raw invite token crosses the HTTP surface, and the group service mints none", () => {
    const routeHits = routes.match(/rawToken/g) ?? [];
    expect(routeHits.length).toBe(1);
    expect(routes).toMatch(/rawToken:\s*req\.params\.token/);

    const svc = read(
      "services/api/src/services/collaboration-team/collaboration-team.service.ts",
    );
    expect(svc).not.toMatch(/rawToken:\s*raw\b/);
    expect(svc).not.toContain("buildAcceptUrl");

    // THE authority that does mint, held to the same rule.
    const invite = read(
      "services/api/src/services/identity/workspace-invitation.service.ts",
    );
    expect(invite.match(/rawToken:\s*raw\b/g)?.length).toBe(2);
    // What it PROJECTS carries no secret: no token, no hash.
    const projection = invite.slice(
      invite.indexOf("export function projectInvitation"),
    );
    const projectionBody = projection.slice(0, projection.indexOf("\n}"));
    expect(projectionBody).not.toContain("tokenHash");
    expect(projectionBody).not.toMatch(/\btoken\b/);
  });
});

// =============================================================================
// Stage 7 — invitation delivery
//
// WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION (2026-09-06) —
// `collaboration-team-delivery.service.ts` was DELETED with the second
// invitation system it served.
//
// There is ONE invitation authority now: into the WORKSPACE, where acceptance
// atomically claims a seat. A group is filled by ASSIGNING people who already
// hold one, because a group is not a seat pool — the same person in five
// groups is still one seat, so a second invitation system with its own
// channels and capacity rules could only ever disagree with the entitlement
// that is actually sold. Its SMS wrapper had already lost its channel (SMS and
// shareable-link invitations were removed from the product in 2026-07-14), and
// when the email route retired, the module had no consumer left and the
// module-reachability gate required a disposition.
//
// The properties this stage protected are asserted on the surviving delivery
// path: it goes through the canonical email service, it records the outcome,
// and it never writes the raw token to a log.
// =============================================================================

describe("Phase R14 — Stage 7: workspace-invitation delivery", () => {
  const routes = read("services/api/src/routes/teams.routes.ts");

  it("the retired per-group delivery service is gone, with no consumer left behind", () => {
    expect(
      existsSync(
        join(
          repoRoot,
          "services/api/src/services/collaboration-team/collaboration-team-delivery.service.ts",
        ),
      ),
    ).toBe(false);
    const collabRoutes = read(
      "services/api/src/routes/collaboration-teams.routes.ts",
    );
    expect(collabRoutes).not.toMatch(/collaboration-team-delivery/);
    expect(collabRoutes).not.toMatch(/sendCollaborationTeamInviteEmail/);
    expect(collabRoutes).not.toMatch(/sendCollaborationTeamInviteSms/);
  });

  it("delivery goes through the canonical email service, never a bespoke sender", () => {
    expect(routes).toMatch(/async function deliverWorkspaceInvite/);
    expect(routes).toMatch(/getEmailService\(\)/);
    expect(routes).toMatch(/sendTeamInvitation\(/);
  });

  it("a delivery failure is REPORTED, not swallowed into a false success", () => {
    const helper = routes.slice(
      routes.indexOf("async function deliverWorkspaceInvite"),
    );
    const body = helper.slice(0, helper.indexOf("\nfunction buildInviteUrl"));
    // It returns whether the mail actually went, and the caller records it.
    expect(body).toMatch(/return false;/);
    expect(body).toMatch(/return true;/);
    expect(routes).toMatch(/emailSent/);
  });

  it("never logs the raw token or the address", () => {
    const helper = routes.slice(
      routes.indexOf("async function deliverWorkspaceInvite"),
    );
    const body = helper.slice(0, helper.indexOf("\nfunction buildInviteUrl"));
    // The logged context is the error and the workspace — nothing that
    // identifies the invitee or that could be redeemed.
    expect(body).toContain("{ err, teamId: input.teamId }");
    expect(body.match(/log\.[a-z]+\([^)]*rawToken/g)).toBeNull();
    expect(body.match(/log\.[a-z]+\([^)]*input\.email/g)).toBeNull();
  });
});

// =============================================================================
// Constitutional rules
// =============================================================================

describe("Phase R14 — constitutional rules", () => {
  const schema = read("services/api/prisma/schema.prisma");
  const svc = read(
    "services/api/src/services/collaboration-team/collaboration-team.service.ts",
  );

  it("Rule 1: CollaborationTeam.workspaceId references a workspace (not creates a workspace kind)", () => {
    // The model has workspaceId FK; it is NOT a workspace itself.
    expect(schema).toMatch(/CollaborationTeam\s*\{[\s\S]{0,800}workspaceId/);
  });

  it("Rule 4-7: Personal users can create teams (no Organization gate in service)", () => {
    // The service has no `if (org ===` check anywhere; the only
    // workspace-scope check is the parent workspace membership.
    expect(svc).not.toMatch(/requires?\s+Organization/i);
    expect(svc).not.toMatch(/organizationRequired/);
  });

  it("Rule 8-9: no new workspace kind introduced (no `CollaborationWorkspace` or similar token)", () => {
    expect(schema).not.toMatch(/model CollaborationWorkspace\b/);
    expect(schema).not.toMatch(/model ReviewerWorkspace\b/);
    expect(schema).not.toMatch(/model GovernanceWorkspace\b/);
    expect(schema).not.toMatch(/model OperationsWorkspace\b/);
  });

  it("Rule: legacy `Team` table is NOT renamed by this phase", () => {
    expect(schema).toMatch(/^model Team \{/m);
    expect(schema).toMatch(/@@map\("teams"\)/);
  });
});

// =============================================================================
// Sanity — shared barrel exports + module placement
// =============================================================================

describe("Phase R14 — shared package barrel + module placement", () => {
  it("packages/shared barrel re-exports the new vocabulary", () => {
    const barrel = read("packages/shared/src/index.ts");
    expect(barrel).toContain("./collaboration-team.js");
    expect(barrel).toContain("COLLABORATION_TEAM_ROLES");
    expect(barrel).toContain("renderCollaborationTeamInvitationSmsBody");
  });

  it("service module sits under services/api/src/services/collaboration-team/", () => {
    expect(
      exists(
        "services/api/src/services/collaboration-team/collaboration-team.service.ts",
      ),
    ).toBe(true);
    // The delivery module was deleted with the second invitation system it
    // served — see Stage 7 above. Its absence is asserted there; asserting it
    // here too would only repeat the same fact in a placement test.
    expect(
      exists(
        "services/api/src/services/collaboration-team/collaboration-authorization.ts",
      ),
    ).toBe(true);
  });

  it("routes module sits under services/api/src/routes/", () => {
    expect(
      exists("services/api/src/routes/collaboration-teams.routes.ts"),
    ).toBe(true);
  });
});
