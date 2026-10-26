/**
 * Re-audit defect 17 — the Members & Access role dialog's copy is true.
 *
 * `GET /v1/platform/rbac/matrix` feeds the role dialog on the Members & Access
 * page. Its "members" rows said "team" meaning Workspace, cited a workspace
 * seat limit that no longer exists, printed raw role enums and told people an
 * Admin could "promote or demote between ADMIN / MEMBER / VIEWER" — which the
 * rank authority (rbac.service.ts `assertActorOutranks`) refuses.
 *
 * Two halves:
 *   1. vocabulary — no user-visible string says "team" except as
 *      "Collaboration Team", none prints a role enum, none cites a seat limit;
 *   2. truth — every concrete claim the role-change and removal rows make is
 *      driven through the REAL engine preflight (`preflightMemberMutation`),
 *      over a stub data client that holds just the two member rows.
 */
import { describe, expect, it } from "vitest";

import { buildRbacMatrix } from "../src/services/platform-context/rbac-matrix.js";
import { RbacError, preflightMemberMutation } from "../src/services/identity/rbac.service.js";

const matrix = buildRbacMatrix();
const rows = matrix.categories.flatMap((c) => c.capabilities);
const membersCategory = matrix.categories.find((c) => c.id === "team")!;
const row = (id: string) => rows.find((r) => r.id === id)!;

/** Every string a person can read in the dialog. */
const visibleStrings = [
  ...matrix.roles.map((r) => r.label),
  ...matrix.categories.map((c) => c.label),
  ...rows.flatMap((r) => [r.label, r.description]),
];

describe("defect 17 — vocabulary", () => {
  it("no visible string says 'team' meaning Workspace (only 'Collaboration Team' is allowed)", () => {
    const offenders = visibleStrings.filter((s) =>
      /\bteams?\b/i.test(s.replace(/Collaboration Teams?/g, "")),
    );
    expect(offenders).toEqual([]);
  });

  it("no visible string prints a raw role or platform enum", () => {
    const offenders = visibleStrings.filter((s) =>
      /\b(OWNER|ADMIN|MEMBER|VIEWER|PLATFORM_ADMIN)\b/.test(s),
    );
    expect(offenders).toEqual([]);
  });

  it("no visible string names a database table or an internal phase", () => {
    const offenders = visibleStrings.filter((s) => /`|\b[a-z]+_[a-z_]+\b|Phase \d/.test(s));
    expect(offenders).toEqual([]);
  });

  it("the members category is named for what it is", () => {
    expect(membersCategory.label).toBe("Members & access");
  });

  it("invites do not cite a workspace seat limit; capacity is per Collaboration Team", () => {
    const invite = row("team.invite").description;
    expect(invite).not.toMatch(/subject to the workspace seat limit/i);
    expect(invite).toMatch(/per Collaboration Team/);
    expect(invite).toMatch(/never as Owner/);
  });
});

// ---------------------------------------------------------------------------
// Truth: the claims, run through the real rank / owner / self rules.
// ---------------------------------------------------------------------------

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
const TEAM = "00000000-0000-4000-8000-000000000001";

/** A stub client holding exactly an actor and a target member. */
function clientFor(actorRole: Role, targetRole: Role) {
  const members = [
    { id: "m-actor", teamId: TEAM, userId: "u-actor", role: actorRole, status: "ACTIVE" },
    { id: "m-target", teamId: TEAM, userId: "u-target", role: targetRole, status: "ACTIVE" },
  ];
  return {
    teamMember: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) =>
        members.find((m) => (where.id ? m.id === where.id : m.userId === where.userId)) ?? null,
    },
  } as never;
}

async function engineAllows(actor: Role, target: Role, newRole?: Role): Promise<boolean> {
  try {
    await preflightMemberMutation(
      {
        teamId: TEAM,
        teamMemberId: "m-target",
        actorUserId: "u-actor",
        ...(newRole ? { newRole: newRole as never } : {}),
      },
      clientFor(actor, target),
    );
    return true;
  } catch (err) {
    if (err instanceof RbacError) return false;
    throw err;
  }
}

describe("defect 17 — the role-change and removal copy matches the engine", () => {
  const roleChange = row("team.role_change").description;
  const removal = row("team.remove").description;

  it("the copy states the rank rule", () => {
    expect(roleChange).toMatch(/The Owner can make any other member an Admin, Member or Viewer/);
    expect(roleChange).toMatch(/An Admin can move only Members and Viewers between Member and Viewer/);
    expect(roleChange).toMatch(/cannot change another Admin or the Owner/);
    expect(roleChange).toMatch(/ownership moves only by transfer/);
    expect(removal).toMatch(/The Owner cannot be removed/);
    expect(removal).toMatch(/an Admin can remove only Members and Viewers, not another Admin/);
  });

  it("'The Owner can make any other member an Admin, Member or Viewer'", async () => {
    for (const target of ["ADMIN", "MEMBER", "VIEWER"] as const) {
      for (const to of ["ADMIN", "MEMBER", "VIEWER"] as const) {
        expect(await engineAllows("OWNER", target, to), `${target}→${to}`).toBe(true);
      }
    }
  });

  it("'An Admin can move only Members and Viewers between Member and Viewer'", async () => {
    for (const target of ["MEMBER", "VIEWER"] as const) {
      for (const to of ["MEMBER", "VIEWER"] as const) {
        expect(await engineAllows("ADMIN", target, to), `${target}→${to}`).toBe(true);
      }
      expect(await engineAllows("ADMIN", target, "ADMIN"), `${target}→ADMIN`).toBe(false);
    }
  });

  it("'cannot change another Admin or the Owner' and 'ownership moves only by transfer'", async () => {
    expect(await engineAllows("ADMIN", "ADMIN", "MEMBER")).toBe(false);
    expect(await engineAllows("ADMIN", "OWNER", "MEMBER")).toBe(false);
    expect(await engineAllows("OWNER", "ADMIN", "OWNER")).toBe(false);
  });

  it("removal: 'The Owner cannot be removed', 'an Admin can remove only Members and Viewers'", async () => {
    expect(await engineAllows("ADMIN", "OWNER")).toBe(false);
    expect(await engineAllows("ADMIN", "ADMIN")).toBe(false);
    expect(await engineAllows("ADMIN", "MEMBER")).toBe(true);
    expect(await engineAllows("ADMIN", "VIEWER")).toBe(true);
    expect(await engineAllows("OWNER", "ADMIN")).toBe(true);
  });
});
