/**
 * Team remediation stage F — T-133 (audit REV-06/REV-24/REV-28): the
 * evidence-request review list. Real PostgreSQL, the real route.
 *
 *   - Priority is filtered in the query, before the page bound. The audited
 *     route filtered the first page in memory, so a priority that sorts last
 *     came back short (here: none of the five LOW requests behind 145 URGENT).
 *   - Several statuses can be asked for at once (the reviewable set).
 *   - The assignee is named, never only an id.
 *   - The list reads no deliverable or response rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("T-133 — GET /v1/review/queue (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  const get = (qs: string) =>
    h.app.inject({ method: "GET", url: `/v1/review/queue?teamId=${h.fixtures.teamA.teamId}&${qs}`, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });

  it("priority, statuses, assignee names and the page bound", async () => {
    const A = h.fixtures.teamA;
    await prisma.user.update({ where: { id: A.ownerUserId }, data: { displayName: "Dana Reviewer" } });
    const base = { teamId: A.teamId, requestType: "ADDITIONAL_EVIDENCE", recipientMode: "INTERNAL_USER", requestedByUserId: A.ownerUserId, status: "RESPONSE_RECEIVED" } as const;
    await prisma.evidenceRequest.createMany({
      data: Array.from({ length: 145 }, (_, i) => ({ ...base, title: `t133 urgent ${i}`, priority: "URGENT" as const })),
    });
    const low = [];
    for (let i = 0; i < 5; i++) {
      low.push(
        await prisma.evidenceRequest.create({
          data: { ...base, title: `t133 low ${i}`, priority: "LOW", assignedReviewerUserId: A.ownerUserId, status: i === 0 ? "DRAFT" : "UNDER_REVIEW" } as never,
          select: { id: true },
        }),
      );
    }
    await prisma.evidenceRequestResponse.create({
      data: { evidenceRequestId: low[1]!.id, status: "SUBMITTED", submittedByExternalLabel: "contributor" } as never,
    }).catch(() => undefined);

    const res = await get("priority=LOW&limit=100");
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.id).sort()).toEqual(low.map((l) => l.id).sort());
    for (const item of items) {
      expect(item.priority).toBe("LOW");
      expect(item.assignedReviewerDisplayName).toBe("Dana Reviewer");
      expect(item.responses).toEqual([]);
    }

    const reviewable = await get("statuses=RESPONSE_RECEIVED,UNDER_REVIEW,PARTIALLY_FULFILLED&priority=LOW&limit=100");
    expect(reviewable.statusCode, reviewable.body).toBe(200);
    const r = (reviewable.json() as { items: Array<{ id: string; status: string }> }).items;
    expect(r).toHaveLength(4);
    expect(r.every((i) => i.status === "UNDER_REVIEW")).toBe(true);

    const bad = await get("statuses=NOT_A_STATUS");
    expect(bad.statusCode).toBe(400);
  });
});
