/**
 * NEW-RG-19-1 (owner decision G, 2026-11-21) — the recipient contact of an
 * evidence request created WITHOUT an intake link stays masked on list/get and
 * is revealed only through POST /v1/evidence-requests/:id/recipient-contact:
 * record/case reach, the canonical reveal authority
 * (`workflow.intake_recipient_contact.reveal`), a fresh step-up bound to the
 * request, and an audit row written before the values leave.
 *
 * Real routes, real PostgreSQL; the step-up is the real authenticator-app
 * ceremony (support/step-up-ceremony).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;
const PURPOSE = "EVIDENCE_REQUEST_CONTACT_REVEAL";

describe("NEW-RG-19-1 — stepped-up, audited reveal for a request without an intake link (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const EMAIL = `rg191-${randomUUID().slice(0, 8)}@contact.test`;
  const PHONE = "+15557654321";
  let requestId: string;
  let otherRequestId: string;
  let linkedRequestId: string;
  let restrictedRequestId: string;

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const url = (id: string) => `/v1/evidence-requests/${id}/recipient-contact`;
  const call = (method: "GET" | "POST", path: string, token: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, ...headers } });
  const code = (res: { json: () => unknown }) => {
    const b = res.json() as { error?: { code?: string } };
    return b.error?.code;
  };
  const revealAudits = (id: string) =>
    prisma.adminAuditLog.findMany({
      where: { action: "evidence_request.recipient_contact.revealed", resourceId: id },
    });

  async function seedRequest(extra: Record<string, unknown> = {}) {
    return (
      await prisma.evidenceRequest.create({
        data: {
          teamId: A().teamId,
          requestType: "ADDITIONAL_EVIDENCE",
          recipientMode: "EXTERNAL_CONTRIBUTOR",
          requestedByUserId: A().ownerUserId,
          title: `rg191-${randomUUID().slice(0, 6)}`,
          recipientEmail: EMAIL,
          recipientPhone: PHONE,
          ...extra,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  function memberStepUp(resourceId: string) {
    return stepUp.approvedHeader({
      token: A().memberToken,
      userId: A().memberUserId,
      teamId: A().teamId,
      purpose: PURPOSE,
      resourceKind: "evidence_request",
      resourceId,
    });
  }

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });

    requestId = await seedRequest();
    otherRequestId = await seedRequest();

    const link = await prisma.workflowIntakeLink.create({
      data: {
        teamId: A().teamId,
        workflowTemplateSlug: "rg191-proof",
        workflowTemplateVersion: 1,
        workflowTemplateSnapshot: {},
        intakeMode: "EXTERNAL_ONE_TIME",
        allowedAcceptedKinds: [],
        ipAllowlistCidrs: [],
        createdByUserId: A().ownerUserId,
        tokenHash: randomUUID().replace(/-/g, ""),
        recipientEmail: EMAIL,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
      } as never,
      select: { id: true },
    });
    linkedRequestId = await seedRequest({ intakeLinkId: link.id });

    const restrictedCase = await prisma.case.create({
      data: { name: `rg191-restricted-${randomUUID().slice(0, 6)}`, teamId: A().teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
      select: { id: true },
    });
    restrictedRequestId = await seedRequest({ caseId: restrictedCase.id });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  beforeEach(async () => {
    await prisma.stepUpChallenge.deleteMany({ where: { initiatedByUserId: A().memberUserId } });
  });

  it("masked by default: list and detail never carry the raw contact, even for a reveal holder", async () => {
    for (const path of [`/v1/evidence-requests/${requestId}`, `/v1/evidence-requests?teamId=${A().teamId}`]) {
      const res = await call("GET", path, A().memberToken);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      expect(res.body).toContain(requestId);
      expect(res.body).not.toContain(EMAIL);
      expect(res.body).not.toContain("5557654321");
    }
    const detail = (await call("GET", `/v1/evidence-requests/${requestId}`, A().memberToken)).json() as {
      request: Record<string, unknown>;
    };
    expect(detail.request).toMatchObject({
      intakeLinkId: null,
      recipientEmail: null,
      recipientPhone: null,
      hasRecipientEmail: true,
      recipientContactRevealAuthorized: true,
    });
  });

  it("a reveal without a step-up is refused (401 STEP_UP_REQUIRED) and writes no reveal audit", async () => {
    const res = await call("POST", url(requestId), A().memberToken);
    expect(res.statusCode, res.body).toBe(401);
    expect(code(res)).toBe("STEP_UP_REQUIRED");
    expect(res.body).not.toContain(EMAIL);
    expect(await revealAudits(requestId)).toHaveLength(0);
  });

  it("a step-up approved for ANOTHER request does not reveal this one", async () => {
    const header = await memberStepUp(otherRequestId);
    const res = await call("POST", url(requestId), A().memberToken, header);
    expect(res.statusCode, res.body).toBe(401);
    expect(res.body).not.toContain(EMAIL);
    expect(await revealAudits(requestId)).toHaveLength(0);
  });

  it("a role without the reveal authority (VIEWER) is refused (403) before any step-up is asked", async () => {
    const res = await call("POST", url(requestId), A().viewerToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(code(res)).toBe("FORBIDDEN");
    expect(res.body).not.toContain(EMAIL);
    expect(await revealAudits(requestId)).toHaveLength(0);
  });

  it("authorized + step-up: the raw contact is revealed once and the disclosure is audited without the values", async () => {
    const header = await memberStepUp(requestId);
    const res = await call("POST", url(requestId), A().memberToken, header);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ recipientContact: { recipientEmail: EMAIL, recipientPhone: PHONE } });

    const audits = await revealAudits(requestId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(A().memberUserId);
    expect(audits[0]!.workspaceId).toBe(A().teamId);
    expect(audits[0]!.outcome).toBe("success");
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain("5557654321");
    expect(serialized).not.toContain(header["x-proovra-step-up-challenge-id"]!);

    // The challenge was single-use: replaying it is refused.
    const replay = await call("POST", url(requestId), A().memberToken, header);
    expect(replay.statusCode, replay.body).toBe(401);
    expect(await revealAudits(requestId)).toHaveLength(1);
  });

  it("cross-tenant: another workspace's owner gets the missing-request answer", async () => {
    const res = await call("POST", url(requestId), B().ownerToken);
    expect(res.statusCode, res.body).toBe(404);
    expect(code(res)).toBe("request_not_found");
    expect(res.body).not.toContain(EMAIL);
  });

  it("a request on a restricted case the caller cannot reach answers as missing", async () => {
    const res = await call("POST", url(restrictedRequestId), A().memberToken);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).not.toContain(EMAIL);
  });

  it("a request sent through an intake link points at the link's own reveal route", async () => {
    const res = await call("POST", url(linkedRequestId), A().memberToken);
    expect(res.statusCode, res.body).toBe(409);
    expect(code(res)).toBe("REVEAL_VIA_INTAKE_LINK");
    expect(res.body).not.toContain(EMAIL);
  });
});
