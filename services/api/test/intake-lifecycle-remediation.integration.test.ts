/**
 * ET-INT-01 / ET-INT-03 / ET-ACQ-02 — intake lifecycle and the allowance, on
 * live PostgreSQL 16 through the real public routes. The intake HMAC secret is
 * a throwaway value set in-process (as evidence-commercial-denial-contract does).
 *
 * Both behaviours were reproduced on a40ca76f by the audit's runtime proof
 * RT-INTAKE: /transition consumed a one-time link without finalizing, and an
 * anonymous never-submitted session consumed the owner's last FREE slot.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("intake lifecycle remediation (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  const P = () => h.fixtures.personal;
  const auth = () => ({ authorization: `Bearer ${P().token}` });
  const counted = () => prisma.evidence.count({ where: { ownerUserId: P().userId, deletedAt: null } as never });

  async function mintLink(maxUses?: number) {
    // A credit grant needs the entitlement row, which the first capture creates.
    if (!(await prisma.entitlement.findFirst({ where: { userId: P().userId } as never }))) {
      const first = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth(), payload: { type: "PHOTO", mimeType: "image/png" } });
      expect(first.statusCode, first.body).toBe(201);
    }
    const { grantEvidenceCredits } = await import("../src/services/billing/evidence-credits.service.js");
    await grantEvidenceCredits({ userId: P().userId, credits: 1, provider: "STRIPE" as never, providerRef: `rem-${randomUUID()}` });
    const res = await h.app.inject({
      method: "POST", url: "/v1/workflow/intake-links", headers: auth(),
      payload: { teamId: P().teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "remediation", expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), ...(maxUses ? { maxUses } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { rawToken: string; link: { id: string } };
  }
  async function openConsent(rawToken: string) {
    const t = encodeURIComponent(rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const consent = await h.app.inject({
      method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/consent`,
      payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"), termsAcknowledged: true, identityDisclosed: true, ipHash: null, userAgent: null } },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    return { t, sessionId: opened.session.id };
  }

  it("ET-INT-01: the public /transition route is retired (410) and consumes nothing", async () => {
    const link = await mintLink(1);
    const { t, sessionId } = await openConsent(link.rawToken);
    const res = await h.app.inject({ method: "POST", url: `/v1/external-intake/${t}/sessions/${sessionId}/transition`, payload: { to: "SUBMITTED" } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: "INTAKE_SESSION_TRANSITION_RETIRED" }, canonical: "/v1/external-intake/:token/sessions/:sid/submit" });
    const row = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: link.link.id }, select: { status: true, usedCount: true } as never }) as unknown as { status: string; usedCount: number };
    expect(row).toEqual({ status: "ACTIVE", usedCount: 0 });
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } as never }) as unknown as { status: string };
    expect(session.status).not.toBe("SUBMITTED");
    // The real contributor can still use the link.
    expect((await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` })).statusCode).toBe(200);
  });

  it("ET-INT-04: a 'request more' follow-up submission reaches the originating evidence request", async () => {
    const A = h.fixtures.teamA;
    // ET-INT-07 — a follow-up link is a mint like any other: the workspace's
    // plan must include secure intake (TEAM does; the fixture default does not).
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
    const svc = await import("../src/services/evidence-request.service.js");
    const { openIntakeSession } = await import("../src/services/workflow-intake-session.service.js");
    const created = await svc.createEvidenceRequest(
      { teamId: A.teamId, requestType: "ADDITIONAL_EVIDENCE", title: "Remediation follow-up", recipientMode: "EXTERNAL_CONTRIBUTOR", createIntakeLink: false } as never,
      { actorUserId: A.ownerUserId },
    );
    const requestId = (created as unknown as { request: { id: string } }).request.id;
    const first = await prisma.evidenceRequestResponse.create({ data: { evidenceRequestId: requestId, status: "RECEIVED" } as never, select: { id: true } });
    await svc.requestMoreEvidenceForResponse({ requestId, teamId: A.teamId, responseId: first.id, actorUserId: A.ownerUserId, notifyContributor: false });
    const ev = await prisma.evidenceRequestEvent.findFirstOrThrow({ where: { evidenceRequestId: requestId, eventType: "EVIDENCE_REQUEST_NEEDS_MORE_INFO" }, select: { payload: true } });
    const followUpLinkId = (ev.payload as { followUpIntakeLinkId: string }).followUpIntakeLinkId;

    // The follow-up link resolves to the request for both the linker and the page.
    expect(await svc.resolveEvidenceRequestIdForIntakeLink(followUpLinkId)).toBe(requestId);
    expect(await svc.projectRequestForExternalView(followUpLinkId)).not.toBeNull();

    // A finalized follow-up submission attaches a NEW response to the request.
    const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: followUpLinkId } });
    const session = await openIntakeSession({ link, submitterIp: "127.0.0.1", submitterUserAgent: "test" } as never);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({ data: { title: "follow-up", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never, select: { id: true } });
    await svc.linkResponseFromIntakeSession({ intakeLinkId: followUpLinkId, intakeSession: session as never, evidenceId: evidence.id });
    const responses = await prisma.evidenceRequestResponse.findMany({ where: { evidenceRequestId: requestId }, select: { responseEvidenceId: true } as never }) as unknown as Array<{ responseEvidenceId: string | null }>;
    expect(responses.map((r) => r.responseEvidenceId)).toContain(evidence.id);
  });

  it("ET-INT-03 / ET-ACQ-02: an abandoned reservation stops consuming the owner's FREE allowance once it expires", async () => {
    // Owner at 2 counted records.
    while ((await counted()) < 2) {
      const r = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth(), payload: { type: "PHOTO", mimeType: "image/png" } });
      expect(r.statusCode, r.body).toBe(201);
    }
    const link = await mintLink();
    await prisma.entitlement.updateMany({ where: { userId: P().userId } as never, data: { credits: 0 } as never });
    // An anonymous contributor reserves a record and never submits.
    const { t, sessionId } = await openConsent(link.rawToken);
    const part = await h.app.inject({
      method: "POST", url: `/v1/external-intake/${t}/sessions/${sessionId}/parts`,
      payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "c.txt", checksumSha256Base64: createHash("sha256").update("x").digest("base64"), webkitRelativePath: null },
    });
    expect(part.statusCode, part.body).toBe(201);
    // While the reservation is live it holds the slot (3/3): the owner is refused.
    const whileLive = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth(), payload: { type: "PHOTO", mimeType: "image/png" } });
    expect(whileLive.statusCode).toBe(409);
    const reservation = await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: sessionId }, select: { evidenceId: true } as never }) as unknown as { evidenceId: string };
    const aged = new Date(Date.now() - 25 * 3_600_000);
    await prisma.$executeRaw`UPDATE "evidence" SET "created_at" = ${aged}, "updated_at" = ${aged} WHERE "id" = ${reservation.evidenceId}::uuid`;
    // 25 h of inactivity also ages the record's upload-activity row: createEvidence opens one
    // (status PRESIGNED, last_activity_at_utc = now) for every reservation, and the reservation
    // authority counts a record with upload activity inside the window as live — the same
    // predicate the sweep uses to decide expiry. Without this the record is (correctly) still
    // "recently active", not 25 h idle.
    await prisma.$executeRaw`UPDATE "upload_sessions" SET "last_activity_at_utc" = ${aged} WHERE "evidence_id" = ${reservation.evidenceId}::uuid`;
    // UC-COM-001 — age alone does not release a reservation its live intake session can still
    // finalize: the slot stays held while the contributor can submit.
    const agedButLive = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth(), payload: { type: "PHOTO", mimeType: "image/png" } });
    expect(agedButLive.statusCode).toBe(409);
    // The reservation EXPIRES (its session is past its expiry, authoritatively): it no longer
    // consumes the allowance.
    await prisma.workflowIntakeSession.update({ where: { id: sessionId }, data: { expiresAtUtc: new Date(Date.now() - 60_000) } as never });
    const afterExpiry = await h.app.inject({ method: "POST", url: "/v1/evidence", headers: auth(), payload: { type: "PHOTO", mimeType: "image/png" } });
    expect(afterExpiry.statusCode, afterExpiry.body).toBe(201);
  });
});
