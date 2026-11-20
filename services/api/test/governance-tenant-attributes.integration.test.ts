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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// PRO-G2-10 — the entitlement engine passes through untouched unless a case
// asks it to fail, to prove the gates fail closed.
const engine = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/services/packaging/entitlement.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/packaging/entitlement.service.js")>();
  return {
    ...actual,
    assertFeatureEntitlement: async (...args: Parameters<typeof actual.assertFeatureEntitlement>) => {
      if (engine.fail) throw new Error("entitlement engine unavailable (test)");
      return actual.assertFeatureEntitlement(...args);
    },
  };
});

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

  it("PRO-G2-10 — department and cross-org review creation refuse an unentitled workspace (403) and fail CLOSED when the entitlement engine throws; an entitled workspace creates", async () => {
    const { teamA, teamB } = h.fixtures;
    const post = (who: { ownerToken: string; teamId: string }, url: string, payload: unknown) =>
      h.app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${who.ownerToken}`,
          "content-type": "application/json",
          "x-proovra-workspace-id": who.teamId,
        },
        payload: payload as never,
      });
    const department = () => ({ name: "Investigations", slug: `inv-${randomUUID().slice(0, 8)}` });
    const crossOrg = (orgId: string, evidenceId: string) => ({
      invitingOrganizationId: orgId,
      invitedOrgSlug: `outside-${randomUUID().slice(0, 6)}`,
      scope: "Review of one record",
      subject: { kind: "EVIDENCE", id: evidenceId },
    });
    const counts = async (teamId: string) => ({
      departments: await prisma.department.count({ where: { teamId } }),
      grants: await prisma.crossOrgReviewGrant.count({ where: { teamId } }),
    });

    // Unentitled: refused with the entitlement body, nothing written.
    const bBefore = await counts(teamB.teamId);
    const bDept = await post(teamB, "/v1/governance/departments", department());
    expect(bDept.statusCode, bDept.body).toBe(403);
    expect(bDept.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_DEPARTMENT_ISOLATION" });
    const bCross = await post(teamB, "/v1/governance/cross-org-review", crossOrg(orgB, teamB.evidenceId));
    expect(bCross.statusCode, bCross.body).toBe(403);
    expect(bCross.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_CROSS_ORG_REVIEW" });
    expect(await counts(teamB.teamId)).toEqual(bBefore);

    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    for (const key of ["FEATURE_DEPARTMENT_ISOLATION", "FEATURE_CROSS_ORG_REVIEW", "FEATURE_GOVERNANCE_PLATFORM"] as const) {
      await upsertEntitlementGrant({
        teamId: teamA.teamId,
        key,
        value: true,
        kind: "FEATURE",
        source: "CUSTOM",
        grantedByUserId: teamA.ownerUserId,
      });
    }

    // The engine throws: a retryable 503 ENTITLEMENT_UNAVAILABLE naming the key
    // (matrix review follow-up: it answered the generic 500, not the 503 the
    // route comments promise), never an admission.
    const aBefore = await counts(teamA.teamId);
    engine.fail = true;
    try {
      const failedDept = await post(teamA, "/v1/governance/departments", department());
      expect(failedDept.statusCode, failedDept.body).toBe(503);
      expect(failedDept.json()).toEqual({ denial: "ENTITLEMENT_UNAVAILABLE", entitlement: "FEATURE_DEPARTMENT_ISOLATION" });
      const failedCross = await post(teamA, "/v1/governance/cross-org-review", crossOrg(orgA, teamA.evidenceId));
      expect(failedCross.statusCode, failedCross.body).toBe(503);
      expect(failedCross.json()).toEqual({ denial: "ENTITLEMENT_UNAVAILABLE", entitlement: "FEATURE_CROSS_ORG_REVIEW" });
      // The module's other governance gate answers the same way.
      const policiesBefore = await prisma.governancePolicy.count({ where: { teamId: teamA.teamId } });
      const failedPolicy = await post(teamA, "/v1/governance/policies", {
        kind: "RETENTION",
        slug: `p-${randomUUID().slice(0, 8)}`,
        name: "Policy",
        summary: "Policy",
        enforcementMode: "AUDIT_ONLY",
        rule: {},
      });
      expect(failedPolicy.statusCode, failedPolicy.body).toBe(503);
      expect(failedPolicy.json()).toEqual({ denial: "ENTITLEMENT_UNAVAILABLE", entitlement: "FEATURE_GOVERNANCE_PLATFORM" });
      expect(await prisma.governancePolicy.count({ where: { teamId: teamA.teamId } })).toBe(policiesBefore);
    } finally {
      engine.fail = false;
    }
    expect(await counts(teamA.teamId)).toEqual(aBefore);

    // Entitled and answering: both create.
    const okDept = await post(teamA, "/v1/governance/departments", department());
    expect(okDept.statusCode, okDept.body).toBe(201);
    const okCross = await post(teamA, "/v1/governance/cross-org-review", crossOrg(orgA, teamA.evidenceId));
    expect(okCross.statusCode, okCross.body).toBe(201);
  });
});
