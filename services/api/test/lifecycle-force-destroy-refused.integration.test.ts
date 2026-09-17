/**
 * D1 — the admin lifecycle override cannot mark a record DESTROYED.
 *
 * POST /v1/governance/lifecycle/evidence/:id/transition moves the lifecycle
 * pointer and never touches storage. Accepting toState DESTROYED produced a
 * record that read as destroyed while every file stayed in the bucket and
 * stayed downloadable. Destruction happens only by executing an approved
 * destruction review, whose executor deletes and verifies the objects first.
 *
 * The positive setup is complete on purpose — an Enterprise workspace, a
 * record already PENDING_DESTRUCTION, and a step-up approved by the owner's
 * authenticator — so the only thing standing between the owner and a
 * DESTROYED pointer is the refusal under test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("D1 — forcing DESTROYED is refused (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let secret: Buffer;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const a = harness.fixtures.teamA;
    await prisma.team.update({
      where: { id: a.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId: a.ownerUserId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "d1-force-destroy",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
  }, 180_000);
  afterAll(async () => {
    await prisma?.mfaFactor.deleteMany({ where: { label: "d1-force-destroy" } }).catch(() => undefined);
    await harness?.cleanup();
  });

  async function pendingDestruction(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: "D1 force-destroy target",
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        lifecycleState: "PENDING_DESTRUCTION",
      },
      select: { id: true },
    });
  }

  async function ownerStepUp(evidenceId: string): Promise<string> {
    const a = harness.fixtures.teamA;
    const started = await harness.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: auth(a.ownerToken),
      payload: { teamId: a.teamId, purpose: "EVIDENCE_LIFECYCLE_FORCE", resourceKind: "evidence", resourceId: evidenceId },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    await prisma.mfaFactor.updateMany({ where: { userId: a.ownerUserId, kind: "TOTP" }, data: { lastUsedAt: null } });
    const code = totp.computeTotpCode(secret, totp.timeStep(Math.floor(Date.now() / 1000)));
    const checked = await harness.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      headers: auth(a.ownerToken),
      payload: { teamId: a.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  it("an Enterprise owner with an approved step-up still cannot force DESTROYED; the record is unchanged", async () => {
    const a = harness.fixtures.teamA;
    const ev = await pendingDestruction(a.teamId, a.ownerUserId);
    const challengeId = await ownerStepUp(ev.id);

    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/governance/lifecycle/evidence/${ev.id}/transition`,
      headers: { ...auth(a.ownerToken), "x-proovra-step-up-challenge-id": challengeId },
      payload: { teamId: a.teamId, toState: "DESTROYED", summary: "D1 probe" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW" },
      canonical: "/v1/governance/destruction-reviews",
    });

    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: ev.id },
      select: { lifecycleState: true, deletedAt: true },
    });
    expect(row.lifecycleState).toBe("PENDING_DESTRUCTION");
    expect(row.deletedAt).toBeNull();
    expect(
      await prisma.evidenceLifecycleEvent.count({ where: { evidenceId: ev.id, toState: "DESTROYED" } }),
    ).toBe(0);
  });

  it("another tenant is still concealed before the state is considered", async () => {
    const a = harness.fixtures.teamA;
    const b = harness.fixtures.teamB;
    const ev = await pendingDestruction(a.teamId, a.ownerUserId);
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/governance/lifecycle/evidence/${ev.id}/transition`,
      headers: auth(b.ownerToken),
      payload: { teamId: a.teamId, toState: "DESTROYED", summary: "D1 probe" },
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain("LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW");
  });
});
