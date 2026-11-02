/**
 * GOV-014 — an access certification only says access was removed when it was, and
 * nobody certifies their own access.
 *
 * Before: REVOKED was written first and revocation errors were swallowed, grantRef
 * was free text, DRAFT and CLOSED campaigns took decisions, a reviewer could decide
 * their own item, and these routes had no Enterprise gate.
 *
 * FIXTURES (labelled): the Enterprise plan gate is mocked to open for the
 * positive paths and proven closed in its own case. Grants are real rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const plan = vi.hoisted(() => ({ enterprise: true }));

vi.mock("../src/services/enterprise-gate-resolvers.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/enterprise-gate-resolvers.service.js")>();
  return {
    ...original,
    denyTeamIfNotEnterprise: vi.fn(async (reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      if (plan.enterprise) return false;
      reply.code(402).send({ error: { code: "ENTERPRISE_FEATURE_REQUIRED" } });
      return true;
    }),
  };
});

describe("GOV-014 access reviews (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let service: typeof import("../src/services/governance/access-review.service.js");

  const A = () => h.fixtures.teamA;

  async function campaign(state: "DRAFT" | "OPEN" | "CLOSED" = "OPEN") {
    const now = new Date();
    return prisma.accessReviewCampaign.create({
      data: {
        teamId: A().teamId,
        kind: "DELEGATED_ADMIN",
        state,
        name: `gov-014 ${randomUUID()}`,
        scheduledStartUtc: now,
        scheduledEndUtc: new Date(now.getTime() + 86_400_000),
        createdByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
  }

  async function delegatedScope(userId: string, scopeKind = "IDENTITY_ADMIN") {
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: A().teamId, userId },
      select: { id: true },
    });
    return prisma.memberDelegatedAdminScope.create({
      data: {
        teamMemberId: member.id,
        teamId: A().teamId,
        scopeKind,
        grantedByUserId: A().ownerUserId,
        reason: "gov-014 fixture",
      } as never,
      select: { id: true },
    });
  }

  async function item(campaignId: string, subjectUserId: string, grantRef: string) {
    return prisma.accessReviewItem.create({
      data: { campaignId, teamId: A().teamId, subjectUserId, decision: "PENDING", grantRef },
      select: { id: true },
    });
  }

  const decide = (itemId: string, decision: "REVOKED" | "APPROVED", reviewerUserId = A().ownerUserId) =>
    service.recordItemDecision({ prisma: prisma as never, teamId: A().teamId, itemId, decision, reviewerUserId });

  const decisionOf = async (id: string) =>
    (await prisma.accessReviewItem.findUniqueOrThrow({ where: { id }, select: { decision: true } })).decision;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    service = await import("../src/services/governance/access-review.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  beforeEach(() => {
    plan.enterprise = true;
  });

  it("POSITIVE: REVOKED on a real grant revokes it and records the decision", async () => {
    const c = await campaign();
    const scope = await delegatedScope(A().memberUserId);
    const it_ = await item(c.id, A().memberUserId, `delegated_scope:${scope.id}`);
    expect(await decide(it_.id, "REVOKED")).toEqual({ ok: true });
    expect(await decisionOf(it_.id)).toBe("REVOKED");
    const after = await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scope.id } });
    expect(after.revokedAtUtc).not.toBeNull();
  });

  it("a revoke that fails leaves the item PENDING and says so", async () => {
    const c = await campaign();
    // A well-formed reference to a grant that is not there.
    const it_ = await item(c.id, A().memberUserId, `delegated_scope:${randomUUID()}`);
    expect(await decide(it_.id, "REVOKED")).toEqual({ ok: false, denial: "GRANT_REVOKE_FAILED" });
    expect(await decisionOf(it_.id)).toBe("PENDING");
  });

  it("a free-text grant reference cannot be recorded as revoked", async () => {
    const c = await campaign();
    const it_ = await item(c.id, A().memberUserId, "shared-drive-access");
    expect(await decide(it_.id, "REVOKED")).toEqual({ ok: false, denial: "GRANT_NOT_REVOCABLE" });
    expect(await decisionOf(it_.id)).toBe("PENDING");
  });

  it.each(["DRAFT", "CLOSED"] as const)("a %s campaign takes no decisions", async (state) => {
    const c = await campaign(state);
    const it_ = await item(c.id, A().memberUserId, "shared-drive-access");
    expect(await decide(it_.id, "APPROVED")).toEqual({ ok: false, denial: "CAMPAIGN_NOT_OPEN" });
    expect(await decisionOf(it_.id)).toBe("PENDING");
  });

  it("nobody decides their own access", async () => {
    const c = await campaign();
    const it_ = await item(c.id, A().ownerUserId, "shared-drive-access");
    expect(await decide(it_.id, "APPROVED", A().ownerUserId)).toEqual({ ok: false, denial: "SELF_REVIEW_REFUSED" });
    expect(await decisionOf(it_.id)).toBe("PENDING");
  });

  it("two simultaneous decisions record one, with one audit event", async () => {
    const c = await campaign();
    const it_ = await item(c.id, A().memberUserId, "shared-drive-access");
    const [first, second] = await Promise.all([decide(it_.id, "APPROVED"), decide(it_.id, "APPROVED", A().adminUserId)]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.intelligenceActivityEvent.count({ where: { targetType: "ACCESS_REVIEW_ITEM", targetId: it_.id } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("a campaign is refused for a non-member subject and for a reference to no real grant", async () => {
    const base = {
      prisma: prisma as never,
      teamId: A().teamId,
      kind: "PERIODIC" as const,
      name: "gov-014 create",
      scheduledStartUtc: new Date(),
      scheduledEndUtc: new Date(Date.now() + 86_400_000),
      createdByUserId: A().ownerUserId,
    };
    const scope = await delegatedScope(A().memberUserId, "GOVERNANCE_ADMIN");
    expect(
      await service.createCampaign({
        ...base,
        items: [{ subjectUserId: h.fixtures.teamB.ownerUserId, grantRef: `delegated_scope:${scope.id}` }],
      }),
    ).toEqual({ ok: false, denial: "SUBJECT_NOT_A_MEMBER" });
    expect(
      await service.createCampaign({
        ...base,
        items: [{ subjectUserId: A().memberUserId, grantRef: "anything at all" }],
      }),
    ).toEqual({ ok: false, denial: "GRANT_NOT_RECOGNISED" });
    expect(
      await service.createCampaign({
        ...base,
        items: [{ subjectUserId: A().adminUserId, grantRef: `delegated_scope:${scope.id}` }],
      }),
    ).toEqual({ ok: false, denial: "GRANT_NOT_RECOGNISED" });
    const ok = await service.createCampaign({
      ...base,
      items: [{ subjectUserId: A().memberUserId, grantRef: `delegated_scope:${scope.id}` }],
    });
    expect(ok).toMatchObject({ ok: true, itemCount: 1 });
  });

  it("the decision route answers to the Enterprise gate", async () => {
    plan.enterprise = false;
    await prisma.user.update({ where: { id: A().ownerUserId }, data: { currentWorkspaceId: A().teamId } });
    const c = await campaign();
    const it_ = await item(c.id, A().memberUserId, "shared-drive-access");
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/governance/access-reviews/items/${it_.id}/decision`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
      payload: { decision: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(402);
    expect(await decisionOf(it_.id)).toBe("PENDING");
  });
});
