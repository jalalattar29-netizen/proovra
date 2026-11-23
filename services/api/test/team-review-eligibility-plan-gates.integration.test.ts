/**
 * TEAM-SPEC R1 / R2 / §2.1 / §2.8 / §2.10 (2026-11-23) — Team review tools in
 * the ACTIVE workspace whose EFFECTIVE plan is Team or above, whatever its
 * stored kind, against a real PostgreSQL and the real routes.
 *
 *   - /v1/reviewer/* and /v1/coding/* no longer refuse every PERSONAL
 *     workspace; every read and write needs REVIEW_TASKS_AND_QUEUES.
 *   - A Team Personal Workspace owner reads QC / coding / disagreements /
 *     metrics; writes follow the role (VIEWER refused, MEMBER refused admin
 *     writes, OWNER allowed).
 *   - PRO and FREE personal workspaces are refused ENTITLEMENT_REQUIRED on
 *     READS (they gain nothing); an ENTERPRISE organization is served; a
 *     contract exclusion is honoured.
 *   - A non-member, and a member naming another workspace, are refused
 *     before any plan is disclosed.
 *   - A mixed bulk-assign selection answers per item with distinct reasons
 *     and leaves one tenant-audit row per item; bind-schema leaves one.
 *   - Reviewer performance with zero completions answers null, never 1/100.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";
import { signJwt } from "../src/services/jwt.js";
import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let A: TeamFixture;
let B: TeamFixture;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await h.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
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

const tag = () => randomUUID().slice(0, 8);
const P = () => h.fixtures.personal;

/** PRO and TEAM are sold on a Personal Workspace: its plan is the owner's entitlement. */
async function setPersonalPlan(plan: "FREE" | "PRO" | "TEAM") {
  await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
  await prisma.entitlement.create({ data: { userId: P().userId, plan, active: true, credits: 0 } });
}

async function person(workspaceId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
  const email = `team-elig-${tag()}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "Team", lastName: "Eligibility", provider: "EMAIL", providerUserId: email },
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

async function personalWorkflow(status = "NOT_STARTED", opts: { assignedTo?: string; restrictedTo?: string[] } = {}) {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: P().teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: {
        title: `Personal review ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: P().teamId,
        organizationId: team.organizationId,
        ownerUserId: P().userId,
      } as never,
      select: { id: true },
    })
  ).id;
  if (opts.restrictedTo) {
    const c = await prisma.case.create({
      data: { name: `Restricted ${tag()}`, teamId: P().teamId, ownerUserId: P().userId, restrictedAtUtc: new Date() } as never,
      select: { id: true },
    });
    for (const userId of opts.restrictedTo) await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
    await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId } });
  }
  return (
    await prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId,
        teamId: P().teamId,
        status: status as never,
        workspaceType: "PERSONAL",
        ...(opts.assignedTo ? { assignedToUserId: opts.assignedTo, assignedAtUtc: new Date() } : {}),
      },
      select: { id: true },
    })
  ).id;
}

async function orgWorkflow(team: TeamFixture): Promise<string> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `Org review ${tag()}`, type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: t.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    })
  ).id;
  return (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: team.teamId, status: "NOT_STARTED", workspaceType: "TEAM" },
      select: { id: true },
    })
  ).id;
}

const READS = (teamId: string, workflowId: string) => [
  `/v1/reviewer/workspace?teamId=${teamId}`,
  `/v1/reviewer/metrics?teamId=${teamId}`,
  `/v1/coding/schemas?teamId=${teamId}`,
  `/v1/reviewer/disagreements?teamId=${teamId}`,
  `/v1/reviewer/qc/samples?teamId=${teamId}`,
  `/v1/reviewer/work/${workflowId}/coding?teamId=${teamId}`,
];

function expectEntitlementRefusal(res: Res, label: string) {
  expect(res.status, `${label}: ${res.raw}`).toBe(403);
  expect(res.body.error, label).toMatchObject({ code: "ENTITLEMENT_REQUIRED", entitlement: "REVIEW_TASKS_AND_QUEUES" });
  expect(res.body.denial, label).toBe("ENTITLEMENT_REQUIRED");
}

const auditRows = (action: string, resourceId: string) =>
  prisma.adminAuditLog.findMany({ where: { action, resourceId }, orderBy: { createdAt: "asc" } });

let admin: { id: string; token: string };
let member: { id: string; token: string };
let viewer: { id: string; token: string };

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  A = h.fixtures.teamA;
  B = h.fixtures.teamB;
  await setPersonalPlan("TEAM");
  admin = await person(P().teamId, "ADMIN");
  member = await person(P().teamId, "MEMBER");
  viewer = await person(P().teamId, "VIEWER");
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

describe("R1/R2 — Team Personal Workspace is served; the kind is not the question", () => {
  it("the TEAM personal owner reads QC, coding, disagreements, metrics and the workspace (200)", async () => {
    await setPersonalPlan("TEAM");
    const wf = await personalWorkflow();
    for (const url of READS(P().teamId, wf)) {
      const res = await call(P().token, "GET", url);
      expect(res.status, `${url}: ${res.raw}`).toBe(200);
    }
    // The workspace kind is never relabelled.
    expect((await prisma.team.findUniqueOrThrow({ where: { id: P().teamId }, select: { isPersonal: true } })).isPersonal).toBe(true);
  });

  it("writes follow the role: OWNER seeds and binds (audited), MEMBER cannot bind, VIEWER cannot write", async () => {
    await setPersonalPlan("TEAM");
    const seeded = await call(P().token, "POST", `/v1/coding/schemas/seed-defaults?teamId=${P().teamId}`);
    expect(seeded.status, seeded.raw).toBe(200);
    const schemas = await call(P().token, "GET", `/v1/coding/schemas?teamId=${P().teamId}&status=PUBLISHED`);
    expect(schemas.status, schemas.raw).toBe(200);
    const schemaId = schemas.body.schemas[0]?.id as string;
    expect(schemaId).toBeTruthy();

    const wf = await personalWorkflow();
    const bound = await call(P().token, "POST", `/v1/reviewer/work/${wf}/bind-schema?teamId=${P().teamId}`, { schemaId });
    expect(bound.status, bound.raw).toBe(200);
    // §2.10 — bind-schema leaves a tenant audit row.
    expect(await auditRows("reviewer.coding_schema.bound", wf)).toEqual([
      expect.objectContaining({ userId: P().userId, workspaceId: P().teamId, outcome: "success" }),
    ]);

    const memberBind = await call(member.token, "POST", `/v1/reviewer/work/${wf}/bind-schema?teamId=${P().teamId}`, { schemaId });
    expect(memberBind.status, memberBind.raw).toBe(403);
    expect(memberBind.body).toMatchObject({ denial: "NOT_PERMITTED" });

    const viewerSeed = await call(viewer.token, "POST", `/v1/coding/schemas/seed-defaults?teamId=${P().teamId}`);
    expect(viewerSeed.status, viewerSeed.raw).toBe(403);
    expect(viewerSeed.body).toMatchObject({ denial: "NOT_PERMITTED" });
    const viewerCode = await call(viewer.token, "POST", `/v1/reviewer/work/${wf}/code?teamId=${P().teamId}`, {
      fieldId: randomUUID(),
      value: { text: "x" },
    });
    expect(viewerCode.status, viewerCode.raw).toBe(403);
    expect(viewerCode.body).toMatchObject({ denial: "NOT_PERMITTED" });
    // A VIEWER holds no reviewer role, so reviewer working data stays closed too.
    const viewerRead = await call(viewer.token, "GET", `/v1/reviewer/qc/samples?teamId=${P().teamId}`);
    expect(viewerRead.status, viewerRead.raw).toBe(403);
  });

  it("PRO and FREE personal workspaces are refused ENTITLEMENT_REQUIRED on every read", async () => {
    const wf = await personalWorkflow();
    for (const plan of ["PRO", "FREE"] as const) {
      await setPersonalPlan(plan);
      for (const url of READS(P().teamId, wf)) {
        expectEntitlementRefusal(await call(P().token, "GET", url), `${plan} ${url}`);
      }
      expectEntitlementRefusal(
        await call(P().token, "POST", `/v1/coding/schemas/seed-defaults?teamId=${P().teamId}`),
        `${plan} seed`,
      );
    }
    await setPersonalPlan("TEAM");
  });

  it("an ENTERPRISE organization is served; its contract exclusion is honoured", async () => {
    const organizationId = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } }))
      .organizationId!;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    await prisma.enterpriseContract.upsert({
      where: { organizationId },
      create: { organizationId, status: "ACTIVE", reviewerOperationsEnabled: null },
      update: { status: "ACTIVE", reviewerOperationsEnabled: null },
    });
    const wf = await orgWorkflow(A);
    try {
      for (const url of READS(A.teamId, wf)) {
        const res = await call(A.ownerToken, "GET", url);
        expect(res.status, `${url}: ${res.raw}`).toBe(200);
      }
      await prisma.enterpriseContract.update({ where: { organizationId }, data: { reviewerOperationsEnabled: false } });
      expectEntitlementRefusal(await call(A.ownerToken, "GET", `/v1/reviewer/workspace?teamId=${A.teamId}`), "excluded contract");
    } finally {
      await prisma.enterpriseContract.deleteMany({ where: { organizationId } });
      await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "FREE", billingStatus: "INACTIVE" } });
    }
  });

  it("a non-member, and a member naming another workspace, are refused before the plan is disclosed", async () => {
    await setPersonalPlan("TEAM");
    const outsider = await call(B.ownerToken, "GET", `/v1/reviewer/workspace?teamId=${P().teamId}`);
    expect(outsider.status, outsider.raw).toBe(403);
    expect(outsider.body).toEqual({ denial: "NOT_PERMITTED" });
    const cross = await call(member.token, "GET", `/v1/coding/schemas?teamId=${A.teamId}`);
    expect(cross.status, cross.raw).toBe(403);
    expect(cross.body).toEqual({ denial: "NOT_PERMITTED" });
  });
});

describe("§2.1 / §2.10 — mixed bulk selections answer per item, and each item is audited", () => {
  it("one eligible, one CLOSED, one out of reach, one foreign: distinct reasons, audit rows per item", async () => {
    await setPersonalPlan("TEAM");
    const eligible = await personalWorkflow();
    const closed = await personalWorkflow("CLOSED");
    const unreachable = await personalWorkflow("NOT_STARTED", { restrictedTo: [P().userId] });
    const foreign = await orgWorkflow(B);

    const res = await call(admin.token, "POST", `/v1/reviewer/bulk/assign?teamId=${P().teamId}`, {
      assigneeUserId: P().userId,
      workflowIds: [eligible, closed, unreachable, foreign],
    });
    expect(res.status, res.raw).toBe(200);
    const byId = Object.fromEntries((res.body.outcomes as Array<{ workflowId: string }>).map((o) => [o.workflowId, o]));
    expect(byId[eligible]).toEqual({ workflowId: eligible, ok: true });
    expect(byId[closed]).toEqual({ workflowId: closed, ok: false, denial: "WORKFLOW_CLOSED", code: "workflow_closed" });
    // Out of reach and foreign stay the one non-enumerating answer.
    expect(byId[unreachable]).toEqual({ workflowId: unreachable, ok: false, denial: "WORKFLOW_NOT_FOUND" });
    expect(byId[foreign]).toEqual({ workflowId: foreign, ok: false, denial: "WORKFLOW_NOT_FOUND" });
    expect(res.body.succeeded).toBe(1);

    // The closed review was not re-staffed; the foreign one is untouched.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: closed } })).assignedToUserId).toBeNull();
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: foreign } })).assignedToUserId).toBeNull();
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: eligible } })).assignedToUserId).toBe(P().userId);

    expect(await auditRows("reviewer.bulk_assign", eligible)).toEqual([
      expect.objectContaining({ userId: admin.id, workspaceId: P().teamId, outcome: "success", resourceType: "evidence_review_workflow" }),
    ]);
    expect((await auditRows("reviewer.bulk_assign", eligible))[0]!.metadata).toMatchObject({
      workflowId: eligible,
      assigneeUserId: P().userId,
      bulk: true,
    });
    expect(await auditRows("reviewer.bulk_assign", closed)).toEqual([
      expect.objectContaining({ outcome: "denied", reasonCode: "workflow_closed" }),
    ]);
    expect(await auditRows("reviewer.bulk_assign", foreign)).toEqual([
      expect.objectContaining({ outcome: "denied", reasonCode: "WORKFLOW_NOT_FOUND" }),
    ]);
  });

  it("an assignee who cannot carry the review is NOT_PERMITTED with its typed code, not POLICY_REJECTED", async () => {
    await setPersonalPlan("TEAM");
    const wf = await personalWorkflow();
    const res = await call(admin.token, "POST", `/v1/reviewer/bulk/assign?teamId=${P().teamId}`, {
      assigneeUserId: viewer.id,
      workflowIds: [wf],
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.outcomes[0]).toMatchObject({ workflowId: wf, ok: false, denial: "NOT_PERMITTED" });
    expect(["assignee_not_eligible", "assignee_not_placed"]).toContain(res.body.outcomes[0].code);
  });

  it("bulk is refused on a PRO personal workspace with the typed entitlement refusal", async () => {
    await setPersonalPlan("PRO");
    const wf = await personalWorkflow();
    const res = await call(P().token, "POST", `/v1/reviewer/bulk/assign?teamId=${P().teamId}`, {
      assigneeUserId: P().userId,
      workflowIds: [wf],
    });
    expect(res.status, res.raw).toBe(403);
    expect(res.body.error).toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    await setPersonalPlan("TEAM");
  });
});

describe("§2.8 — reviewer performance says 'no data' instead of a fabricated value", () => {
  it("zero completions in range: slaComplianceRate, meanResolutionMs and capacityScore are null", async () => {
    await setPersonalPlan("TEAM");
    await personalWorkflow("IN_REVIEW", { assignedTo: member.id });
    const res = await call(P().token, "GET", `/v1/reviewer-ops/analytics/reviewers?teamId=${P().teamId}`);
    expect(res.status, res.raw).toBe(200);
    const row = (res.body.rows as Array<{ reviewerUserId: string }>).find((r) => r.reviewerUserId === member.id);
    expect(row).toMatchObject({
      active: 1,
      completedInRange: 0,
      slaComplianceRate: null,
      meanResolutionMs: null,
      capacityScore: null,
    });
  });

  it("a review completed OUTSIDE the range is not loaded; one inside counts", async () => {
    await setPersonalPlan("TEAM");
    const old = await personalWorkflow("CLOSED", { assignedTo: admin.id });
    await prisma.evidenceReviewWorkflow.update({
      where: { id: old },
      data: { completedAtUtc: new Date(Date.now() - 200 * 86400_000) },
    });
    let res = await call(P().token, "GET", `/v1/reviewer-ops/analytics/reviewers?teamId=${P().teamId}&rangeDays=30`);
    expect(res.status, res.raw).toBe(200);
    expect((res.body.rows as Array<{ reviewerUserId: string }>).find((r) => r.reviewerUserId === admin.id)).toBeUndefined();

    const recent = await personalWorkflow("CLOSED", { assignedTo: admin.id });
    await prisma.evidenceReviewWorkflow.update({
      where: { id: recent },
      data: { completedAtUtc: new Date(Date.now() - 86400_000) },
    });
    res = await call(P().token, "GET", `/v1/reviewer-ops/analytics/reviewers?teamId=${P().teamId}&rangeDays=30`);
    const row = (res.body.rows as Array<{ reviewerUserId: string }>).find((r) => r.reviewerUserId === admin.id);
    expect(row).toMatchObject({ completedInRange: 1, active: 0, slaComplianceRate: 1 });
  });
});
