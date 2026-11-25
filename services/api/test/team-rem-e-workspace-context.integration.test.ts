/**
 * TEAM REMEDIATION — STAGE E, workspace context, typed refusals, placement and
 * labels (T-097, T-098, T-116, T-117, T-118, T-119, T-120, T-123).
 *
 * Real routes on a TEAM-plan Personal Workspace, plus an Enterprise
 * organization workspace (contract-backed) where the rule differs:
 *
 *   - T-097: the reviewer picker projects placement (`placed:false` + reason)
 *     with the rule the writers enforce; an Enterprise contract that does not
 *     require placement lists the same person as placed.
 *   - T-098: claim refused for placement answers the canonical code.
 *   - T-118: case create names its workspace (body, else header); neither →
 *     400; header and body disagreeing → 409 (case, evidence, collaboration).
 *   - T-123: a non-member workspace on create → 404, as reads answer it.
 *   - T-119 / T-120: a MEMBER who can read a record (even their own) is told
 *     403 with the permission they lack on archive / trash; VIEWER label too;
 *     a non-reader still gets the anti-enumeration 404.
 *   - T-116: persona of a Team owner is not INDIVIDUAL; a FREE owner's is.
 *   - T-117: the default workspace name never embeds the e-mail; an invitation
 *     never presents a legacy e-mail name.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

let T: { teamId: string; owner: Actor };
let E: TeamFixture;

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await harness.app.inject({
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

let seq = 0;
async function newUser(label: string, names: { firstName?: string | null; lastName?: string | null } = {}): Promise<Actor> {
  seq += 1;
  const email = `tremctx-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: {
      email,
      firstName: names.firstName === undefined ? "Ctx" : names.firstName,
      lastName: names.lastName === undefined ? label : names.lastName,
      provider: "EMAIL",
      providerUserId: email,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

async function member(teamId: string, ownerUserId: string, role: "ADMIN" | "MEMBER" | "VIEWER", label: string, placed = true) {
  const a = await newUser(label);
  await prisma.teamMember.create({ data: { teamId, userId: a.userId, role, status: "ACTIVE" } });
  if (placed) await placeInCollaborationTeam(prisma, { workspaceId: teamId, createdByUserId: ownerUserId, userIds: [a.userId] });
  return a;
}

async function teamOwner(label: string, plan: "FREE" | "TEAM") {
  const owner = await newUser(label);
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan, active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan } });
  await prisma.user.update({ where: { id: owner.userId }, data: { currentWorkspaceId: space.teamId } });
  return { owner, teamId: space.teamId };
}

async function evidenceIn(teamId: string, ownerUserId: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `tremctx ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: t.organizationId, ownerUserId } as never,
      select: { id: true },
    })
  ).id;
  return evidenceId;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  T = await teamOwner("owner", "TEAM");
  E = harness.fixtures.teamA;
  await makeEnterpriseOrganizationWorkspace(prisma, E.teamId);
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

describe("T-097 / T-098 — the placement prerequisite is visible before a refusal", () => {
  it("the picker marks an unplaced member not assignable; the claim refusal uses the canonical code", async () => {
    const H = { "x-proovra-workspace-id": T.teamId };
    const placed = await member(T.teamId, T.owner.userId, "MEMBER", "placed", true);
    const unplaced = await member(T.teamId, T.owner.userId, "MEMBER", "unplaced", false);
    const res = await call(T.owner.token, "GET", `/v1/reviewer-ops/assignable-reviewers?teamId=${T.teamId}&limit=200`, undefined, H);
    expect(res.status, res.raw).toBe(200);
    const byId = new Map((res.body.reviewers as Array<{ userId: string; placed: boolean; notAssignableReason: string | null }>).map((r) => [r.userId, r]));
    expect(byId.get(placed.userId)).toMatchObject({ placed: true, notAssignableReason: null });
    expect(byId.get(unplaced.userId)).toMatchObject({ placed: false, notAssignableReason: "REVIEW_ASSIGNEE_NOT_PLACED" });
    expect(byId.get(T.owner.userId)).toMatchObject({ placed: true });

    const evidenceId = await evidenceIn(T.teamId, T.owner.userId);
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: T.teamId, status: "QUEUED", workspaceType: "TEAM" } as never,
    });
    const claim = await call(unplaced.token, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId: T.teamId }, H);
    expect(claim.status, claim.raw).toBe(422);
    expect(claim.body.error.code).toBe("REVIEW_ASSIGNEE_NOT_PLACED");
    expect(claim.body.error.details.reason).toBe("assignee_not_placed");
  });

  it("Enterprise: a contract that does not require placement lists an unplaced member as placed", async () => {
    const unplaced = await member(E.teamId, E.ownerUserId, "MEMBER", "ent-unplaced", false);
    const res = await call(E.ownerToken, "GET", `/v1/reviewer-ops/assignable-reviewers?teamId=${E.teamId}&limit=200`, undefined, {
      "x-proovra-workspace-id": E.teamId,
    });
    expect(res.status, res.raw).toBe(200);
    const row = (res.body.reviewers as Array<{ userId: string; placed: boolean }>).find((r) => r.userId === unplaced.userId);
    expect(row).toMatchObject({ placed: true, notAssignableReason: null });
  });
});

describe("T-118 / T-123 — one workspace rule for creates", () => {
  it("case create: neither header nor teamId → 400; disagreement → 409; header names the workspace; non-member → 404", async () => {
    const m = await member(T.teamId, T.owner.userId, "MEMBER", "creator");
    const name = () => `tremctx case ${randomUUID().slice(0, 6)}`;

    const headerless = await call(m.token, "POST", "/v1/cases", { name: name() });
    expect(headerless.status, headerless.raw).toBe(400);
    expect(headerless.body.code).toBe("WORKSPACE_REQUIRED");

    const mine = await teamOwner("other-owner", "TEAM");
    const mismatch = await call(mine.owner.token, "POST", "/v1/cases", { name: name(), teamId: T.teamId }, { "x-proovra-workspace-id": mine.teamId });
    expect(mismatch.status, mismatch.raw).toBe(409);
    expect(mismatch.body.code).toBe("WORKSPACE_CONTEXT_MISMATCH");

    const viaHeader = await call(m.token, "POST", "/v1/cases", { name: name() }, { "x-proovra-workspace-id": T.teamId });
    expect(viaHeader.status, viaHeader.raw).toBe(201);
    const createdId = (viaHeader.body?.case?.id ?? viaHeader.body?.id) as string;
    expect((await prisma.case.findUniqueOrThrow({ where: { id: createdId } })).teamId).toBe(T.teamId);

    // T-123 — a workspace the caller is not a member of is a missing one.
    const foreign = await call(mine.owner.token, "POST", "/v1/cases", { name: name(), teamId: T.teamId });
    const missing = await call(mine.owner.token, "POST", "/v1/cases", { name: name(), teamId: randomUUID() });
    expect(foreign.status, foreign.raw).toBe(404);
    expect(missing.status, missing.raw).toBe(404);
    expect(foreign.body.code).toBe(missing.body.code);
  });

  it("evidence create: the header names the workspace; disagreement → 409; non-member → 404", async () => {
    const m = await member(T.teamId, T.owner.userId, "MEMBER", "capturer");
    const created = await call(m.token, "POST", "/v1/evidence", { type: "PHOTO", mimeType: "image/jpeg" }, { "x-proovra-workspace-id": T.teamId });
    expect(created.status, created.raw).toBe(201);
    const id = (created.body?.id ?? created.body?.evidence?.id) as string;
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).teamId).toBe(T.teamId);

    const own = await teamOwner("ev-owner", "TEAM");
    const mismatch = await call(own.owner.token, "POST", "/v1/evidence", { type: "PHOTO", mimeType: "image/jpeg", teamId: T.teamId }, { "x-proovra-workspace-id": own.teamId });
    expect(mismatch.status, mismatch.raw).toBe(409);
    const foreign = await call(own.owner.token, "POST", "/v1/evidence", { type: "PHOTO", mimeType: "image/jpeg", teamId: T.teamId });
    expect(foreign.status, foreign.raw).toBe(404);
  });

  it("collaboration routes refuse a header and ?workspaceId that disagree", async () => {
    const own = await teamOwner("collab-owner", "TEAM");
    const res = await call(own.owner.token, "GET", `/v1/collaboration-teams?workspaceId=${T.teamId}`, undefined, {
      "x-proovra-workspace-id": own.teamId,
    });
    expect(res.status, res.raw).toBe(409);
    const ok = await call(own.owner.token, "GET", `/v1/collaboration-teams?workspaceId=${own.teamId}`, undefined, {
      "x-proovra-workspace-id": own.teamId,
    });
    expect(ok.status, ok.raw).toBe(200);
  });
});

describe("T-119 / T-120 — a readable record answers 403 with the permission, not 404", () => {
  it("MEMBER trash / archive of their own record → 403 permission_denied; outsider → 404; VIEWER label → 403", async () => {
    const H = { "x-proovra-workspace-id": T.teamId };
    const m = await member(T.teamId, T.owner.userId, "MEMBER", "trasher");
    const v = await member(T.teamId, T.owner.userId, "VIEWER", "labeller");
    const own = await evidenceIn(T.teamId, m.userId);
    expect((await call(m.token, "GET", `/v1/evidence/${own}`, undefined, H)).status).toBe(200);

    const trash = await call(m.token, "DELETE", `/v1/evidence/${own}`, undefined, H);
    expect(trash.status, trash.raw).toBe(403);
    expect(trash.body.code).toBe("permission_denied");
    expect(trash.body.error).toMatchObject({ code: "permission_denied", details: { reason: "evidence.delete" } });
    const archive = await call(m.token, "POST", `/v1/evidence/${own}/archive`, {}, H);
    expect(archive.status, archive.raw).toBe(403);
    expect(archive.body.error.details.reason).toBe("evidence.archive");
    // Permission unchanged (T-120): nothing moved.
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: own } })).deletedAt).toBeNull();

    const label = await call(v.token, "PATCH", `/v1/evidence/${own}/label`, { label: "x" }, H);
    expect(label.status, label.raw).toBe(403);
    expect(label.body.error.code).toBe("permission_denied");

    const outsider = await teamOwner("outsider", "TEAM");
    const probe = await call(outsider.owner.token, "DELETE", `/v1/evidence/${own}`);
    expect(probe.status, probe.raw).toBe(404);
    expect(probe.body).toEqual({ error: { code: "not_found" } });
  });
});

describe("T-116 / T-117 — persona and workspace name", () => {
  it("a Team owner's persona is not INDIVIDUAL; a FREE owner's is", async () => {
    const team = await call(T.owner.token, "GET", "/v1/platform/context", undefined, { "x-proovra-workspace-id": T.teamId });
    expect(team.status, team.raw).toBe(200);
    expect(team.body.persona.resolvedPersona).toBe("WORKSPACE_OWNER");
    const free = await teamOwner("free", "FREE");
    const res = await call(free.owner.token, "GET", "/v1/platform/context", undefined, { "x-proovra-workspace-id": free.teamId });
    expect(res.body.persona.resolvedPersona).toBe("INDIVIDUAL");
  });

  it("the default name never embeds the e-mail; an invitation never presents a legacy e-mail name", async () => {
    const nameless = await newUser("nameless", { firstName: null, lastName: null });
    const space = await ensurePersonalWorkspace({ userId: nameless.userId });
    expect(space.name).not.toContain("@");
    expect(space.name).toBe("Personal workspace");
    const named = await newUser("named", { firstName: "Ada", lastName: "Lovelace" });
    expect((await ensurePersonalWorkspace({ userId: named.userId })).name).toBe("Ada Lovelace's personal workspace");

    // A workspace named before T-117 keeps its stored name, but an invitee never sees the e-mail.
    const legacy = await teamOwner("legacy", "TEAM");
    await prisma.team.update({ where: { id: legacy.teamId }, data: { name: "legacy.owner@example.com's personal workspace" } });
    const raw = `tremctx-${randomUUID()}`;
    await prisma.teamInvite.create({
      data: {
        teamId: legacy.teamId,
        email: `tremctx-invitee-${randomUUID().slice(0, 6)}@test.proovra.local`,
        role: "MEMBER",
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        invitedByUserId: legacy.owner.userId,
        expiresAt: new Date(Date.now() + 3 * 24 * 3600_000),
      },
    });
    const lookup = await call(legacy.owner.token, "POST", "/v1/teams/invites/lookup", { token: raw });
    expect(lookup.status, lookup.raw).toBe(200);
    expect(JSON.stringify(lookup.body)).not.toContain("legacy.owner@example.com");
  });
});
