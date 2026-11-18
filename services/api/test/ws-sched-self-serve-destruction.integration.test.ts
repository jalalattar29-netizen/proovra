/**
 * WS-SCHED / PRO-G2-02 (DEC-05) — a self-serve workspace's own owner can
 * request permanent deletion of a trashed record through the EXISTING
 * destruction-review subsystem, through the real routes and the real plan gate
 * (no billing mock) against a disposable PostgreSQL.
 *
 * At base every move towards destruction was Enterprise-gated (402) and
 * two-person, so a personal/owned workspace's trashed records could never be
 * purged once their barriers lifted. Now: the ACTIVE OWNER of a PERSONAL/OWNED
 * workspace opens, approves (step-up) and requests execution alone; an
 * ORGANIZATION workspace without Enterprise governance is still refused, and
 * Enterprise keeps separation of duties (gov-002 suite).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

describe("PRO-G2-02 self-serve owner destruction request (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const P = () => h.fixtures.personal;

  async function trashedRecord(teamId: string, ownerUserId: string) {
    const past = new Date(Date.now() - 86_400_000);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: `ws-sched-destroy-${randomUUID()}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        lifecycleState: "TRASHED",
        deletedAt: past,
        deleteScheduledForUtc: past,
      } as never,
      select: { id: true },
    });
  }

  const post = (token: string, url: string, payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      payload: payload as never,
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    stepUp = createStepUpCeremony({ prisma: prisma as never, inject: h.app.inject.bind(h.app) as never });
    await prisma.user.update({ where: { id: P().userId }, data: { currentWorkspaceId: P().teamId } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  beforeEach(() => {
    process.env.DESTRUCTION_EXECUTION_ENABLED = "true";
  });

  it("the personal workspace owner opens, takes up and approves alone (step-up), and the executor sees an approval", async () => {
    const ev = await trashedRecord(P().teamId, P().userId);
    const opened = await post(P().token, "/v1/governance/destruction-reviews", {
      teamId: P().teamId,
      evidenceId: ev.id,
      reason: "manual_review",
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const id = (opened.json() as { review: { id: string } }).review.id;

    const taken = await post(P().token, `/v1/governance/destruction-reviews/${id}/transition`, {
      teamId: P().teamId,
      nextStatus: "UNDER_REVIEW",
    });
    expect(taken.statusCode, taken.body).toBe(200);

    // Without step-up the destructive move is still refused.
    const noStepUp = await post(P().token, `/v1/governance/destruction-reviews/${id}/transition`, {
      teamId: P().teamId,
      nextStatus: "APPROVED",
      decisionNote: "owner requests permanent deletion",
    });
    expect(noStepUp.statusCode).not.toBe(200);

    const approveHeader = await stepUp.approvedHeader({
      token: P().token,
      userId: P().userId,
      teamId: P().teamId,
      purpose: "EVIDENCE_DESTRUCTION_APPROVE",
      resourceKind: "destruction_review",
      resourceId: id,
    });
    const approved = await post(
      P().token,
      `/v1/governance/destruction-reviews/${id}/transition`,
      { teamId: P().teamId, nextStatus: "APPROVED", decisionNote: "owner requests permanent deletion" },
      approveHeader,
    );
    expect(approved.statusCode, approved.body).toBe(200);
    const row = await prisma.destructionReview.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("APPROVED");
    expect(row.decidedByUserId).toBe(P().userId);
  });

  it("an ORGANIZATION workspace without Enterprise destruction governance is still refused, owner included", async () => {
    const A = h.fixtures.teamA;
    await prisma.user.update({ where: { id: A.ownerUserId }, data: { currentWorkspaceId: A.teamId } });
    const ev = await trashedRecord(A.teamId, A.ownerUserId);
    const res = await post(A.ownerToken, "/v1/governance/destruction-reviews", {
      teamId: A.teamId,
      evidenceId: ev.id,
      reason: "manual_review",
    });
    expect(res.statusCode, res.body).toBe(402);
    expect(await prisma.destructionReview.count({ where: { evidenceId: ev.id } })).toBe(0);
  });
});
