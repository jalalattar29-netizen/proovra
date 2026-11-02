/**
 * Residuals of the restricted-case work (GOV-017, EVID-019 and the surfaces the
 * remediation left open), each on real rows. `off` is an OWNER of the workspace off
 * the restricted case's list; `listed` is an OWNER on it. Every refusal has the
 * listed person's success beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { RowFactory, RowSet, type Tenant } from "./support/write-sweep-engine.js";
import { enterpriseTenantMaker } from "./support/write-sweep-world.js";

describe("restricted-case reach on the residual surfaces (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let kit: CoverageKit;
  let tenant: Tenant;
  let rows: RowSet;
  let off: Person;
  let listed: Person;
  let caseId: string;
  let hiddenEvidence: string;
  let openEvidence: string;
  const q = () => `teamId=${tenant.teamId}`;
  const headers = () => ({ "x-proovra-workspace-id": tenant.teamId });
  const get = (url: string, who: Person) => kit.call("GET", url, who, undefined, headers());
  const post = (url: string, who: Person, body: unknown = {}) => kit.call("POST", url, who, body, headers());
  const make = async (model: string, data: Record<string, unknown>) => {
    const fresh = new RowSet(rows.factory, prisma, tenant);
    const id = await rows.factory.make(fresh, model);
    if (!id) throw new Error(`fixture ${model}: ${rows.factory.failures.get(model)}`);
    const accessor = (prisma as any)[model.charAt(0).toLowerCase() + model.slice(1)];
    await accessor.update({ where: { id }, data });
    return id;
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    kit = await coverageKit(h);
    tenant = await (await enterpriseTenantMaker(h))();
    rows = new RowSet(new RowFactory(prisma), prisma, tenant);
    off = await kit.person(tenant.teamId, "OWNER");
    listed = await kit.person(tenant.teamId, "OWNER");

    caseId = (await rows.id("Case")) as string;
    await prisma.case.update({ where: { id: caseId }, data: { restrictedAtUtc: new Date() } });
    await prisma.caseAccess.create({ data: { caseId, userId: listed.id } });
    hiddenEvidence = (await rows.id("Evidence")) as string;
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: hiddenEvidence, teamId: tenant.teamId } as never });
    openEvidence = (await new RowSet(rows.factory, prisma, tenant).id("Evidence")) as string;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("ops incidents", () => {
    let incident: string;
    beforeAll(async () => {
      incident = await make("OperationalIncident", {
        teamId: tenant.teamId,
        relatedEvidenceId: hiddenEvidence,
        status: "OPEN",
        severity: "CRITICAL",
      });
    });

    it("detail is 404 off the list and 200 on it", async () => {
      expect((await get(`/v1/ops/incidents/${incident}?${q()}`, off)).statusCode).toBe(404);
      const mine = await get(`/v1/ops/incidents/${incident}?${q()}`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
    });

    it("an action off the list changes nothing", async () => {
      const refused = await post(`/v1/ops/incidents/${incident}/ack`, off, { teamId: tenant.teamId });
      expect(refused.statusCode, refused.body).toBe(404);
      const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident } });
      expect(row.status).toBe("OPEN");
    });
  });

  describe("AI QC runs", () => {
    let run: string;
    beforeAll(async () => {
      run = await make("AiCopilotRun", { workspaceId: tenant.teamId, caseId, userId: listed.id });
    });

    it("the sample list leaves out a closed case's run", async () => {
      const mine = await get(`/v1/ai/qc/samples?${q()}`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(run);
      const theirs = await get(`/v1/ai/qc/samples?${q()}`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(run);
    });

    it("a QC decision off the list is 404 and writes nothing", async () => {
      const refused = await post(`/v1/ai/qc/samples/${run}/decision`, off, { decision: "QC_REVIEWED" });
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await prisma.aiCopilotObservationReview.count({ where: { copilotRunId: run } })).toBe(0);
      const mine = await post(`/v1/ai/qc/samples/${run}/decision`, listed, { decision: "QC_REVIEWED" });
      expect(mine.statusCode, mine.body).toBe(200);
      expect(await prisma.aiCopilotObservationReview.count({ where: { copilotRunId: run } })).toBe(1);
    });
  });

  it("investigation diagnostics count what the caller reaches and say so", async () => {
    const mine = await get(`/v1/investigation/diagnostics?${q()}`, listed);
    const theirs = await get(`/v1/investigation/diagnostics?${q()}`, off);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(mine.json().workspace.evidenceCount).toBe(theirs.json().workspace.evidenceCount + 1);
    expect(mine.json().workspace.caseCount).toBe(theirs.json().workspace.caseCount + 1);
    expect(theirs.json().warnings).toContain("counts_limited_to_viewer_reach");
    expect(mine.json().warnings).not.toContain("counts_limited_to_viewer_reach");
  });

  it("the reviewer roster reads status values the enum holds", async () => {
    await make("EvidenceReviewWorkflow", { status: "IN_REVIEW" });
    const res = await get(`/v1/investigation/reviewers?${q()}`, listed);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("workflow_totals_unavailable");
    const totals = res.json().workflowTotals ?? res.json().totals ?? res.json();
    expect(totals.inProgress, res.body).toBeGreaterThanOrEqual(1);
  });

  describe("GOV-017: lifecycle destruction doors", () => {
    let request: string;
    beforeAll(async () => {
      request = await make("DestructionRequest", {
        teamId: tenant.teamId,
        evidenceIds: [hiddenEvidence],
        approverUserIds: [listed.id],
        requestedByUserId: tenant.owner.id,
        state: "PENDING_APPROVAL",
      });
    });

    it("the list leaves a request naming a closed record out", async () => {
      const mine = await get(`/v1/lifecycle/destruction/requests?${q()}`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(request);
      const theirs = await get(`/v1/lifecycle/destruction/requests?${q()}`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(request);
    });

    it("every door on that request is 404 off the list", async () => {
      for (const action of ["approve", "execute"]) {
        const r = await post(`/v1/lifecycle/destruction/requests/${request}/${action}`, off);
        expect(r.statusCode, `${action}: ${r.body}`).toBe(404);
      }
      const reject = await post(`/v1/lifecycle/destruction/requests/${request}/reject`, off, { reason: "no" });
      expect(reject.statusCode, reject.body).toBe(404);
      const cert = await get(`/v1/lifecycle/destruction/requests/${request}/certificate?${q()}`, off);
      expect(cert.statusCode, cert.body).toBe(404);
      const row = await prisma.destructionRequest.findUniqueOrThrow({ where: { id: request } });
      expect(row.state).toBe("PENDING_APPROVAL");
    });

    it("a request cannot be raised on a closed record, as if it did not exist", async () => {
      const before = await prisma.destructionRequest.count();
      const r = await post(`/v1/lifecycle/destruction/requests`, off, {
        evidenceIds: [hiddenEvidence],
        reason: "residual probe",
        requiredApproverUserIds: [listed.id],
      });
      expect(r.statusCode, r.body).toBe(404);
      expect(await prisma.destructionRequest.count()).toBe(before);
    });
  });

  describe("EVID-019: organization health and reviewer capacity", () => {
    it("the health score leaves out a closed record's incident", async () => {
      const { recordOrgHealthSnapshotForWorkspace } = await import("../src/services/dashboard/org-health.service.js");
      await recordOrgHealthSnapshotForWorkspace({ teamId: tenant.teamId });
      const mine = await get(`/v1/dashboard/org-health?${q()}`, listed);
      const theirs = await get(`/v1/dashboard/org-health?${q()}`, off);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.json().snapshot.incidentFrequency7d).toBe(mine.json().snapshot.incidentFrequency7d - 1);
      expect(theirs.json().snapshot.healthScore).toBeGreaterThan(mine.json().snapshot.healthScore);
    });

    it("a reviewer's load leaves out closed reviews, and no recommendation reads them", async () => {
      const capacity = await import("../src/services/dashboard/reviewer-capacity.service.js");
      const reach = await import("../src/services/access/record-reach.js");
      const workflow = {
        id: await make("EvidenceReviewWorkflow", {
          evidenceId: hiddenEvidence,
          assignedToUserId: listed.id,
          status: "IN_REVIEW",
        }),
      };
      await capacity.computeReviewerCapacityForWorkspace({ teamId: tenant.teamId });
      await prisma.reviewerRoutingRecommendation.create({
        data: {
          teamId: tenant.teamId,
          recommendationType: "REASSIGN",
          severity: "HIGH",
          reasonCode: "OWNER_OVERLOADED_REASSIGN_TO_LOW_SAT",
          explanation: "probe",
          status: "OPEN",
          recommendationKey: `probe-${workflow.id}`,
        } as never,
      });
      const closed = await reach.hiddenWorkflowIdsInWorkspace(tenant.teamId, off.id);
      expect(closed).toContain(workflow.id);
      const whole = await capacity.listReviewerCapacity({ teamId: tenant.teamId });
      const narrowed = await capacity.listReviewerCapacity({ teamId: tenant.teamId, closedWorkflowIds: closed });
      expect(whole.find((r) => r.reviewerUserId === listed.id)?.assignedCount).toBe(1);
      expect(narrowed.find((r) => r.reviewerUserId === listed.id)).toBeUndefined();

      const mine = await get(`/v1/reviewer/routing-recommendations?${q()}`, listed);
      expect(mine.json().recommendations).toHaveLength(1);
      const theirs = await get(`/v1/reviewer/routing-recommendations?${q()}`, off);
      expect(theirs.json().recommendations).toEqual([]);
    });

    it("Home's reviewer section agrees with the record list for an off-list admin", async () => {
      const home = await get(`/v1/dashboard/command-center?${q()}`, off);
      expect(home.statusCode, home.body).toBe(200);
      const reviewers = home.json().sections.reviewerCapacity.reviewers as Array<{ reviewerUserId: string }>;
      expect(reviewers.find((r) => r.reviewerUserId === listed.id)).toBeUndefined();
      expect(home.json().sections.reviewerCapacity.recommendations).toEqual([]);
    });
  });

  it("a session revocation cannot be aimed outside the workspace", async () => {
    const other = await (await enterpriseTenantMaker(h))();
    const session = () => kit.call("GET", "/v1/auth/me", other.member);
    expect((await session()).statusCode).toBe(200);
    const before = await prisma.revokedSession.count({ where: { userId: other.member.id } });
    for (const url of ["/v1/identity-security/sessions/revoke-all", "/v1/identity-security/sessions/revoke"]) {
      const refused = await kit.call(
        "POST",
        url,
        tenant.owner,
        { teamId: tenant.teamId, userId: other.member.id, sessionIdHash: "a".repeat(64) },
        headers(),
      );
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect(await prisma.revokedSession.count({ where: { userId: other.member.id } })).toBe(before);
    expect((await session()).statusCode).toBe(200);

    // The same request at the workspace's own member lands.
    const mine = await kit.call(
      "POST",
      "/v1/identity-security/sessions/revoke-all",
      tenant.owner,
      { teamId: tenant.teamId, userId: tenant.viewer.id },
      headers(),
    );
    expect(mine.statusCode, mine.body).toBe(200);
    expect(await prisma.revokedSession.count({ where: { userId: tenant.viewer.id } })).toBe(1);
  });

  it("the unrestricted record stays counted for both", async () => {
    const theirs = await get(`/v1/investigation/diagnostics?${q()}`, off);
    expect(theirs.json().workspace.evidenceCount).toBeGreaterThanOrEqual(1);
    expect(openEvidence).toBeTruthy();
  });
});
