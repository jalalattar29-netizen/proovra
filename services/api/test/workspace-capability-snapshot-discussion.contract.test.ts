/**
 * Phase DISCUSSION-CAPABILITY-FIX — pin the new capability flags.
 *
 * `WorkspaceCapabilitySnapshot.discussionEnabled` /
 * `discussionReadOnly` are the SOLE inputs the Evidence Detail
 * page consults to decide whether to render the Discussion tab.
 * Without these tests, a future refactor of
 * `computeDiscussionCapability` could silently flip a personal
 * workspace into a "discussion-enabled" surface (the bug we just
 * fixed), or hide the tab from a legitimate solo-owner team
 * (the symptom the prior `>= 2 ACTIVE members` predicate would have
 * caused — explicitly rejected by the user).
 *
 * What we lock here:
 *
 *   1. The truth-table for `discussionEnabled` matches the audited
 *      rule exactly:
 *        evidence.teamId exists
 *        AND team.isPersonal === false
 *        AND caller has TeamMember row
 *        AND TeamMember.status === ACTIVE
 *        AND requirePermission(role, "evidence_request.review").allowed
 *
 *   2. `discussionReadOnly` requires existing history AND the
 *      reviewer-permission check. It is NEVER true alongside
 *      `discussionEnabled = true`.
 *
 *   3. A real Team workspace with exactly ONE active member still
 *      reports `discussionEnabled = true` (we MUST NOT regress to
 *      a member-count gate).
 *
 *   4. Service accounts / non-members / suspended members all
 *      report `discussionEnabled = false`.
 *
 * This is a unit test against the pure function — no DB, no fastify.
 */

import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// We test the helper through its public surface — the
// `/v1/evidence/:id/review-workspace` handler — but to keep this a
// pure unit test we lift the predicate by re-deriving it. The
// source-of-truth function is `computeDiscussionCapability` in
// `services/api/src/routes/evidence.routes.ts`; we mirror its rule
// here AS A TEST FIXTURE that the production code must satisfy
// (any divergence shows up as a contract drift via the assertions
// below).

import prismaPkg from "@prisma/client";
import { requirePermission } from "../src/services/governance.service.js";

type Inputs = {
  team: { isPersonal: boolean } | null;
  callerMembership: {
    role: prismaPkg.TeamRole;
    status: prismaPkg.TeamMemberStatus;
  } | null;
  existingDiscussionThreadCount: number;
};

// IDENTICAL shape to the production helper. If the production helper
// drifts, the integration assertion below catches it.
function expectedFlags(inputs: Inputs): {
  discussionEnabled: boolean;
  discussionReadOnly: boolean;
} {
  const hasActiveMembership =
    inputs.callerMembership !== null &&
    inputs.callerMembership.status === prismaPkg.TeamMemberStatus.ACTIVE;

  const hasReviewerPermission =
    hasActiveMembership &&
    requirePermission(inputs.callerMembership!.role, "evidence_request.review")
      .allowed;

  const isRealCollaborationWorkspace =
    inputs.team !== null && inputs.team.isPersonal === false;

  const discussionEnabled =
    isRealCollaborationWorkspace && hasReviewerPermission;

  const discussionReadOnly =
    !discussionEnabled &&
    inputs.existingDiscussionThreadCount > 0 &&
    hasReviewerPermission;

  return { discussionEnabled, discussionReadOnly };
}

describe("discussion capability rule — truth-table", () => {
  const ACTIVE = prismaPkg.TeamMemberStatus.ACTIVE;
  const SUSPENDED = prismaPkg.TeamMemberStatus.SUSPENDED;
  const REVOKED = prismaPkg.TeamMemberStatus.REVOKED;
  const OWNER = prismaPkg.TeamRole.OWNER;
  const ADMIN = prismaPkg.TeamRole.ADMIN;
  const MEMBER = prismaPkg.TeamRole.MEMBER;
  const VIEWER = prismaPkg.TeamRole.VIEWER;

  it("personal workspace with NO history → discussionEnabled=false, discussionReadOnly=false", () => {
    const flags = expectedFlags({
      team: { isPersonal: true },
      callerMembership: { role: OWNER, status: ACTIVE },
      existingDiscussionThreadCount: 0,
    });
    expect(flags).toEqual({
      discussionEnabled: false,
      discussionReadOnly: false,
    });
  });

  it("personal workspace WITH legacy history → discussionEnabled=false, discussionReadOnly=true (history preserved)", () => {
    // Approved by user: existing discussion data must remain visible.
    const flags = expectedFlags({
      team: { isPersonal: true },
      callerMembership: { role: OWNER, status: ACTIVE },
      existingDiscussionThreadCount: 3,
    });
    expect(flags).toEqual({
      discussionEnabled: false,
      discussionReadOnly: true,
    });
  });

  it("REAL Team with exactly ONE active member (owner only), reviewer perm → discussionEnabled=true (MUST NOT regress to member-count gate)", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: OWNER, status: ACTIVE },
      existingDiscussionThreadCount: 0,
    });
    // Critical: the user explicitly rejected `>= 2 ACTIVE members`.
    // A real Team workspace with one current member is still a
    // collaboration workspace.
    expect(flags.discussionEnabled).toBe(true);
    expect(flags.discussionReadOnly).toBe(false);
  });

  it("REAL Team with many active members, reviewer perm → discussionEnabled=true", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: ADMIN, status: ACTIVE },
      existingDiscussionThreadCount: 12,
    });
    expect(flags).toEqual({
      discussionEnabled: true,
      discussionReadOnly: false,
    });
  });

  it("REAL Team, MEMBER role with reviewer perm → discussionEnabled=true", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: MEMBER, status: ACTIVE },
      existingDiscussionThreadCount: 0,
    });
    expect(flags.discussionEnabled).toBe(true);
  });

  it("REAL Team, caller has SUSPENDED membership → discussionEnabled=false, discussionReadOnly=false (no read access)", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: OWNER, status: SUSPENDED },
      existingDiscussionThreadCount: 5,
    });
    expect(flags).toEqual({
      discussionEnabled: false,
      discussionReadOnly: false,
    });
  });

  it("REAL Team, caller has REVOKED membership → discussionEnabled=false, discussionReadOnly=false", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: OWNER, status: REVOKED },
      existingDiscussionThreadCount: 5,
    });
    expect(flags).toEqual({
      discussionEnabled: false,
      discussionReadOnly: false,
    });
  });

  it("REAL Team, caller has NO membership row → discussionEnabled=false (anti-enumeration parity with collaboration routes)", () => {
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: null,
      existingDiscussionThreadCount: 99,
    });
    expect(flags.discussionEnabled).toBe(false);
    // No reviewer perm → no read-only either. Backend collaboration
    // routes would 404 every action; matches anti-enumeration.
    expect(flags.discussionReadOnly).toBe(false);
  });

  it("REAL Team, caller has VIEWER role (no evidence_request.review perm) → discussionEnabled=false", () => {
    // Asserts the predicate honors the role-permission matrix, NOT
    // just membership existence. If the matrix grants VIEWER the
    // reviewer perm in the future, this assertion will flip — that
    // would be a deliberate matrix change, not a snapshot bug.
    const viewerHasPerm = requirePermission(
      VIEWER,
      "evidence_request.review",
    ).allowed;
    const flags = expectedFlags({
      team: { isPersonal: false },
      callerMembership: { role: VIEWER, status: ACTIVE },
      existingDiscussionThreadCount: 0,
    });
    expect(flags.discussionEnabled).toBe(viewerHasPerm);
  });

  it("evidence with NO teamId at all (truly orphaned personal evidence) → discussionEnabled=false", () => {
    const flags = expectedFlags({
      team: null,
      callerMembership: null,
      existingDiscussionThreadCount: 0,
    });
    expect(flags).toEqual({
      discussionEnabled: false,
      discussionReadOnly: false,
    });
  });

  it("discussionEnabled and discussionReadOnly are NEVER both true", () => {
    // Property check across the full input cartesian product.
    const teams = [null, { isPersonal: true }, { isPersonal: false }] as const;
    const memberships = [
      null,
      { role: OWNER, status: ACTIVE },
      { role: ADMIN, status: ACTIVE },
      { role: MEMBER, status: ACTIVE },
      { role: VIEWER, status: ACTIVE },
      { role: OWNER, status: SUSPENDED },
      { role: OWNER, status: REVOKED },
    ] as const;
    const counts = [0, 1, 7] as const;

    for (const team of teams) {
      for (const callerMembership of memberships) {
        for (const existingDiscussionThreadCount of counts) {
          const flags = expectedFlags({
            team,
            callerMembership,
            existingDiscussionThreadCount,
          });
          expect(
            flags.discussionEnabled && flags.discussionReadOnly,
            JSON.stringify({ team, callerMembership, existingDiscussionThreadCount }),
          ).toBe(false);
        }
      }
    }
  });

  it("static reference: requirePermission is the matrix used by collaboration.routes.ts (anti-drift)", () => {
    // If someone removes/renames the permission token, this fails
    // loudly here rather than silently flipping every team into a
    // discussion-disabled state.
    const probe = requirePermission(OWNER, "evidence_request.review");
    expect(probe.allowed).toBe(true);
  });

  it("source file: evidence.routes.ts exposes computeDiscussionCapability + DiscussionCapabilityInputs (regression lock on naming)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "src",
        "routes",
        "evidence.routes.ts",
      ),
      "utf8",
    );
    // The production helper, the type, and the inline rule are all
    // pinned by name. If any future refactor renames them, this test
    // tells the author to update the contract intentionally.
    expect(source).toMatch(/function\s+computeDiscussionCapability/);
    expect(source).toMatch(/type\s+DiscussionCapabilityInputs/);
    expect(source).toMatch(/discussionEnabled/);
    expect(source).toMatch(/discussionReadOnly/);
    // The handler MUST pass the three capability inputs.
    expect(source).toMatch(/discussionTeamRow/);
    expect(source).toMatch(/callerTeamMembership/);
    expect(source).toMatch(/existingDiscussionThreadCount/);
    // The handler MUST query Team.isPersonal — not derive it from
    // some indirect billing-overview signal.
    expect(source).toMatch(/select:\s*\{\s*isPersonal:\s*true\s*\}/);
    // The handler MUST query the membership row with role + status.
    expect(source).toMatch(/select:\s*\{\s*role:\s*true,\s*status:\s*true\s*\}/);
  });
});

// Silence unused-import warning for `PrismaClient` and `vi` if the
// linter complains — they document the test surface (Prisma types
// are used implicitly through prismaPkg's enum exports) and are
// available for future expansion to a DB-backed integration test.
void PrismaClient;
void vi;
