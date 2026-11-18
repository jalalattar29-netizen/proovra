/**
 * Free acceptance pass (2026-11-18), journey J7 — a ONE_TIME intake link that
 * has been SUBMITTED reopened as 410 LINK_NO_LONGER_AVAILABLE ("contact the
 * sender") instead of the read-only "already submitted" page.
 *
 * Submission flips a one-time link to status EXPIRED
 * (transitionIntakeSession → SUBMITTED) after its use was reserved
 * (used_count = 1), and validateIntakeToken asked `status === "EXPIRED"`
 * before it asked "one-time link already used", so the friendly branch was
 * unreachable for exactly the links it was written for. Live PostgreSQL 16,
 * the real create route and the real validator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("a submitted one-time intake link answers 'already submitted' (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let validateIntakeToken: (typeof import("../src/services/workflow-intake-session.service.js"))["validateIntakeToken"];
  let original: Record<string, unknown> | null = null;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "already-submitted-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ validateIntakeToken } = await import("../src/services/workflow-intake-session.service.js"));
    const A = h.fixtures.teamA;
    original = (await prisma.team.findUniqueOrThrow({
      where: { id: A.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as never;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
  }, 180_000);
  afterAll(async () => {
    if (original) await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: original as never }).catch(() => undefined);
    await h?.cleanup();
  });

  async function oneTimeLink(): Promise<{ id: string; rawToken: string }> {
    const A = h.fixtures.teamA;
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: {
        teamId: A.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_ONE_TIME",
        recipientLabel: "already submitted",
        expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { link: { id: string }; rawToken: string };
    expect(body.rawToken).toBeTruthy();
    return { id: body.link.id, rawToken: body.rawToken };
  }
  const codeOf = async (rawToken: string) =>
    ((await validateIntakeToken(rawToken).then(() => null, (e: unknown) => e)) as { code?: string } | null)?.code ?? "valid";

  it("after submission (use reserved, link flipped EXPIRED) the answer is link_already_submitted", async () => {
    const link = await oneTimeLink();
    expect(await codeOf(link.rawToken)).toBe("valid");
    // Exactly what a successful submission leaves: reserveIntakeLinkUse took the
    // one use, then transitionIntakeSession(SUBMITTED) closed the one-time link.
    await prisma.workflowIntakeLink.update({ where: { id: link.id }, data: { usedCount: 1, status: "EXPIRED" } as never });
    expect(await codeOf(link.rawToken)).toBe("link_already_submitted");
  });

  it("an unused link past its expiry is still link_expired, and a revoked one link_revoked", async () => {
    const expired = await oneTimeLink();
    await prisma.workflowIntakeLink.update({ where: { id: expired.id }, data: { expiresAtUtc: new Date(Date.now() - 60_000) } as never });
    expect(await codeOf(expired.rawToken)).toBe("link_expired");

    const revoked = await oneTimeLink();
    await prisma.workflowIntakeLink.update({ where: { id: revoked.id }, data: { status: "REVOKED", usedCount: 1 } as never });
    expect(await codeOf(revoked.rawToken)).toBe("link_revoked");
  });
});
