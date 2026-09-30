/**
 * ET-INT-07 — every intake-link mint for a workspace passes THE mint gate:
 * the secure-intake plan and the workspace governance policy. Live PostgreSQL
 * 16, the real services.
 *
 * On a40ca76f evidence-request SEND and REQUEST-MORE called
 * createWorkflowIntakeLink directly, so a workspace whose policy disabled
 * external intake — or that was downgraded off intake — still minted public
 * links through them. Request-more also minted on a cancelled request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("intake-link mint gate on the evidence-request flows (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/evidence-request.service.js");
  let original: Record<string, unknown> | null = null;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "mint-gate-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/evidence-request.service.js");
    const A = h.fixtures.teamA;
    original = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { billingPlan: true, billingStatus: true } })) as never;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
  }, 180_000);
  afterAll(async () => {
    if (original) await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: original as never }).catch(() => undefined);
    await h?.cleanup();
  });

  async function externalDraft() {
    const A = h.fixtures.teamA;
    const created = await svc.createEvidenceRequest(
      { teamId: A.teamId, requestType: "ADDITIONAL_EVIDENCE", title: "mint gate", recipientMode: "EXTERNAL_CONTRIBUTOR", createIntakeLink: false } as never,
      { actorUserId: A.ownerUserId },
    );
    return (created as unknown as { request: { id: string } }).request.id;
  }
  async function withExternalIntakeDisabled(fn: () => Promise<void>) {
    const teamId = h.fixtures.teamA.teamId;
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    if (existing) await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { allowExternalIntake: false } as never });
    else await prisma.workspaceGovernancePolicy.create({ data: { teamId, allowExternalIntake: false } as never });
    try {
      await fn();
    } finally {
      await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { allowExternalIntake: true } as never });
    }
  }
  const links = (teamId: string) => prisma.workflowIntakeLink.count({ where: { teamId } });

  it("SEND: a policy that disables external intake refuses the mint before anything changes", async () => {
    const A = h.fixtures.teamA;
    const id = await externalDraft();
    await withExternalIntakeDisabled(async () => {
      const before = await links(A.teamId);
      const err = await svc.sendEvidenceRequest({ id, teamId: A.teamId, actorUserId: A.ownerUserId }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("intake_blocked_by_policy");
      expect(await links(A.teamId)).toBe(before);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id }, select: { status: true, intakeLinkId: true } });
      expect(row).toEqual({ status: "DRAFT", intakeLinkId: null });
    });
  });

  it("REQUEST-MORE: the same policy refuses the follow-up link", async () => {
    const A = h.fixtures.teamA;
    const id = await externalDraft();
    const response = await prisma.evidenceRequestResponse.create({ data: { evidenceRequestId: id, status: "RECEIVED" } as never, select: { id: true } });
    await withExternalIntakeDisabled(async () => {
      const before = await links(A.teamId);
      const err = await svc
        .requestMoreEvidenceForResponse({ requestId: id, teamId: A.teamId, responseId: response.id, actorUserId: A.ownerUserId, notifyContributor: false })
        .catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("intake_blocked_by_policy");
      expect(await links(A.teamId)).toBe(before);
    });
  });

  it("REQUEST-MORE on a CANCELLED request mints nothing (request_terminal)", async () => {
    const A = h.fixtures.teamA;
    const id = await externalDraft();
    const response = await prisma.evidenceRequestResponse.create({ data: { evidenceRequestId: id, status: "RECEIVED" } as never, select: { id: true } });
    await prisma.evidenceRequest.update({ where: { id }, data: { status: "CANCELLED" } as never });
    const before = await links(A.teamId);
    const err = await svc
      .requestMoreEvidenceForResponse({ requestId: id, teamId: A.teamId, responseId: response.id, actorUserId: A.ownerUserId, notifyContributor: false })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("request_terminal");
    expect(await links(A.teamId)).toBe(before);
  });

  it("SEND: a workspace without secure intake on its plan is refused intake_not_included", async () => {
    const A = h.fixtures.teamA;
    const id = await externalDraft();
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "FREE" } as never });
    try {
      const before = await links(A.teamId);
      const err = await svc.sendEvidenceRequest({ id, teamId: A.teamId, actorUserId: A.ownerUserId }).catch((e: unknown) => e);
      expect(["intake_not_included", "commercial_lifecycle_restricted"]).toContain((err as { code?: string }).code);
      expect(await links(A.teamId)).toBe(before);
    } finally {
      await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE" } as never });
    }
  });

  it("the gate still admits a plan and policy that allow it", async () => {
    const A = h.fixtures.teamA;
    const id = await externalDraft();
    const sent = await svc.sendEvidenceRequest({ id, teamId: A.teamId, actorUserId: A.ownerUserId });
    expect(sent.rawToken).toBeTruthy();
  });
});
