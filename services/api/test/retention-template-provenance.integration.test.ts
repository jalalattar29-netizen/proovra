/**
 * UC-ARCH-002 follow-up — retention provenance names the template on the LIVE path
 * (live PostgreSQL 16, real routes for the intake half).
 *
 * UC-ARCH-002 moved workspace retention into createEvidence (every channel). The
 * RETENTION_POLICY_APPLIED custody event it writes must carry the template-identity
 * trio whenever the ingress knows it at creation — an intake link always does. The
 * former mocked tests exercised a helper that no longer has a caller and accepted
 * either branch; this suite proves the real writer and the real intake flow.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("retention custody event carries the template trio (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let policyCreated = false;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "retention-provenance-throwaway-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const teamId = h.fixtures.teamA.teamId;
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    if (existing) await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { defaultRetentionDays: 90 } });
    else {
      await prisma.workspaceGovernancePolicy.create({ data: { teamId, defaultRetentionDays: 90 } as never });
      policyCreated = true;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma && policyCreated) {
      await prisma.workspaceGovernancePolicy.delete({ where: { teamId: h.fixtures.teamA.teamId } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function retentionPayload(evidenceId: string) {
    const ev = await prisma.custodyEvent.findFirst({
      where: { evidenceId, eventType: "RETENTION_POLICY_APPLIED" },
      select: { payload: true },
    });
    return ev?.payload as Record<string, unknown> | undefined;
  }

  it("createEvidence stamps a known trio and names it in the same-transaction retention event", async () => {
    const { createEvidence } = await import("../src/services/evidence.service.js");
    const trio = { templateSlug: "uca-retention-template", templateVersion: 3, templateDbId: null };
    const created = await createEvidence({
      ownerUserId: h.fixtures.teamA.ownerUserId,
      teamId: h.fixtures.teamA.teamId,
      type: "PHOTO",
      mimeType: "image/png",
      originalFileName: "p.png",
      captureFileName: null,
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      templateIdentity: trio,
    } as never);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: created.id },
      select: { templateSlug: true, templateVersion: true, retentionUntilUtc: true },
    });
    expect(row).toMatchObject({ templateSlug: trio.templateSlug, templateVersion: trio.templateVersion });
    expect(row.retentionUntilUtc).not.toBeNull();
    expect(await retentionPayload(created.id)).toMatchObject({
      retentionPolicyApplied: true,
      templateSlug: trio.templateSlug,
      templateVersion: trio.templateVersion,
      templateDbId: null,
    });
  });

  it("without a known trio the retention event states NULL members, never a guess", async () => {
    const { createEvidence } = await import("../src/services/evidence.service.js");
    const created = await createEvidence({
      ownerUserId: h.fixtures.teamA.ownerUserId,
      teamId: h.fixtures.teamA.teamId,
      type: "PHOTO",
      mimeType: "image/png",
      originalFileName: "q.png",
      captureFileName: null,
      acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID",
    } as never);
    expect(await retentionPayload(created.id)).toMatchObject({
      retentionPolicyApplied: true,
      templateSlug: null,
      templateVersion: null,
      templateDbId: null,
    });
  });

  it("a real intake submission's record names the link's template in its retention event", async () => {
    const A = h.fixtures.teamA;
    const auth = { authorization: `Bearer ${A.ownerToken}` };
    const link = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: auth,
      payload: {
        teamId: A.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        recipientLabel: "retention-provenance",
        expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(link.statusCode, link.body).toBe(201);
    const t = encodeURIComponent((link.json() as { rawToken: string }).rawToken);
    const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
    const consent = await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${opened.session.id}/consent`,
      payload: {
        consent: {
          acceptedAtUtc: new Date().toISOString(),
          policyVersion: opened.link.consentPolicyVersion || "v1",
          disclosureTextHash: createHash("sha256").update(opened.link.consentDisclosureText ?? "").digest("hex"),
          termsAcknowledged: true,
          identityDisclosed: true,
          ipHash: null,
          userAgent: null,
        },
      },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const part = await h.app.inject({
      method: "POST",
      url: `/v1/external-intake/${t}/sessions/${opened.session.id}/parts`,
      payload: {
        partIndex: 0,
        mimeType: "text/plain",
        originalFileName: `r-${randomUUID()}.txt`,
        checksumSha256Base64: createHash("sha256").update("r").digest("base64"),
        webkitRelativePath: null,
      },
    });
    expect(part.statusCode, part.body).toBe(201);
    const session = (await prisma.workflowIntakeSession.findUniqueOrThrow({
      where: { id: opened.session.id },
      select: { evidenceId: true } as never,
    })) as unknown as { evidenceId: string };
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: session.evidenceId },
      select: { templateSlug: true },
    });
    expect(ev.templateSlug).toBe("general-evidence-record");
    expect(await retentionPayload(session.evidenceId)).toMatchObject({
      retentionPolicyApplied: true,
      templateSlug: "general-evidence-record",
    });
  });
});
