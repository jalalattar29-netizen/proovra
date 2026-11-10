// Database acquisition: bootIntegrationHarness() (the ONE canonical helper).
/**
 * AUD-0047 — A PERSON INVITED INTO A PRO OR TEAM WORKSPACE CAN OPEN IT
 * (live PostgreSQL 16).
 *
 * A Pro or Team workspace is its owner's PERSONAL Team (`isPersonal = true`,
 * single-occupant billing) with members invited into it. The invitee's ACTIVE
 * membership used to stop short of the switcher: the context options offered
 * only the caller's own Personal Space, their OWNED workspaces and their
 * Organizations, so an accepted invitation led nowhere. The switch route
 * already authorized the move; nothing offered it.
 *
 * Proven here, through the real routes:
 *
 *   1. A PRO invitation accepted through `POST /v1/teams/invites/:token/accept`
 *      and an ACTIVE ADMIN membership in a TEAM owner's workspace both appear
 *      under `contextOptions.sharedWorkspaces` (and `canonical.sharedWorkspaces`)
 *      with the owner's name — never an id — and the member's own role. The
 *      member's own Personal Space is unchanged.
 *   2. Switching into each answers 200, and the active space then carries the
 *      shared workspace's name, the member's real role and its plan (PRO /
 *      TEAM), not "Personal Space" / "Owner" / the member's FREE plan.
 *   3. A fresh sign-in still lists both.
 *   4. A REVOKED membership disappears from the options and the switch is
 *      refused; the stale pointer heals to the member's own Personal Space.
 *   5. CONTROL — an Organization-workspace member still sees it under
 *      `organizations` and enters it as before; the owner of a shared
 *      workspace sees it as their own Personal Space, never as "shared".
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  registerSessionForToken,
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type SharedOption = {
  workspaceId: string;
  name: string;
  kind: string;
  role: string | null;
  lifecycleStatus: string;
};

type Envelope = {
  personalSpace: { id: string | null; label: string; plan: string | null };
  activeSpace: {
    type: string;
    id: string | null;
    displayName: string | null;
    roleLabel: string | null;
    plan: string | null;
    shared?: boolean;
  };
  contextOptions: {
    personalSpace: { workspaceId: string; name: string; role: string } | null;
    ownedWorkspaces: unknown[];
    sharedWorkspaces: SharedOption[];
    organizations: Array<{
      organizationId: string;
      workspaces: Array<{ workspaceId: string; workspaceRole: string | null }>;
    }>;
    activeContext: { workspaceId: string | null; kind: string; displayName: string | null };
  };
  canonical: {
    personalSpace: { workspaceId: string } | null;
    sharedWorkspaces: Array<{
      workspaceId: string;
      name: string | null;
      kind: string;
      workspaceRole: string | null;
      workspaceMembershipId: string | null;
      organizationId: string | null;
    }>;
    currentWorkspace: { workspaceId: string; kind: string } | null;
    currentWorkspaceSource: string;
    commercialContext: { effectivePlan: string | null; billingShape: string | null };
  };
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("AUD-0047 — joined Pro/Team workspaces are offered and enterable (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  const inject = (opts: { method: "GET" | "POST"; url: string; token: string; payload?: unknown }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  const context = async (token: string): Promise<Envelope> => {
    const res = await inject({ method: "GET", url: "/v1/platform/context", token });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Envelope;
  };

  const switchTo = (token: string, workspaceId: string | null) =>
    inject({
      method: "POST",
      url: "/v1/platform/context/switch-workspace",
      token,
      payload: { workspaceId },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `aud47-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("offers Pro and Team workspaces the member joined, enters them, and withdraws a revoked one", async () => {
    const proOwner = await seedPersonalTenant(deps, "PRO");
    const teamOwner = await seedPersonalTenant(deps, "TEAM");
    const member = await seedPersonalTenant(deps, "FREE");

    // --- PRO: the real invitation, accepted through the real route ---------
    const rawToken = `wsit_v1_${randomBytes(32).toString("base64url")}`;
    await prisma.teamInvite.create({
      data: {
        teamId: proOwner.personalTeamId,
        email: member.owner.email.toLowerCase(),
        role: "MEMBER",
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: proOwner.owner.userId,
      } as never,
    });
    const accepted = await inject({
      method: "POST",
      url: `/v1/teams/invites/${rawToken}/accept`,
      token: member.owner.token,
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as { workspaceId: string }).workspaceId).toBe(proOwner.personalTeamId);

    // --- TEAM: an ACTIVE ADMIN membership (initial state) -------------------
    await prisma.teamMember.create({
      data: {
        teamId: teamOwner.personalTeamId,
        userId: member.owner.userId,
        role: "ADMIN",
        status: "ACTIVE",
      },
    });

    // (1) Offered, named after the owner, with the member's own role.
    const before = await context(member.owner.token);
    const shared = new Map(before.contextOptions.sharedWorkspaces.map((w) => [w.workspaceId, w]));
    expect(shared.size).toBe(2);
    expect(shared.get(proOwner.personalTeamId)).toEqual({
      workspaceId: proOwner.personalTeamId,
      name: "Point7 pro's workspace",
      kind: "PERSONAL",
      role: "MEMBER",
      lifecycleStatus: "active",
    });
    expect(shared.get(teamOwner.personalTeamId)).toMatchObject({
      name: "Point7 team's workspace",
      kind: "PERSONAL",
      role: "ADMIN",
    });
    for (const w of before.contextOptions.sharedWorkspaces) expect(w.name).not.toMatch(UUID);
    // The canonical envelope carries the same set.
    expect(before.canonical.sharedWorkspaces.map((w) => w.workspaceId).sort()).toEqual(
      [proOwner.personalTeamId, teamOwner.personalTeamId].sort(),
    );
    const canonicalPro = before.canonical.sharedWorkspaces.find(
      (w) => w.workspaceId === proOwner.personalTeamId,
    )!;
    expect(canonicalPro).toMatchObject({ kind: "PERSONAL", workspaceRole: "MEMBER", organizationId: null });
    expect(canonicalPro.workspaceMembershipId).toEqual(expect.any(String));
    // The member's own Personal Space is unchanged, and still theirs.
    expect(before.contextOptions.personalSpace).toMatchObject({
      workspaceId: member.personalTeamId,
      name: "Personal Space",
      role: "OWNER",
    });
    expect(before.activeSpace).toMatchObject({
      type: "PERSONAL",
      id: member.personalTeamId,
      displayName: "Personal Space",
      roleLabel: "Owner",
      shared: false,
    });
    expect(before.personalSpace.id).toBe(member.personalTeamId);
    expect(before.personalSpace.plan).toBe("FREE");
    expect(before.contextOptions.organizations).toEqual([]);

    // (2) Enter the PRO workspace.
    const toPro = await switchTo(member.owner.token, proOwner.personalTeamId);
    expect(toPro.statusCode, toPro.body).toBe(200);
    const inPro = toPro.json() as Envelope;
    expect(inPro.activeSpace).toMatchObject({
      type: "PERSONAL",
      id: proOwner.personalTeamId,
      displayName: "Point7 pro's workspace",
      roleLabel: "MEMBER",
      plan: "PRO",
      shared: true,
    });
    expect(inPro.contextOptions.activeContext).toMatchObject({
      workspaceId: proOwner.personalTeamId,
      kind: "PERSONAL",
      displayName: "Point7 pro's workspace",
    });
    expect(inPro.canonical.currentWorkspace).toMatchObject({
      workspaceId: proOwner.personalTeamId,
      kind: "PERSONAL",
    });
    expect(inPro.canonical.currentWorkspaceSource).toBe("POINTER");
    expect(inPro.canonical.commercialContext).toEqual({
      effectivePlan: "PRO",
      billingShape: "SINGLE_OCCUPANT",
    });
    // The member's OWN Personal Space keeps its own plan while they are away.
    expect(inPro.personalSpace).toMatchObject({ id: member.personalTeamId, plan: "FREE" });
    expect(inPro.contextOptions.personalSpace?.workspaceId).toBe(member.personalTeamId);

    // Enter the TEAM workspace.
    const toTeam = await switchTo(member.owner.token, teamOwner.personalTeamId);
    expect(toTeam.statusCode, toTeam.body).toBe(200);
    const inTeam = toTeam.json() as Envelope;
    expect(inTeam.activeSpace).toMatchObject({
      type: "PERSONAL",
      id: teamOwner.personalTeamId,
      displayName: "Point7 team's workspace",
      roleLabel: "ADMIN",
      plan: "TEAM",
      shared: true,
    });
    expect(inTeam.canonical.commercialContext.effectivePlan).toBe("TEAM");
    expect(inTeam.personalSpace.plan).toBe("FREE");

    // (3) A fresh sign-in still lists both, and lands where the pointer is.
    const freshToken = deps.mintToken(member.owner.userId, member.owner.email);
    await registerSessionForToken(deps, member.owner.userId, freshToken);
    const fresh = await context(freshToken);
    expect(fresh.contextOptions.sharedWorkspaces.map((w) => w.workspaceId).sort()).toEqual(
      [proOwner.personalTeamId, teamOwner.personalTeamId].sort(),
    );
    expect(fresh.activeSpace).toMatchObject({
      id: teamOwner.personalTeamId,
      displayName: "Point7 team's workspace",
      roleLabel: "ADMIN",
    });

    // (4) Removal withdraws the option and the entry.
    await prisma.teamMember.update({
      where: {
        teamId_userId: { teamId: teamOwner.personalTeamId, userId: member.owner.userId },
      },
      data: { status: "REVOKED" },
    });
    const afterRevoke = await context(freshToken);
    expect(afterRevoke.contextOptions.sharedWorkspaces.map((w) => w.workspaceId)).toEqual([
      proOwner.personalTeamId,
    ]);
    expect(afterRevoke.canonical.sharedWorkspaces.map((w) => w.workspaceId)).toEqual([
      proOwner.personalTeamId,
    ]);
    // The stale pointer heals to the member's OWN Personal Space.
    expect(afterRevoke.activeSpace).toMatchObject({
      type: "PERSONAL",
      id: member.personalTeamId,
      displayName: "Personal Space",
      roleLabel: "Owner",
      shared: false,
    });
    const refused = await switchTo(freshToken, teamOwner.personalTeamId);
    expect(refused.statusCode).toBe(403);

    // The owner of the PRO workspace sees it as their own, never as shared.
    const ownerView = await context(proOwner.owner.token);
    expect(ownerView.contextOptions.sharedWorkspaces).toEqual([]);
    expect(ownerView.canonical.sharedWorkspaces).toEqual([]);
    expect(ownerView.contextOptions.personalSpace?.workspaceId).toBe(proOwner.personalTeamId);
    expect(ownerView.activeSpace).toMatchObject({
      id: proOwner.personalTeamId,
      displayName: "Personal Space",
      roleLabel: "Owner",
      shared: false,
    });
  });

  it("CONTROL — an Organization-workspace member is offered and enters it exactly as before", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const m = org.members[0]!;

    const ctx = await context(m.token);
    expect(ctx.contextOptions.sharedWorkspaces).toEqual([]);
    expect(ctx.canonical.sharedWorkspaces).toEqual([]);
    const group = ctx.contextOptions.organizations.find((g) => g.organizationId === org.organizationId);
    expect(group?.workspaces).toEqual([
      expect.objectContaining({ workspaceId: org.workspaceId, workspaceRole: "MEMBER" }),
    ]);

    const entered = await switchTo(m.token, org.workspaceId);
    expect(entered.statusCode, entered.body).toBe(200);
    const inOrg = entered.json() as Envelope;
    expect(inOrg.activeSpace).toMatchObject({
      type: "ORGANIZATION",
      id: org.workspaceId,
      roleLabel: "MEMBER",
    });
    expect(inOrg.contextOptions.activeContext.kind).toBe("ORGANIZATION");
  });
});
