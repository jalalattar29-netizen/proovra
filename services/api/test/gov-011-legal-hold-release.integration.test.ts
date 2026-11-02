/**
 * GOV-011 — "Require approval to release a legal hold" means a second person's
 * recorded approval, through the real routes.
 *
 * Before: the gate passed on `approvalAcknowledged: true`, which the legal-holds
 * page always sent, and the release recorded the releaser as its own approver.
 *
 * FIXTURES (labelled): the Legal Hold entitlement needs a contract term, so the
 * hold rows here are seeded directly as a fixture, with the policy flag captured
 * on them as placement would. The approver's `governance.legal_hold.manage` is the
 * ADMIN role's own; the requester is the OWNER. Entitlement is proven by its own
 * suites and is not exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

describe("GOV-011 legal hold release under approval (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const A = () => h.fixtures.teamA;

  async function heldRecord(requireApproval: boolean) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const ev = await prisma.evidence.create({
      data: {
        title: "gov-011 record",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    const hold = await prisma.evidenceLegalHold.create({
      data: {
        teamId: A().teamId,
        scope: "EVIDENCE",
        evidenceId: ev.id,
        status: "ACTIVE",
        title: "gov-011 hold (fixture row)",
        reason: "gov-011",
        placedByUserId: A().ownerUserId,
        releaseApprovalRequired: requireApproval,
        releaseApprovalState: requireApproval ? "PENDING" : "NOT_REQUIRED",
      } as never,
      select: { id: true },
    });
    return { evidenceId: ev.id, holdId: hold.id };
  }

  const post = (token: string, url: string, payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      payload: payload as never,
    });

  const header = (who: "owner" | "admin", holdId: string) =>
    stepUp.approvedHeader({
      token: who === "owner" ? A().ownerToken : A().adminToken,
      userId: who === "owner" ? A().ownerUserId : A().adminUserId,
      teamId: A().teamId,
      purpose: "LEGAL_HOLD_RELEASE",
      resourceKind: "evidence_legal_hold",
      resourceId: holdId,
    });

  const held = async (evidenceId: string) =>
    (await evaluateEffectiveLegalHold(prisma as never, { teamId: A().teamId, evidenceId })).held;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    stepUp = createStepUpCeremony({ prisma: prisma as never, inject: h.app.inject.bind(h.app) as never });
    for (const userId of [A().ownerUserId, A().adminUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: A().teamId } });
    }
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("one person cannot release: their own acknowledgement satisfies nothing", async () => {
    const { evidenceId, holdId } = await heldRecord(true);
    const res = await post(A().ownerToken, `/v1/lifecycle/legal-holds/${holdId}/release`, {
      releaseNote: "alone",
      approvalAcknowledged: true,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ denial: "RELEASE_APPROVAL_REQUIRED" });
    expect(await held(evidenceId)).toBe(true);
  });

  it("the requester cannot approve their own request", async () => {
    const { evidenceId, holdId } = await heldRecord(true);
    const asked = await post(A().ownerToken, `/v1/lifecycle/legal-holds/${holdId}/release-request`, {
      note: "matter closed",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const res = await post(
      A().ownerToken,
      `/v1/lifecycle/legal-holds/${holdId}/release-approval`,
      {},
      await header("owner", holdId),
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ denial: "RELEASE_REQUIRES_SECOND_PERSON" });
    const row = await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(row).toMatchObject({ releaseApprovalState: "PENDING", releaseApprovedByUserId: null });
    expect(await held(evidenceId)).toBe(true);
  });

  it("the approver cannot then release on their own approval", async () => {
    const { holdId } = await heldRecord(true);
    await post(A().ownerToken, `/v1/lifecycle/legal-holds/${holdId}/release-request`, { note: "matter closed" });
    const approved = await post(
      A().adminToken,
      `/v1/lifecycle/legal-holds/${holdId}/release-approval`,
      {},
      await header("admin", holdId),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    const res = await post(A().adminToken, `/v1/lifecycle/legal-holds/${holdId}/release`, { releaseNote: "me" });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ denial: "RELEASE_REQUIRES_SECOND_PERSON" });
  });

  it("POSITIVE: one asks, a second approves, the release records both people", async () => {
    const { evidenceId, holdId } = await heldRecord(true);
    await post(A().ownerToken, `/v1/lifecycle/legal-holds/${holdId}/release-request`, { note: "matter closed" });
    await post(
      A().adminToken,
      `/v1/lifecycle/legal-holds/${holdId}/release-approval`,
      {},
      await header("admin", holdId),
    );
    const res = await post(
      A().ownerToken,
      `/v1/lifecycle/legal-holds/${holdId}/release`,
      { releaseNote: "released with approval" },
      await header("owner", holdId),
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(row).toMatchObject({
      status: "RELEASED",
      releasedByUserId: A().ownerUserId,
      releaseApprovedByUserId: A().adminUserId,
      releaseRequestedByUserId: A().ownerUserId,
      releaseApprovalState: "APPROVED",
    });
    expect(await held(evidenceId)).toBe(false);
  });

  it("a hold not under approval releases as before, with its step-up", async () => {
    const { holdId } = await heldRecord(false);
    const res = await post(
      A().ownerToken,
      `/v1/lifecycle/legal-holds/${holdId}/release`,
      { releaseNote: "no approval needed" },
      await header("owner", holdId),
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(row).toMatchObject({ status: "RELEASED", releaseApprovalState: "NOT_REQUIRED" });
  });

  it("another workspace's hold reads as not found at both new steps", async () => {
    const foreign = await prisma.evidenceLegalHold.create({
      data: {
        teamId: h.fixtures.teamB.teamId,
        scope: "WORKSPACE",
        status: "ACTIVE",
        title: "foreign (fixture row)",
        reason: "gov-011",
        placedByUserId: h.fixtures.teamB.ownerUserId,
      } as never,
      select: { id: true },
    });
    const asked = await post(A().ownerToken, `/v1/lifecycle/legal-holds/${foreign.id}/release-request`, { note: "x" });
    expect(asked.statusCode, asked.body).toBe(404);
    const approved = await post(
      A().ownerToken,
      `/v1/lifecycle/legal-holds/${foreign.id}/release-approval`,
      {},
      await header("owner", foreign.id),
    );
    expect(approved.statusCode, approved.body).toBe(404);
  });
});
