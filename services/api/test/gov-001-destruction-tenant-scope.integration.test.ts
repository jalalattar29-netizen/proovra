/**
 * GOV-001 — a destruction request may only ever name records of its own
 * workspace, and that is decided at create, approve, execute AND at the
 * canonical executor.
 *
 * KNOWN POSITIVE. Before the repair this suite failed: an OWNER of workspace A
 * created (201) and approved (200) a request naming workspace B's TRASHED record
 * and the executor ran against it. Each "refused" case below therefore asserts
 * the refusal REASON (a concealed 404 identical to an unknown id), plus that no
 * row, no state change and no custody event resulted, while the positive control
 * proves the same path destroys an eligible record of the caller's own
 * workspace, so a refusal here cannot be the path being dead.
 *
 * FIXTURES (labelled, not product paths):
 *   - FEATURE_DESTRUCTION_GOVERNANCE is written as an `entitlement_grants` row
 *     with source CUSTOM, the way a contract line would land it.
 *   - The approver's `governance.destruction.*` capability is a
 *     `member_capability_grants` row.
 *   - The "legacy request" rows are seeded directly: they stand for rows written
 *     before this repair, which is the only way a foreign id can still be on a
 *     request once create refuses it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeEvidenceDestruction } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

describe("GOV-001 destruction is tenant-scoped at every step (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let storage: (typeof import("../src/services/evidence/destruction-storage-port.js"))["apiEvidenceDestructionStorage"];
  let stepUp: ReturnType<typeof createStepUpCeremony>;

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  async function grantFeatureFixture(teamId: string) {
    await prisma.entitlementGrant.upsert({
      where: { teamId_key: { teamId, key: "FEATURE_DESTRUCTION_GOVERNANCE" } },
      update: { valueBool: true },
      create: {
        teamId,
        key: "FEATURE_DESTRUCTION_GOVERNANCE",
        kind: "FEATURE",
        valueBool: true,
        source: "CUSTOM",
        grantedAtUtc: new Date(),
        notes: "gov-001 test fixture",
      },
    });
  }

  async function grantCapabilityFixture(teamId: string, userId: string, permission: string) {
    const member = await prisma.teamMember.findFirstOrThrow({ where: { teamId, userId }, select: { id: true } });
    await prisma.memberCapabilityGrant.create({
      data: {
        teamMemberId: member.id,
        teamId,
        permission,
        grantedByUserId: A().ownerUserId,
        reason: "gov-001 test fixture",
      },
    });
  }

  async function trashedRecord(teamId: string, ownerUserId: string) {
    const past = new Date(Date.now() - 86_400_000);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "gov-001 record",
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

  const stepUpHeader = (user: "owner" | "admin", purpose: string, resourceId: string) =>
    stepUp.approvedHeader({
      token: user === "owner" ? A().ownerToken : A().adminToken,
      userId: user === "owner" ? A().ownerUserId : A().adminUserId,
      teamId: A().teamId,
      purpose,
      resourceKind: "destruction_request",
      resourceId,
    });

  async function assertUntouched(evidenceId: string) {
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { lifecycleState: true, destroyedAtUtc: true, destructionClaimedAtUtc: true },
    });
    expect(row).toEqual({ lifecycleState: "TRASHED", destroyedAtUtc: null, destructionClaimedAtUtc: null });
    expect(await prisma.custodyEvent.count({ where: { evidenceId } })).toBe(0);
    expect(await prisma.evidenceLifecycleEvent.count({ where: { evidenceId } })).toBe(0);
  }

  async function legacyRequest(state: string, evidenceIds: string[]) {
    return (
      await prisma.destructionRequest.create({
        data: {
          teamId: A().teamId,
          state,
          evidenceIds,
          reason: "legacy row naming a foreign record (fixture)",
          requestedByUserId: A().ownerUserId,
          approverUserIds: [
            { userId: A().adminUserId, approvedAtUtc: state === "APPROVED" ? new Date().toISOString() : null },
          ],
        },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ apiEvidenceDestructionStorage: storage } = await import(
      "../src/services/evidence/destruction-storage-port.js"
    ));
    stepUp = createStepUpCeremony({ prisma: prisma as never, inject: h.app.inject.bind(h.app) as never });
    for (const userId of [A().ownerUserId, A().adminUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: A().teamId } });
    }
    await grantFeatureFixture(A().teamId);
    await grantCapabilityFixture(A().teamId, A().adminUserId, "governance.destruction.approve");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("create: another workspace's id answers exactly like an unknown id, with no row and no custody", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const before = await prisma.destructionRequest.count();

    const payload = (id: string) => ({
      evidenceIds: [id],
      reason: "attempt",
      requiredApproverUserIds: [A().adminUserId],
    });
    const foreignRes = await post(A().ownerToken, "/v1/lifecycle/destruction/requests", payload(foreign.id));
    const unknownRes = await post(A().ownerToken, "/v1/lifecycle/destruction/requests", payload(randomUUID()));

    expect(foreignRes.statusCode, foreignRes.body).toBe(404);
    expect(foreignRes.json()).toEqual({ denial: "DESTRUCTION_EVIDENCE_NOT_FOUND" });
    expect(unknownRes.statusCode, unknownRes.body).toBe(404);
    expect(unknownRes.json()).toEqual(foreignRes.json());

    expect(await prisma.destructionRequest.count()).toBe(before);
    await assertUntouched(foreign.id);
  });

  it("create: a mixed list is refused whole; the own record is not requested either", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const own = await trashedRecord(A().teamId, A().ownerUserId);
    const before = await prisma.destructionRequest.count();
    const res = await post(A().ownerToken, "/v1/lifecycle/destruction/requests", {
      evidenceIds: [own.id, foreign.id],
      reason: "attempt",
      requiredApproverUserIds: [A().adminUserId],
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ denial: "DESTRUCTION_EVIDENCE_NOT_FOUND" });
    expect(await prisma.destructionRequest.count()).toBe(before);
    await assertUntouched(own.id);
    await assertUntouched(foreign.id);
  });

  it("approve: a legacy request naming a foreign record is refused and stays unapproved", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const id = await legacyRequest("REQUESTED", [foreign.id]);
    const res = await post(
      A().adminToken,
      `/v1/lifecycle/destruction/requests/${id}/approve`,
      {},
      await stepUpHeader("admin", "EVIDENCE_DESTRUCTION_APPROVE", id),
    );
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ denial: "DESTRUCTION_EVIDENCE_NOT_FOUND" });
    const row = await prisma.destructionRequest.findUniqueOrThrow({ where: { id } });
    expect(row.state).toBe("REQUESTED");
    expect(JSON.stringify(row.approverUserIds)).toContain('"approvedAtUtc":null');
    await assertUntouched(foreign.id);
  });

  it("execute: a legacy APPROVED request naming a foreign record is refused before the executor runs", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const id = await legacyRequest("APPROVED", [foreign.id]);
    const res = await post(
      A().ownerToken,
      `/v1/lifecycle/destruction/requests/${id}/execute`,
      {},
      await stepUpHeader("owner", "EVIDENCE_DESTRUCTION_EXECUTE", id),
    );
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ denial: "DESTRUCTION_EVIDENCE_NOT_FOUND" });
    const row = await prisma.destructionRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: "APPROVED", executedAtUtc: null, certifiedAtUtc: null });
    expect(await prisma.destructionCertificate.count({ where: { requestId: id } })).toBe(0);
    await assertUntouched(foreign.id);
  });

  it("the executor itself refuses a request of another workspace, however the caller got there", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const id = await legacyRequest("EXECUTING", [foreign.id]);
    const res = await executeEvidenceDestruction(
      prisma as never,
      {
        evidenceId: foreign.id,
        trigger: "destruction_request",
        actorUserId: A().ownerUserId,
        destructionRequestId: id,
        legalHold: false,
        objectLockExpected: false,
      },
      storage,
    );
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "DESTRUCTION_APPROVAL_REQUIRED" });
    await assertUntouched(foreign.id);
  });

  it("the executor refuses a review of another record or another workspace", async () => {
    const foreign = await trashedRecord(B().teamId, B().ownerUserId);
    const own = await trashedRecord(A().teamId, A().ownerUserId);
    const review = await prisma.destructionReview.create({
      data: {
        teamId: A().teamId,
        evidenceId: own.id,
        status: "APPROVED",
        reason: "manual_review",
        initiatedByUserId: A().ownerUserId,
        decidedByUserId: A().adminUserId,
        decidedAtUtc: new Date(),
        executionRequestedAtUtc: new Date(),
        executionRequestedByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    const res = await executeEvidenceDestruction(
      prisma as never,
      {
        evidenceId: foreign.id,
        trigger: "destruction_review",
        actorUserId: A().ownerUserId,
        destructionReviewId: review.id,
        legalHold: false,
        objectLockExpected: false,
      },
      storage,
    );
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "DESTRUCTION_APPROVAL_REQUIRED" });
    await assertUntouched(foreign.id);
  });

  it("the write routes carry the feature gate: a workspace without it is refused and nothing is written", async () => {
    await prisma.user.update({ where: { id: B().ownerUserId }, data: { currentWorkspaceId: B().teamId } });
    const before = await prisma.destructionRequest.count();
    const res = await post(B().ownerToken, "/v1/lifecycle/destruction/requests", {
      evidenceIds: [(await trashedRecord(B().teamId, B().ownerUserId)).id],
      reason: "no entitlement",
      requiredApproverUserIds: [B().adminUserId],
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_DESTRUCTION_GOVERNANCE" });
    expect(await prisma.destructionRequest.count()).toBe(before);
  });

  it("POSITIVE CONTROL: the same path destroys an eligible record of the caller's own workspace", async () => {
    const own = await trashedRecord(A().teamId, A().ownerUserId);
    const created = await post(A().ownerToken, "/v1/lifecycle/destruction/requests", {
      evidenceIds: [own.id],
      reason: "own record, retention over",
      requiredApproverUserIds: [A().adminUserId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { requestId: string }).requestId;

    const approved = await post(
      A().adminToken,
      `/v1/lifecycle/destruction/requests/${id}/approve`,
      {},
      await stepUpHeader("admin", "EVIDENCE_DESTRUCTION_APPROVE", id),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ state: "APPROVED", allApproved: true });

    const executed = await post(
      A().ownerToken,
      `/v1/lifecycle/destruction/requests/${id}/execute`,
      {},
      await stepUpHeader("owner", "EVIDENCE_DESTRUCTION_EXECUTE", id),
    );
    expect(executed.statusCode, executed.body).toBe(200);

    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: own.id },
      select: { lifecycleState: true, destroyedAtUtc: true },
    });
    expect(row.lifecycleState).toBe("DESTROYED");
    expect(row.destroyedAtUtc).not.toBeNull();
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId: own.id, eventType: "EVIDENCE_PURGED" } }),
    ).toBe(1);
    const cert = await prisma.destructionCertificate.findUniqueOrThrow({ where: { requestId: id } });
    expect(cert.evidenceCount).toBe(1);
  });
});
