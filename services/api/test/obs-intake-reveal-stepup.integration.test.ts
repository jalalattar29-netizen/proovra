/**
 * OBS-INTAKE-REVEAL-STEPUP (closure phase 3) — one privacy and step-up rule for
 * every equivalent disclosure of a third party's raw contact.
 *
 * Decision G gave POST /v1/evidence-requests/:id/recipient-contact reach, the
 * canonical reveal authority, a fresh step-up bound to the request and an
 * audit row written before the values leave. The intake link's own reveal
 * (POST /v1/workflow/intake-links/:id/recipient-contact) and the intake
 * record's submitter reveal (POST /v1/evidence/:id/submitter-contact) disclose
 * the same class of data and had reach and the permission only: no step-up and
 * a fire-and-forget security event. They now follow the same rule, each with
 * its own purpose bound to its own resource.
 *
 * Real routes, real PostgreSQL; the step-up is the real authenticator-app
 * ceremony (support/step-up-ceremony).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("OBS-INTAKE-REVEAL-STEPUP — stepped-up, audited contact reveals (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const EMAIL = `obs-reveal-${randomUUID().slice(0, 8)}@contact.test`;
  const PHONE = "+15553217654";
  const SUBMITTER = `obs-submitter-${randomUUID().slice(0, 8)}@contact.test`;
  let linkId: string;
  let otherLinkId: string;
  let evidenceId: string;

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const linkUrl = (id: string) => `/v1/workflow/intake-links/${id}/recipient-contact`;
  const submitterUrl = (id: string) => `/v1/evidence/${id}/submitter-contact`;
  const post = (path: string, token: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}`, ...headers }, payload: {} });
  const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
  const audits = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findMany({ where: { action, resourceId } });
  const LINK_AUDIT = "workflow_intake_link.recipient_contact.revealed";
  const SUBMITTER_AUDIT = "evidence.submitter_contact.revealed";

  function memberStepUp(purpose: string, resourceKind: string, resourceId: string) {
    return stepUp.approvedHeader({
      token: A().memberToken,
      userId: A().memberUserId,
      teamId: A().teamId,
      purpose,
      resourceKind,
      resourceId,
    });
  }

  async function seedLink() {
    return (
      await prisma.workflowIntakeLink.create({
        data: {
          teamId: A().teamId,
          workflowTemplateSlug: "obs-reveal-proof",
          workflowTemplateVersion: 1,
          workflowTemplateSnapshot: {},
          intakeMode: "EXTERNAL_ONE_TIME",
          allowedAcceptedKinds: [],
          ipAllowlistCidrs: [],
          createdByUserId: A().ownerUserId,
          tokenHash: randomUUID().replace(/-/g, ""),
          recipientEmail: EMAIL,
          recipientPhone: PHONE,
          expiresAtUtc: new Date(Date.now() + 86_400_000),
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "obs-reveal-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    linkId = await seedLink();
    otherLinkId = await seedLink();
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    evidenceId = (
      await prisma.evidence.create({
        data: {
          title: `obs-reveal intake ${randomUUID().slice(0, 6)}`,
          type: "PHOTO",
          status: "CREATED",
          teamId: A().teamId,
          organizationId: team.organizationId,
          ownerUserId: A().ownerUserId,
          acquisitionMode: "SECURE_INTAKE_LINK",
          acquisitionModeSource: "RECORDED_AT_CREATION",
          submittedByEmail: SUBMITTER,
        } as never,
        select: { id: true },
      })
    ).id;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  beforeEach(async () => {
    await prisma.stepUpChallenge.deleteMany({ where: { initiatedByUserId: A().memberUserId } });
  });

  describe("intake link recipient contact", () => {
    it("without a step-up the reveal is refused (401 STEP_UP_REQUIRED), nothing leaves and nothing is audited", async () => {
      const res = await post(linkUrl(linkId), A().memberToken);
      expect(res.statusCode, res.body).toBe(401);
      expect(code(res)).toBe("STEP_UP_REQUIRED");
      expect(res.body).not.toContain(EMAIL);
      expect(res.body).not.toContain("5553217654");
      expect(await audits(LINK_AUDIT, linkId)).toHaveLength(0);
    });

    it("a challenge approved for ANOTHER link, or for another purpose on this link, does not reveal it", async () => {
      const otherResource = await memberStepUp("INTAKE_LINK_CONTACT_REVEAL", "workflow_intake_link", otherLinkId);
      const r1 = await post(linkUrl(linkId), A().memberToken, otherResource);
      expect(r1.statusCode, r1.body).toBe(401);
      expect(r1.body).not.toContain(EMAIL);

      const otherPurpose = await memberStepUp("EVIDENCE_REQUEST_CONTACT_REVEAL", "workflow_intake_link", linkId);
      const r2 = await post(linkUrl(linkId), A().memberToken, otherPurpose);
      expect(r2.statusCode, r2.body).toBe(401);
      expect(r2.body).not.toContain(EMAIL);
      expect(await audits(LINK_AUDIT, linkId)).toHaveLength(0);
    });

    it("a role without the reveal authority (VIEWER) is refused 403 before any step-up is asked; another workspace gets the missing-link 404", async () => {
      const viewer = await post(linkUrl(linkId), A().viewerToken);
      expect(viewer.statusCode, viewer.body).toBe(403);
      expect(code(viewer)).toBe("FORBIDDEN");
      const foreign = await post(linkUrl(linkId), B().ownerToken);
      expect(foreign.statusCode, foreign.body).toBe(404);
      for (const r of [viewer, foreign]) expect(r.body).not.toContain(EMAIL);
      expect(await audits(LINK_AUDIT, linkId)).toHaveLength(0);
    });

    it("authorized + a step-up bound to this link: revealed once, audited without the values; the challenge cannot be replayed", async () => {
      const header = await memberStepUp("INTAKE_LINK_CONTACT_REVEAL", "workflow_intake_link", linkId);
      const res = await post(linkUrl(linkId), A().memberToken, header);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ recipientContact: { recipientEmail: EMAIL, recipientPhone: PHONE } });

      const rows = await audits(LINK_AUDIT, linkId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(A().memberUserId);
      expect(rows[0]!.workspaceId).toBe(A().teamId);
      expect(rows[0]!.outcome).toBe("success");
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain("5553217654");

      const replay = await post(linkUrl(linkId), A().memberToken, header);
      expect(replay.statusCode, replay.body).toBe(401);
      expect(replay.body).not.toContain(EMAIL);
      expect(await audits(LINK_AUDIT, linkId)).toHaveLength(1);
    });
  });

  describe("intake record submitter contact", () => {
    it("without a step-up, or with a challenge for another purpose or record, nothing is revealed or audited", async () => {
      const none = await post(submitterUrl(evidenceId), A().memberToken);
      expect(none.statusCode, none.body).toBe(401);
      expect(code(none)).toBe("STEP_UP_REQUIRED");

      const wrongPurpose = await memberStepUp("INTAKE_LINK_CONTACT_REVEAL", "evidence", evidenceId);
      const r1 = await post(submitterUrl(evidenceId), A().memberToken, wrongPurpose);
      expect(r1.statusCode, r1.body).toBe(401);

      const wrongRecord = await memberStepUp("SUBMITTER_CONTACT_REVEAL", "evidence", randomUUID());
      const r2 = await post(submitterUrl(evidenceId), A().memberToken, wrongRecord);
      expect(r2.statusCode, r2.body).toBe(401);

      for (const r of [none, r1, r2]) expect(r.body).not.toContain(SUBMITTER);
      expect(await audits(SUBMITTER_AUDIT, evidenceId)).toHaveLength(0);
    });

    it("authorized + a step-up bound to this record: revealed once and audited without the value; replay refused", async () => {
      const header = await memberStepUp("SUBMITTER_CONTACT_REVEAL", "evidence", evidenceId);
      const res = await post(submitterUrl(evidenceId), A().memberToken, header);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { submitterContact: { submitterEmail: string | null } }).submitterContact.submitterEmail).toBe(SUBMITTER);
      const rows = await audits(SUBMITTER_AUDIT, evidenceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(A().memberUserId);
      expect(JSON.stringify(rows[0])).not.toContain(SUBMITTER);

      const replay = await post(submitterUrl(evidenceId), A().memberToken, header);
      expect(replay.statusCode, replay.body).toBe(401);
      expect(await audits(SUBMITTER_AUDIT, evidenceId)).toHaveLength(1);
    });
  });
});
