// Database acquisition: bootIntegrationHarness() (the ONE canonical helper).
/**
 * TEAM-SPEC §0 / R1 (2026-11-23) — the Team journey on a SHARED Personal
 * Workspace, end to end through the real routes against a real PostgreSQL.
 *
 * Team is sold on the subscriber's PERSONAL workspace and members are invited
 * into it. Entitlement comes from the ACTIVE workspace's effective plan (the
 * owner's personal plan for a PERSONAL workspace), never from the invitee's own
 * subscription.
 *
 *   a. A TEAM owner invites a FREE-plan user (MEMBER) and a PRO-plan user
 *      (ADMIN) through POST /v1/teams/:id/invites; both accept through
 *      POST /v1/teams/invites/accept. In the shared workspace both get reviewer
 *      operations per role. Inverse: the FREE invitee in their OWN workspace is
 *      refused ENTITLEMENT_REQUIRED; a TEAM-plan invitee inside a PRO owner's
 *      shared workspace is refused Team review tools.
 *   b. switch-workspace re-authorizes; the envelope's planFeatures follow the
 *      workspace (reviewerOperationsIncluded true) though the account is FREE.
 *   c. Removal: the removed member's queue / assign / switch are refused; a
 *      revoked pending invitation cannot be accepted.
 *   d. Restricted case: a member off the access list neither sees nor acts on
 *      the workflow; an on-list member can.
 *   e. Role change after the page was opened: ADMIN → VIEWER, and the assign
 *      the page offered is refused.
 *
 * Every assertion that matters also reads the persisted rows.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { signJwt } from "../src/services/jwt.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js")["prisma"];
let deps: FixtureDeps;
let stepUp: ReturnType<typeof createStepUpCeremony>;
let hashPassword: typeof import("../src/services/email-password-auth.service.js")["hashPassword"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; email: string; token: string };

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await h.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

const switchTo = (a: Actor, workspaceId: string) =>
  call(a.token, "POST", "/v1/platform/context/switch-workspace", { workspaceId });
const queue = (a: Actor, teamId: string, q = "UNASSIGNED") =>
  call(a.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=${q}&limit=100`);
const assign = (a: Actor, teamId: string, workflowId: string, to: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/assign`, { teamId, assignedToUserId: to });
const start = (a: Actor, teamId: string, workflowId: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/start`, { teamId });
const approve = (a: Actor, teamId: string, workflowId: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId, note: "Looks complete" });
const workspaceView = (a: Actor, teamId: string, workflowId: string) =>
  call(a.token, "GET", `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`);

function expectEntitlementRefusal(res: Res, label: string) {
  expect(res.status, `${label}: ${res.raw}`).toBe(403);
  expect(res.body.error?.code, label).toBe("ENTITLEMENT_REQUIRED");
}

/** Owner invites through the real route; the "delivered" link is a known raw token. */
async function inviteThroughRoute(
  owner: Actor,
  workspaceId: string,
  invitee: Actor,
  role: "ADMIN" | "MEMBER" | "VIEWER",
): Promise<{ inviteId: string; rawToken: string }> {
  const created = await call(owner.token, "POST", `/v1/teams/${workspaceId}/invites`, { email: invitee.email, role });
  expect(created.status, created.raw).toBe(201);
  const inviteId = created.body.invite.id as string;
  expect(created.raw).not.toMatch(/wsit_v1_/);
  // The raw value went only into the email; stand in for the mailbox by
  // rotating the stored hash to a link the test holds.
  const rawToken = `wsit_v1_${randomBytes(32).toString("base64url")}`;
  await prisma.teamInvite.update({
    where: { id: inviteId },
    data: { tokenHash: createHash("sha256").update(rawToken).digest("hex") } as never,
  });
  const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: inviteId } });
  expect(row).toMatchObject({ teamId: workspaceId, role, acceptedAt: null, revokedAt: null });
  return { inviteId, rawToken };
}

const accept = (a: Actor, rawToken: string) => call(a.token, "POST", "/v1/teams/invites/accept", { token: rawToken });

const membership = (teamId: string, userId: string) =>
  prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });

async function workflowIn(
  workspaceId: string,
  ownerUserId: string,
  opts: { restrictedTo?: string[] } = {},
): Promise<{ workflowId: string; evidenceId: string; caseId: string | null }> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: workspaceId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: {
        title: `tj-${randomBytes(4).toString("hex")}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: workspaceId,
        organizationId: t.organizationId,
        ownerUserId,
      } as never,
      select: { id: true },
    })
  ).id;
  let caseId: string | null = null;
  if (opts.restrictedTo) {
    caseId = (
      await prisma.case.create({
        data: { name: `Restricted ${randomBytes(3).toString("hex")}`, teamId: workspaceId, ownerUserId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    for (const userId of opts.restrictedTo) await prisma.caseAccess.create({ data: { caseId, userId } });
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId } });
  }
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: workspaceId, status: "NOT_STARTED", workspaceType: "PERSONAL" },
      select: { id: true },
    })
  ).id;
  return { workflowId, evidenceId, caseId };
}

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const queueIds = (res: Res) => (res.body.rows as Array<{ workflowId: string }>).map((r) => r.workflowId);

// --- fixture ----------------------------------------------------------------
let teamOwner: PersonalTenant; // TEAM plan — the shared workspace
let proOwner: PersonalTenant; // PRO plan — a shared workspace without Team tools
let freeInvitee: PersonalTenant; // own plan FREE, MEMBER in the TEAM workspace
let proInvitee: PersonalTenant; // own plan PRO, ADMIN in the TEAM workspace
let teamInvitee: PersonalTenant; // own plan TEAM, MEMBER in the PRO workspace
let T: string; // the TEAM owner's Personal Workspace id
const owner = () => teamOwner.owner as Actor;
const free = () => freeInvitee.owner as Actor;
const pro = () => proInvitee.owner as Actor;

beforeAll(async () => {
  h = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
  const secret = process.env.AUTH_JWT_SECRET!;
  deps = {
    prisma: prisma as never,
    tag: `tj-${Date.now().toString(36)}`,
    mintToken: (userId, email) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        secret,
        60 * 60,
      ),
  };
  stepUp = createStepUpCeremony({
    prisma: prisma as never,
    inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
  });
  teamOwner = await seedPersonalTenant(deps, "TEAM");
  proOwner = await seedPersonalTenant(deps, "PRO");
  freeInvitee = await seedPersonalTenant(deps, "FREE");
  proInvitee = await seedPersonalTenant(deps, "PRO");
  teamInvitee = await seedPersonalTenant(deps, "TEAM");
  T = teamOwner.personalTeamId;
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

describe("a/b — invitees take the WORKSPACE's entitlement, not their own", () => {
  it("FREE and PRO invitees accept through the real routes; memberships persist with the invited roles", async () => {
    const f = await inviteThroughRoute(owner(), T, free(), "MEMBER");
    const p = await inviteThroughRoute(owner(), T, pro(), "ADMIN");

    const fa = await accept(free(), f.rawToken);
    expect(fa.status, fa.raw).toBe(200);
    expect(fa.body.workspaceId).toBe(T);
    const pa = await accept(pro(), p.rawToken);
    expect(pa.status, pa.raw).toBe(200);

    expect(await membership(T, free().userId)).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    expect(await membership(T, pro().userId)).toMatchObject({ role: "ADMIN", status: "ACTIVE" });
    for (const id of [f.inviteId, p.inviteId]) {
      expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id } })).acceptedAt).not.toBeNull();
    }
    // Their own subscriptions are untouched by joining.
    expect(
      (await prisma.entitlement.findFirstOrThrow({ where: { userId: free().userId, active: true } })).plan,
    ).toBe("FREE");
    expect(
      (await prisma.entitlement.findFirstOrThrow({ where: { userId: pro().userId, active: true } })).plan,
    ).toBe("PRO");

    // The owner organises the workspace (members audit placement rule).
    await placeInCollaborationTeam(prisma, {
      workspaceId: T,
      createdByUserId: owner().userId,
      userIds: [free().userId, pro().userId],
    });
  });

  it("b — switching into the shared TEAM workspace re-authorizes; planFeatures follow the workspace, the account stays FREE", async () => {
    const sw = await switchTo(free(), T);
    expect(sw.status, sw.raw).toBe(200);
    expect(sw.body.activeSpace).toMatchObject({ id: T, shared: true, plan: "TEAM", roleLabel: "MEMBER" });
    expect(sw.body.planFeatures.reviewerOperationsIncluded).toBe(true);
    expect(sw.body.personalSpace).toMatchObject({ id: freeInvitee.personalTeamId, plan: "FREE" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: free().userId } })).currentWorkspaceId).toBe(T);

    // Back in their OWN Personal Space the same person has no reviewer operations.
    const home = await switchTo(free(), freeInvitee.personalTeamId);
    expect(home.status, home.raw).toBe(200);
    expect(home.body.activeSpace).toMatchObject({ id: freeInvitee.personalTeamId, shared: false });
    expect(home.body.planFeatures.reviewerOperationsIncluded).toBe(false);

    // A TEAM-plan account inside a PRO owner's shared workspace sees the PRO projection.
    const tInPro = await prisma.teamMember.create({
      data: { teamId: proOwner.personalTeamId, userId: teamInvitee.owner.userId, role: "MEMBER", status: "ACTIVE" },
    });
    expect(tInPro.status).toBe("ACTIVE");
    const intoPro = await switchTo(teamInvitee.owner as Actor, proOwner.personalTeamId);
    expect(intoPro.status, intoPro.raw).toBe(200);
    expect(intoPro.body.activeSpace).toMatchObject({ id: proOwner.personalTeamId, shared: true, plan: "PRO" });
    expect(intoPro.body.planFeatures.reviewerOperationsIncluded).toBe(false);
    expect(intoPro.body.personalSpace.plan).toBe("TEAM");
  });

  it("a — in the TEAM workspace both invitees get reviewer operations per role; the FREE one's assignment and decision persist", async () => {
    await switchTo(free(), T);
    await switchTo(pro(), T);
    for (const [who, a] of [["free MEMBER", free()], ["pro ADMIN", pro()]] as const) {
      const q = await queue(a, T);
      expect(q.status, `${who}: ${q.raw}`).toBe(200);
      const rw = await call(a.token, "GET", `/v1/reviewer/workspace?teamId=${T}`);
      expect(rw.status, `${who} reviewer workspace: ${rw.raw}`).toBe(200);
    }
    const qc = await call(free().token, "GET", `/v1/reviewer/qc/samples?teamId=${T}`);
    expect(qc.status, `member qc: ${qc.raw}`).toBe(200);

    // The PRO-plan ADMIN assigns (REVIEW_ASSIGNMENTS is TEAM+ — the workspace's plan).
    const { workflowId } = await workflowIn(T, owner().userId);
    expect(queueIds(await queue(free(), T))).toContain(workflowId);
    const assigned = await assign(pro(), T, workflowId, free().userId);
    expect(assigned.status, assigned.raw).toBe(200);
    expect((await wfRow(workflowId)).assignedToUserId).toBe(free().userId);

    // The FREE-plan MEMBER works it: start, then a decision is recorded.
    expect((await start(free(), T, workflowId)).status).toBe(200);
    const decided = await approve(free(), T, workflowId);
    expect(decided.status, decided.raw).toBe(200);
    const decisions = await prisma.workflowReviewDecision.findMany({ where: { workflowId } });
    expect(decisions).toEqual([expect.objectContaining({ reviewerUserId: free().userId })]);
  });

  it("a (inverse) — the FREE invitee in their OWN workspace, and a TEAM account in a PRO workspace, are refused", async () => {
    const own = freeInvitee.personalTeamId;
    await switchTo(free(), own);
    expectEntitlementRefusal(await queue(free(), own), "free own queue");
    expectEntitlementRefusal(await call(free().token, "GET", `/v1/reviewer/workspace?teamId=${own}`), "free own reviewer ws");

    const P = proOwner.personalTeamId;
    const t = teamInvitee.owner as Actor;
    await switchTo(t, P);
    expectEntitlementRefusal(await queue(t, P), "team-account in PRO queue");
    expectEntitlementRefusal(await call(t.token, "GET", `/v1/reviewer/workspace?teamId=${P}`), "team-account in PRO reviewer ws");
    expectEntitlementRefusal(await call(t.token, "GET", `/v1/reviewer/qc/samples?teamId=${P}`), "team-account in PRO qc");
    // Its own TEAM Personal Space still serves it (the plan was never the person's to carry).
    await switchTo(t, teamInvitee.personalTeamId);
    expect((await queue(t, teamInvitee.personalTeamId)).status).toBe(200);
  });
});

describe("d — restricted case reach inside the shared workspace", () => {
  it("an off-list ADMIN neither lists nor opens nor assigns; the on-list MEMBER is served", async () => {
    await switchTo(free(), T);
    await switchTo(pro(), T);
    const { workflowId } = await workflowIn(T, owner().userId, { restrictedTo: [owner().userId, free().userId] });

    // Off-list ADMIN (holds review.assign): not listed, not openable, cannot act.
    expect(queueIds(await queue(pro(), T))).not.toContain(workflowId);
    const offView = await workspaceView(pro(), T, workflowId);
    expect(offView.status, offView.raw).toBe(404);
    const offAssign = await assign(pro(), T, workflowId, free().userId);
    expect(offAssign.status, offAssign.raw).toBe(404);
    // Nor can the off-list ADMIN be handed it.
    const toOff = await assign(owner(), T, workflowId, pro().userId);
    expect(toOff.status, toOff.raw).toBe(422);
    expect(toOff.body.error.details.reason).toBe("assignee_not_eligible");
    expect((await wfRow(workflowId)).assignedToUserId).toBeNull();

    // On-list MEMBER: listed, assigned by the owner, opens and works it.
    expect(queueIds(await queue(free(), T))).toContain(workflowId);
    expect((await assign(owner(), T, workflowId, free().userId)).status).toBe(200);
    const onView = await workspaceView(free(), T, workflowId);
    expect(onView.status, onView.raw).toBe(200);
    expect(onView.body.viewer).toMatchObject({ userId: free().userId, isAssignee: true });
    expect((await start(free(), T, workflowId)).status).toBe(200);

    // The off-list ADMIN still cannot decide it.
    const offDecide = await approve(pro(), T, workflowId);
    expect(offDecide.status, offDecide.raw).toBe(404);
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId } })).toBe(0);
    expect((await wfRow(workflowId)).assignedToUserId).toBe(free().userId);
  });
});

describe("e — role change after the page was opened", () => {
  it("ADMIN → VIEWER: the assign the page offered is refused and nothing changes", async () => {
    const admin2Tenant = await seedPersonalTenant(deps, "FREE");
    const admin2 = admin2Tenant.owner as Actor;
    const inv = await inviteThroughRoute(owner(), T, admin2, "ADMIN");
    expect((await accept(admin2, inv.rawToken)).status).toBe(200);
    await placeInCollaborationTeam(prisma, { workspaceId: T, createdByUserId: owner().userId, userIds: [admin2.userId] });
    await switchTo(admin2, T);

    const { workflowId } = await workflowIn(T, owner().userId);
    const opened = await workspaceView(admin2, T, workflowId);
    expect(opened.status, opened.raw).toBe(200);
    expect((opened.body.viewer.actions as Array<{ action: string; allowed: boolean }>).find((a) => a.action === "reassign")?.allowed).toBe(true);

    const m = (await membership(T, admin2.userId))!;
    const demoted = await call(
      owner().token,
      "PATCH",
      `/v1/teams/${T}/members/${m.id}`,
      { role: "VIEWER" },
      await stepUp.approvedHeader({
        token: owner().token,
        userId: owner().userId,
        teamId: T,
        purpose: "MEMBER_ROLE_CHANGE",
        resourceKind: "team_member",
        resourceId: m.id,
      }),
    );
    expect(demoted.status, demoted.raw).toBe(200);
    expect((await membership(T, admin2.userId))!.role).toBe("VIEWER");

    // The stale page's assign is refused on the server.
    const stale = await assign(admin2, T, workflowId, free().userId);
    expect(stale.status, stale.raw).toBe(403);
    expect((await wfRow(workflowId)).assignedToUserId).toBeNull();
    // And the re-read view no longer offers it.
    const reread = await workspaceView(admin2, T, workflowId);
    if (reread.status === 200) {
      expect((reread.body.viewer.actions as Array<{ action: string; allowed: boolean }>).find((a) => a.action === "reassign")?.allowed).toBe(false);
    } else {
      expect(reread.status).toBe(403);
    }
  });
});

describe("c — removal and a revoked pending invitation", () => {
  it("a removed ADMIN's queue, assign and switch are refused; the membership persists as REVOKED", async () => {
    const { workflowId } = await workflowIn(T, owner().userId);
    const m = (await membership(T, pro().userId))!;
    const removed = await call(
      owner().token,
      "DELETE",
      `/v1/teams/${T}/members/${m.id}`,
      undefined,
      await stepUp.approvedHeader({
        token: owner().token,
        userId: owner().userId,
        teamId: T,
        purpose: "MEMBER_REVOKE",
        resourceKind: "team_member",
        resourceId: m.id,
      }),
    );
    expect(removed.status, removed.raw).toBe(204);
    expect((await membership(T, pro().userId))!.status).toBe("REVOKED");

    const q = await queue(pro(), T);
    expect(q.status, q.raw).toBe(403);
    expect(q.body.error).toMatchObject({ code: "REVIEW_ACTOR_BLOCKED", reason: "member_inactive" });
    const a = await assign(pro(), T, workflowId, free().userId);
    expect(a.status, a.raw).toBe(403);
    expect((await wfRow(workflowId)).assignedToUserId).toBeNull();
    const rw = await call(pro().token, "GET", `/v1/reviewer/workspace?teamId=${T}`);
    expect(rw.status, rw.raw).toBe(403);
    const sw = await switchTo(pro(), T);
    expect(sw.status, sw.raw).toBe(403);
    // The removed person no longer counts as an assignee either.
    const toRemoved = await assign(owner(), T, workflowId, pro().userId);
    expect(toRemoved.status, toRemoved.raw).toBe(422);
    expect((await wfRow(workflowId)).assignedToUserId).toBeNull();
  });

  it("a pending invitation revoked through the route cannot be accepted; nothing is provisioned", async () => {
    const latecomer = (await seedPersonalTenant(deps, "FREE")).owner as Actor;
    const inv = await inviteThroughRoute(owner(), T, latecomer, "MEMBER");
    const revoked = await call(owner().token, "DELETE", `/v1/teams/${T}/invites/${inv.inviteId}`);
    expect(revoked.status, revoked.raw).toBe(200);
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: inv.inviteId } })).revokedAt).not.toBeNull();

    const refused = await accept(latecomer, inv.rawToken);
    expect(refused.status, refused.raw).toBe(404);
    expect(["INVITE_REVOKED", "INVITE_NOT_FOUND"]).toContain(refused.body.error?.code ?? refused.body.code);
    expect(await membership(T, latecomer.userId)).toBeNull();
    expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id: inv.inviteId } })).acceptedAt).toBeNull();
    expect((await switchTo(latecomer, T)).status).toBe(403);
  });
});

describe("ownership transfer — a shared PERSONAL workspace never changes owners", () => {
  it("the TEAM owner's offer to an ACTIVE member is refused 409; owner and offers unchanged", async () => {
    const password = `Tj-${randomBytes(12).toString("hex")}`;
    await prisma.user.update({ where: { id: owner().userId }, data: { passwordHash: await hashPassword(password) } });
    expect((await membership(T, free().userId))!.status).toBe("ACTIVE");

    const res = await call(owner().token, "POST", `/v1/teams/${T}/transfer-ownership`, {
      newOwnerUserId: free().userId,
      stepUp: { method: "password", currentPassword: password },
    });
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error.code).toBe("personal_workspace_not_transferable");
    const team = await prisma.team.findUniqueOrThrow({ where: { id: T }, select: { ownerUserId: true, isPersonal: true } });
    expect(team).toEqual({ ownerUserId: owner().userId, isPersonal: true });
    expect(await prisma.workspaceOwnershipOffer.count({ where: { teamId: T } })).toBe(0);
  });
});
