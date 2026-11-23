/**
 * TEAM-SPEC R4 / §2.11 (2026-11-23) — External Review issue and revoke answer
 * ONE predicate on every door (OWNER/ADMIN ∧ review.assign ∧
 * governance.legal_hold.manage, the intersection of the former gates), the
 * list routes project it as `viewerCanIssue` / `viewerCanRevoke`, Pro and Team
 * PERSONAL workspaces are served, and a request naming a workspace other than
 * the active one is refused clearly. Real PostgreSQL, real routes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import { signJwt } from "../src/services/jwt.js";
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let stepUp: ReturnType<typeof createStepUpCeremony>;
let A: TeamFixture;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };

const tag = () => randomUUID().slice(0, 8);
const P = () => h.fixtures.personal;

async function call(
  token: string,
  method: "GET" | "POST",
  url: string,
  opts: { payload?: unknown; workspaceId?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const res = await h.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.workspaceId ? { "x-proovra-workspace-id": opts.workspaceId } : {}),
      ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    payload: opts.payload !== undefined ? JSON.stringify(opts.payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

async function setPersonalPlan(plan: "FREE" | "PRO" | "TEAM") {
  await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
  await prisma.entitlement.create({ data: { userId: P().userId, plan, active: true, credits: 0 } });
}

async function person(workspaceId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
  const email = `team-xr-${tag()}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "Team", lastName: "External", provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  await prisma.teamMember.create({ data: { teamId: workspaceId, userId: user.id, role, status: "ACTIVE" } });
  const token = signJwt(
    { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
    process.env.AUTH_JWT_SECRET as string,
    3600,
  );
  return { id: user.id, token };
}

const issueBody = (extra: Record<string, unknown> = {}) => ({
  expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  defaultScope: { kind: "EVIDENCE", evidenceId: P().evidenceId },
  rows: [{ inviteEmail: `xr-${tag()}@test.proovra.local` }],
  ...extra,
});

async function ownerIssues(): Promise<Res> {
  const header = await stepUp.approvedHeader({
    token: P().token,
    userId: P().userId,
    teamId: P().teamId,
    purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
    resourceKind: "external_review_grant_bulk",
  });
  return call(P().token, "POST", "/v1/external-review/invitations/bulk", {
    payload: issueBody(),
    workspaceId: P().teamId,
    headers: header,
  });
}

let admin: { id: string; token: string };
let member: { id: string; token: string };
let viewer: { id: string; token: string };

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  A = h.fixtures.teamA;
  stepUp = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
  await setPersonalPlan("TEAM");
  admin = await person(P().teamId, "ADMIN");
  member = await person(P().teamId, "MEMBER");
  viewer = await person(P().teamId, "VIEWER");
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

describe("R4 — one issue/revoke predicate, projected for the viewer", () => {
  it("MEMBER and VIEWER: viewerCanIssue false, and a direct issue POST is refused on both doors", async () => {
    await setPersonalPlan("TEAM");
    const memberList = await call(member.token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect(memberList.status, memberList.raw).toBe(200);
    expect(memberList.body.viewerCanIssue).toBe(false);
    const memberGrants = await call(member.token, "GET", `/v1/external-review/grants?teamId=${P().teamId}`, {
      workspaceId: P().teamId,
    });
    if (memberGrants.status === 200) expect(memberGrants.body.viewerCanIssue).toBe(false);

    const memberBulk = await call(member.token, "POST", "/v1/external-review/invitations/bulk", {
      payload: issueBody(),
      workspaceId: P().teamId,
    });
    // Refused by the door permission (a MEMBER holds no review.assign here)
    // or by the predicate (NOT_PERMITTED) — never served.
    expect(memberBulk.status, memberBulk.raw).toBe(403);
    const memberSingle = await call(member.token, "POST", "/v1/external-review/grants", {
      payload: { teamId: P().teamId, scopeKind: "EVIDENCE", evidenceId: P().evidenceId, reviewerEmail: `m-${tag()}@test.proovra.local` },
    });
    expect(memberSingle.status, memberSingle.raw).toBe(403);

    const viewerBulk = await call(viewer.token, "POST", "/v1/external-review/invitations/bulk", {
      payload: issueBody(),
      workspaceId: P().teamId,
    });
    expect(viewerBulk.status, viewerBulk.raw).toBe(403);
    const viewerGrants = await call(viewer.token, "GET", `/v1/external-review/grants?teamId=${P().teamId}`, {
      workspaceId: P().teamId,
    });
    if (viewerGrants.status === 200) expect(viewerGrants.body.viewerCanIssue).toBe(false);
    expect(await prisma.externalReviewGrant.count({ where: { teamId: P().teamId, invitedByUserId: { in: [member.id, viewer.id] } } })).toBe(0);
  });

  it("OWNER on a TEAM personal workspace: viewerCanIssue true, issue succeeds, revoke offered and accepted; MEMBER revoke refused", async () => {
    await setPersonalPlan("TEAM");
    const before = await call(P().token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect(before.status, before.raw).toBe(200);
    expect(before.body.viewerCanIssue).toBe(true);
    const adminList = await call(admin.token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect(adminList.body.viewerCanIssue).toBe(true);

    const issued = await ownerIssues();
    expect(issued.status, issued.raw).toBe(201);
    const grantId = issued.body.rows[0].grantId as string;
    expect(issued.body.rows[0].outcome).toBe("INVITED");

    const ownerGrants = await call(P().token, "GET", `/v1/external-review/grants?teamId=${P().teamId}`, { workspaceId: P().teamId });
    expect(ownerGrants.status, ownerGrants.raw).toBe(200);
    expect(ownerGrants.body.viewerCanIssue).toBe(true);
    expect(ownerGrants.body.viewerActions).toEqual({ workspaceId: P().teamId, sameWorkspace: true });
    const row = (ownerGrants.body.grants as Array<{ id: string }>).find((g) => g.id === grantId);
    expect(row).toMatchObject({ viewerCanRevoke: true });

    const memberRows = await call(member.token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    const memberRow = (memberRows.body.invitations as Array<{ grantId: string }>).find((r) => r.grantId === grantId);
    expect(memberRow).toMatchObject({ viewerCanRevoke: false });
    const memberRevoke = await call(member.token, "POST", `/v1/external-review/invitations/${grantId}/revoke`, {
      workspaceId: P().teamId,
    });
    expect(memberRevoke.status, memberRevoke.raw).toBe(403);

    const revoked = await call(P().token, "POST", `/v1/external-review/invitations/${grantId}/revoke`, { workspaceId: P().teamId });
    expect(revoked.status, revoked.raw).toBe(200);
    const after = await call(P().token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect((after.body.invitations as Array<{ grantId: string }>).find((r) => r.grantId === grantId)).toMatchObject({
      viewerCanRevoke: false,
    });
  });

  it("OWNER on a PRO personal workspace issues too; on FREE issue is not offered but revoke still is", async () => {
    await setPersonalPlan("PRO");
    const proList = await call(P().token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect(proList.body.viewerCanIssue).toBe(true);
    const issued = await ownerIssues();
    expect(issued.status, issued.raw).toBe(201);
    const grantId = issued.body.rows[0].grantId as string;

    await setPersonalPlan("FREE");
    const freeList = await call(P().token, "GET", "/v1/external-review/invitations", { workspaceId: P().teamId });
    expect(freeList.status, freeList.raw).toBe(200);
    expect(freeList.body.viewerCanIssue).toBe(false);
    expect((freeList.body.invitations as Array<{ grantId: string }>).find((r) => r.grantId === grantId)).toMatchObject({
      viewerCanRevoke: true,
    });
    await setPersonalPlan("TEAM");
  });

  it("a request naming another workspace than the active one is refused clearly; a list for it offers nothing", async () => {
    await setPersonalPlan("TEAM");
    const mismatch = await call(P().token, "POST", "/v1/external-review/invitations/bulk", {
      payload: issueBody({ teamId: A.teamId }),
      workspaceId: P().teamId,
    });
    expect(mismatch.status, mismatch.raw).toBe(409);
    expect(mismatch.body.error.code).toBe("EXTERNAL_REVIEW_WORKSPACE_MISMATCH");

    // The personal owner is also an ADMIN of organization A; with A active, the
    // personal list offers no issue/revoke (they would land in A).
    await prisma.teamMember.create({ data: { teamId: A.teamId, userId: P().userId, role: "ADMIN", status: "ACTIVE" } });
    try {
      const cross = await call(P().token, "GET", `/v1/external-review/grants?teamId=${P().teamId}`, { workspaceId: A.teamId });
      expect(cross.status, cross.raw).toBe(200);
      expect(cross.body.viewerCanIssue).toBe(false);
      expect(cross.body.viewerActions).toEqual({ workspaceId: A.teamId, sameWorkspace: false });
      for (const g of cross.body.grants as Array<{ viewerCanRevoke: boolean }>) expect(g.viewerCanRevoke).toBe(false);
    } finally {
      await prisma.teamMember.deleteMany({ where: { teamId: A.teamId, userId: P().userId } });
    }
  });

  it("ending an invitation's portal sessions answers the same predicate: MEMBER/VIEWER refused, OWNER/ADMIN served, mismatch refused", async () => {
    await setPersonalPlan("TEAM");
    const issued = await ownerIssues();
    expect(issued.status, issued.raw).toBe(201);
    const grantId = issued.body.rows[0].grantId as string;
    const url = `/v1/external-review/invitations/${grantId}/sessions/revoke`;

    for (const who of [member, viewer]) {
      const refused = await call(who.token, "POST", url, { payload: {}, workspaceId: P().teamId });
      expect(refused.status, refused.raw).toBe(403);
    }
    const mismatch = await call(P().token, "POST", url, { payload: { teamId: A.teamId }, workspaceId: P().teamId });
    expect(mismatch.status, mismatch.raw).toBe(409);
    expect(mismatch.body.error.code).toBe("EXTERNAL_REVIEW_WORKSPACE_MISMATCH");

    const byAdmin = await call(admin.token, "POST", url, { payload: {}, workspaceId: P().teamId });
    expect(byAdmin.status, byAdmin.raw).toBe(200);
    const byOwner = await call(P().token, "POST", url, { payload: {}, workspaceId: P().teamId });
    expect(byOwner.status, byOwner.raw).toBe(200);
    expect(byOwner.body).toMatchObject({ ok: true, sessionsEnded: 0 });
  });
});
