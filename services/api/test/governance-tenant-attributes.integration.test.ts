/**
 * PRO-071 / BILLING-12 — governance records take their tenant attributes from
 * the resolved workspace, never from the body.
 *
 * Reproduction (retest on 69251a953): a cross-org review naming tenant B's
 * organization as `invitingOrganizationId`, and an access-review campaign with
 * B's `workspaceId`, `organizationId` and `departmentId`, were both stored on
 * tenant A as given. The subject-user half was already fixed (821412bce).
 *
 * Driven against the two writing authorities with real tenant-B rows, plus
 * the own-tenant positive controls; the routes pass these values straight
 * through, so the authority is where the rule lives.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-071 governance tenant attributes (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let orgA: string;
  let orgB: string;
  let deptA: string;
  let deptB: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    const { teamA, teamB } = h.fixtures;
    const org = async (teamId: string) =>
      (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId!;
    orgA = await org(teamA.teamId);
    orgB = await org(teamB.teamId);
    const dept = async (teamId: string, organizationId: string) =>
      (
        await prisma.department.create({
          data: { teamId, organizationId, name: "Legal", slug: `legal-${randomUUID().slice(0, 8)}`, createdByUserId: null },
          select: { id: true },
        })
      ).id;
    deptA = await dept(teamA.teamId, orgA);
    deptB = await dept(teamB.teamId, orgB);
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const where = { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } };
      await prisma.accessReviewItem.deleteMany({ where }).catch(() => undefined);
      await prisma.accessReviewCampaign.deleteMany({ where }).catch(() => undefined);
      await prisma.crossOrgReviewGrant.deleteMany({ where }).catch(() => undefined);
      await prisma.department.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  const window = () => ({
    scheduledStartUtc: new Date(Date.now() + 60_000),
    scheduledEndUtc: new Date(Date.now() + 86_400_000),
  });

  it("an access-review campaign refuses another tenant's workspace, organization and department", async () => {
    const { createCampaign } = await import("../src/services/governance/access-review.service.js");
    const { teamA } = h.fixtures;
    const base = {
      prisma: prisma as never,
      teamId: teamA.teamId,
      kind: "PERIODIC" as const,
      name: "Q4 review",
      createdByUserId: teamA.ownerUserId,
      items: [],
      ...window(),
    };
    const before = await prisma.accessReviewCampaign.count({ where: { teamId: teamA.teamId } });
    for (const foreign of [
      { workspaceId: h.fixtures.teamB.teamId },
      { organizationId: orgB },
      { departmentId: deptB },
      { departmentId: randomUUID() },
    ]) {
      const r = await createCampaign({ ...base, organizationId: null, departmentId: null, workspaceId: null, ...foreign });
      expect(r, JSON.stringify(foreign)).toEqual({ ok: false, denial: "SCOPE_NOT_IN_WORKSPACE" });
    }
    expect(await prisma.accessReviewCampaign.count({ where: { teamId: teamA.teamId } })).toBe(before);

    // Positive control: the workspace's own ids.
    const ok = await createCampaign({ ...base, workspaceId: teamA.teamId, organizationId: orgA, departmentId: deptA });
    expect(ok.ok).toBe(true);
    const row = await prisma.accessReviewCampaign.findUniqueOrThrow({
      where: { id: (ok as { campaignId: string }).campaignId },
      select: { teamId: true, workspaceId: true, organizationId: true, departmentId: true },
    });
    expect(row).toEqual({ teamId: teamA.teamId, workspaceId: teamA.teamId, organizationId: orgA, departmentId: deptA });
  });

  it("a cross-org review refuses another tenant's organization as the inviter", async () => {
    const { inviteCrossOrgReview } = await import("../src/services/governance/cross-org-review.service.js");
    const { teamA } = h.fixtures;
    const base = {
      prisma: prisma as never,
      teamId: teamA.teamId,
      invitedOrgSlug: "outside-counsel",
      scope: "Review of one record",
      subject: { kind: "EVIDENCE" as const, id: teamA.evidenceId },
      createdByUserId: teamA.ownerUserId,
    };
    const before = await prisma.crossOrgReviewGrant.count({ where: { teamId: teamA.teamId } });
    for (const inviter of [orgB, randomUUID()]) {
      const r = await inviteCrossOrgReview({ ...base, invitingOrganizationId: inviter });
      expect(r).toEqual({ ok: false, denial: "ORGANIZATION_NOT_IN_WORKSPACE" });
    }
    expect(await prisma.crossOrgReviewGrant.count({ where: { teamId: teamA.teamId } })).toBe(before);

    const ok = await inviteCrossOrgReview({ ...base, invitingOrganizationId: orgA });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const row = await prisma.crossOrgReviewGrant.findUniqueOrThrow({
      where: { id: (ok as { grantId: string }).grantId },
      select: { teamId: true, invitingOrganizationId: true },
    });
    expect(row).toEqual({ teamId: teamA.teamId, invitingOrganizationId: orgA });
  });
});
