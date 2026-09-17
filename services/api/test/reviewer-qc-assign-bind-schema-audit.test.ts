/**
 * Batch J — the two reviewer-workspace mutations the product now drives
 * (QC sample assignment, coding-schema binding) are audited, attributed to
 * the operator, and read back authoritatively.
 *
 *   - assignSample refuses an assignee who is not an ACTIVE member of the
 *     workspace (the body carried a bare uuid, so any user id — including
 *     another tenant's — used to be written as the QC reviewer).
 *   - assignSample emits `reviewer.qc.assigned` with the actor.
 *   - bindSchemaToWorkflow emits `reviewer.coding_schema.bound` with the
 *     actor and the previous binding.
 *   - archiveSchema attributes the actor when the route supplies one.
 *   - getWorkflowSchemaBinding distinguishes "no workflow" from "unbound".
 *   - The routes pass the authenticated actor, and GET .../coding returns
 *     the binding as `schemaBinding`.
 *   - The portal decisions read is scoped to the session grant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const emitTenantAuditMock = vi.fn(async () => undefined);
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: emitTenantAuditMock,
}));

type AnyFn = ReturnType<typeof vi.fn>;
const prismaStub = {
  qcSample: { findFirst: vi.fn(), update: vi.fn() },
  teamMember: { findFirst: vi.fn() },
  codingSchema: { findFirst: vi.fn(), update: vi.fn() },
  evidenceReviewWorkflow: { findFirst: vi.fn(), update: vi.fn() },
  externalReviewDecision: { findMany: vi.fn() },
};
vi.mock("../src/db.js", () => ({ prisma: prismaStub }));

const qc = await import("../src/services/reviewer-workspace/qc-sample.service.js");
const coding = await import("../src/services/reviewer-workspace/coding-schema.service.js");
const portalDecisions = await import(
  "../src/services/external-review/portal-decisions.service.js"
);

const TEAM = "00000000-0000-4000-8000-000000000001";
const SAMPLE = "00000000-0000-4000-8000-000000000002";
const WORKFLOW = "00000000-0000-4000-8000-000000000003";
const REVIEWER = "00000000-0000-4000-8000-000000000004";
const ACTOR = "00000000-0000-4000-8000-000000000005";
const SCHEMA = "00000000-0000-4000-8000-000000000006";
const OLD_SCHEMA = "00000000-0000-4000-8000-000000000007";
const GRANT = "00000000-0000-4000-8000-000000000008";

type AuditCall = {
  action: string;
  actorUserId: string | null;
  workspaceId: string;
  resourceId: string;
  metadata: Record<string, unknown>;
};
function audit(action: string): AuditCall | undefined {
  return (emitTenantAuditMock.mock.calls as unknown as Array<[AuditCall]>)
    .map((c) => c[0])
    .find((c) => c.action === action);
}

beforeEach(() => {
  emitTenantAuditMock.mockReset();
  emitTenantAuditMock.mockResolvedValue(undefined);
  for (const model of Object.values(prismaStub)) {
    for (const fn of Object.values(model)) (fn as AnyFn).mockReset();
  }
});

describe("assignSample", () => {
  it("refuses an assignee who is not an ACTIVE member of the workspace, writing nothing", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({
      id: SAMPLE, state: "SAMPLED", workflowId: WORKFLOW, qcReviewerUserId: null,
    });
    prismaStub.teamMember.findFirst.mockResolvedValueOnce(null);
    const res = await qc.assignSample({
      teamId: TEAM, sampleId: SAMPLE, qcReviewerUserId: REVIEWER, actorUserId: ACTOR,
    });
    expect(res).toEqual({ ok: false, denial: "NOT_PERMITTED" });
    expect(prismaStub.teamMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: TEAM, userId: REVIEWER, status: "ACTIVE" },
      }),
    );
    expect(prismaStub.qcSample.update).not.toHaveBeenCalled();
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("assigns an active member and audits the actor and the previous assignee", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({
      id: SAMPLE, state: "ASSIGNED", workflowId: WORKFLOW, qcReviewerUserId: "prev-user",
    });
    prismaStub.teamMember.findFirst.mockResolvedValueOnce({ userId: REVIEWER });
    prismaStub.qcSample.update.mockResolvedValueOnce({});
    const res = await qc.assignSample({
      teamId: TEAM, sampleId: SAMPLE, qcReviewerUserId: REVIEWER, actorUserId: ACTOR,
    });
    expect(res).toEqual({ ok: true });
    expect(prismaStub.qcSample.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ qcReviewerUserId: REVIEWER, state: "ASSIGNED" }),
      }),
    );
    const a = audit("reviewer.qc.assigned");
    expect(a).toBeDefined();
    expect(a!.actorUserId).toBe(ACTOR);
    expect(a!.workspaceId).toBe(TEAM);
    expect(a!.resourceId).toBe(SAMPLE);
    expect(a!.metadata).toEqual({
      sampleId: SAMPLE,
      workflowId: WORKFLOW,
      qcReviewerUserId: REVIEWER,
      previousQcReviewerUserId: "prev-user",
    });
  });

  it("refuses a sample that already has a verdict without checking membership", async () => {
    prismaStub.qcSample.findFirst.mockResolvedValueOnce({
      id: SAMPLE, state: "VERDICT_RENDERED", workflowId: WORKFLOW, qcReviewerUserId: REVIEWER,
    });
    const res = await qc.assignSample({ teamId: TEAM, sampleId: SAMPLE, qcReviewerUserId: REVIEWER });
    expect(res).toEqual({ ok: false, denial: "QC_VERDICT_INVALID" });
    expect(prismaStub.qcSample.update).not.toHaveBeenCalled();
  });
});

describe("bindSchemaToWorkflow + getWorkflowSchemaBinding", () => {
  it("binds a published schema and audits the actor and the previous binding", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({ id: SCHEMA, version: 3, slug: "privilege" });
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce({ id: WORKFLOW, codingSchemaId: OLD_SCHEMA });
    prismaStub.evidenceReviewWorkflow.update.mockResolvedValueOnce({});
    const res = await coding.bindSchemaToWorkflow({
      teamId: TEAM, workflowId: WORKFLOW, schemaId: SCHEMA, actorUserId: ACTOR,
    });
    expect(res).toEqual({ ok: true });
    const a = audit("reviewer.coding_schema.bound");
    expect(a).toBeDefined();
    expect(a!.actorUserId).toBe(ACTOR);
    expect(a!.resourceId).toBe(WORKFLOW);
    expect(a!.metadata).toEqual({
      workflowId: WORKFLOW, schemaId: SCHEMA, slug: "privilege", version: 3, previousSchemaId: OLD_SCHEMA,
    });
  });

  it("does not audit a refused bind", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce(null);
    const res = await coding.bindSchemaToWorkflow({ teamId: TEAM, workflowId: WORKFLOW, schemaId: SCHEMA, actorUserId: ACTOR });
    expect(res).toEqual({ ok: false, denial: "SCHEMA_NOT_FOUND" });
    expect(emitTenantAuditMock).not.toHaveBeenCalled();
  });

  it("archiveSchema attributes the actor the route supplies", async () => {
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({ id: SCHEMA, status: "PUBLISHED", slug: "privilege" });
    prismaStub.codingSchema.update.mockResolvedValueOnce({});
    await coding.archiveSchema({ teamId: TEAM, schemaId: SCHEMA, actorUserId: ACTOR });
    expect(audit("reviewer.coding_schema.archived")!.actorUserId).toBe(ACTOR);
  });

  it("reads the binding back: missing workflow, unbound, and bound are distinct", async () => {
    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce(null);
    expect(await coding.getWorkflowSchemaBinding({ teamId: TEAM, workflowId: WORKFLOW })).toBeNull();

    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce({ id: WORKFLOW, codingSchemaId: null, codingSchemaVersion: null });
    expect(await coding.getWorkflowSchemaBinding({ teamId: TEAM, workflowId: WORKFLOW })).toEqual({ workflowId: WORKFLOW, schema: null });

    prismaStub.evidenceReviewWorkflow.findFirst.mockResolvedValueOnce({ id: WORKFLOW, codingSchemaId: SCHEMA, codingSchemaVersion: 2 });
    prismaStub.codingSchema.findFirst.mockResolvedValueOnce({ id: SCHEMA, label: "Privilege review", version: 3, status: "PUBLISHED" });
    expect(await coding.getWorkflowSchemaBinding({ teamId: TEAM, workflowId: WORKFLOW })).toEqual({
      workflowId: WORKFLOW,
      schema: { id: SCHEMA, label: "Privilege review", version: 2, status: "PUBLISHED" },
    });
    expect(prismaStub.codingSchema.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: SCHEMA, teamId: TEAM } }),
    );
  });
});

describe("portal decisions are scoped to the caller's grant", () => {
  it("filters by grantId when one is supplied", async () => {
    prismaStub.externalReviewDecision.findMany.mockResolvedValueOnce([]);
    await portalDecisions.listExternalDecisionsForWorkflow({ teamId: TEAM, workflowId: WORKFLOW, grantId: GRANT });
    expect(prismaStub.externalReviewDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: TEAM, workflowId: WORKFLOW, grantId: GRANT } }),
    );
  });
});

describe("route wiring", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const REVIEWER = read("../src/routes/reviewer-workspace.routes.ts");
  const PORTAL = read("../src/routes/external-portal.routes.ts");

  it("assign, bind and archive pass the authenticated actor", () => {
    // `[^}]*` keeps each match inside that one call's argument object.
    expect(REVIEWER).toMatch(/assignSample\(\{[^}]*actorUserId: ctx\.userId,[^}]*\}\)/);
    expect(REVIEWER).toMatch(/bindSchemaToWorkflow\(\{[^}]*actorUserId: ctx\.userId,[^}]*\}\)/);
    expect(REVIEWER).toMatch(/archiveSchema\(\{[^}]*actorUserId: ctx\.userId,[^}]*\}\)/);
  });

  it("GET coding returns the authoritative schema binding", () => {
    expect(REVIEWER).toMatch(/getWorkflowSchemaBinding\(\{ teamId: ctx\.teamId, workflowId \}\)/);
    expect(REVIEWER).toMatch(/schemaBinding: binding\?\.schema \?\? null/);
  });

  it("the portal decisions read passes the session grant and never projects reviewer emails", () => {
    const start = PORTAL.indexOf('"/v1/portal/work/:workflowId/decisions"');
    const body = PORTAL.slice(start, PORTAL.indexOf("app.post(", start));
    expect(body).toMatch(/grantId: s\.grantId/);
    expect(body).not.toMatch(/reviewerEmail/);
    expect(body).not.toMatch(/send\(\{ decisions: rows \}\)/);
  });
});
