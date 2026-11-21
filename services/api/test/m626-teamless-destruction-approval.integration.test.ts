/**
 * MATRIX-M626 (owner decision I, 2026-11-21) — a SEALED record stored with
 * team_id NULL is never destroyed merely because team_id is NULL: the executor,
 * the trash-grace reconciler and the purge job (all through
 * `resolveDestructionApproval`) need its own owner's explicit approval, and
 * every other boundary (grace, retention, Object Lock, legal hold, a separate
 * Enterprise approval) still decides. An UNSEALED abandoned upload keeps its
 * own expiry. Live PostgreSQL; storage is an in-memory disposable store.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeEvidenceDestruction, resolveDestructionApproval } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { versionedDestructionPort } from "./helpers/versioned-destruction-port.js";
import { seedExecutableReview } from "./support/executable-destruction-review.js";
import { seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

const DAY = 86_400_000;

describe("MATRIX-M626 — team-less sealed records need their owner's approval (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let trashGrace: typeof import("../../worker/src/governance/trash-grace-reconciler.js");
  let ownerApproval: typeof import("../src/services/evidence/owner-destruction-approval.service.js");
  let mint: (userId: string, email: string) => string;
  let deps: FixtureDeps;
  const tokens = new Map<string, string>();

  const objects = new Set<string>();
  const port = versionedDestructionPort({
    exists: (id) => objects.has(id),
    remove: (id) => objects.delete(id),
    ids: () => [...objects],
  });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    trashGrace = await import("../../worker/src/governance/trash-grace-reconciler.js");
    ownerApproval = await import("../src/services/evidence/owner-destruction-approval.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    mint = (userId, email) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET!,
        3600,
      );
    deps = { prisma: prisma as never, tag: `m626-${Date.now().toString(36)}`, mintToken: mint };
  }, 600_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  /** A legacy owner with NO workspace at all: nothing may be fabricated for them. */
  async function workspacelessOwner() {
    // seedUser creates the person, their current legal acceptances and a real
    // session, and no workspace.
    const u = await seedUser(deps, "owner");
    tokens.set(u.userId, u.token);
    return { id: u.userId, email: u.email };
  }

  /** A trashed record whose grace and application retention have elapsed. */
  async function record(input: {
    ownerUserId: string;
    teamId?: string | null;
    status?: "CREATED" | "UPLOADING" | "SIGNED" | "REPORTED";
    over?: Record<string, unknown>;
  }) {
    const teamId = input.teamId ?? null;
    const organizationId = teamId
      ? (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId
      : null;
    const key = `m626/${randomUUID()}.bin`;
    const row = await prisma.evidence.create({
      data: {
        title: `M626 ${key}`,
        type: "DOCUMENT",
        status: input.status ?? "SIGNED",
        teamId,
        organizationId,
        ownerUserId: input.ownerUserId,
        storageBucket: "m626-bucket",
        storageKey: key,
        lifecycleState: "TRASHED",
        deletedAt: new Date(Date.now() - 200 * DAY),
        deletedAtUtc: new Date(Date.now() - 200 * DAY),
        deleteScheduledForUtc: new Date(Date.now() - 110 * DAY),
        retentionUntilUtc: new Date(Date.now() - 5 * DAY),
        ...input.over,
      } as never,
      select: { id: true },
    });
    objects.add(`m626-bucket/${key}`);
    return { id: row.id, object: `m626-bucket/${key}` };
  }

  const state = async (id: string) =>
    prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true, destroyedAtUtc: true } });
  const destroy = (evidenceId: string) =>
    executeEvidenceDestruction(prisma as never, { evidenceId, trigger: "purge_job", legalHold: false }, port);
  const nominate = async (id: string) => {
    const report = await trashGrace.runTrashGraceReconciliation({ storage: port, dryRun: true, trigger: "m626", batchSize: 1000 });
    return report.candidates.find((c) => c.evidenceId === id);
  };

  it("a sealed team-less record without approval is not destroyed by the executor, the purge rule or the sweep", async () => {
    const owner = h.fixtures.personal.userId;
    for (const status of ["SIGNED", "REPORTED"] as const) {
      const rec = await record({ ownerUserId: owner, status });
      expect(await resolveDestructionApproval(prisma as never, { evidenceId: rec.id, teamId: null })).toMatchObject({
        required: true,
        approved: false,
      });
      const candidate = await nominate(rec.id);
      expect(candidate?.disposition, status).not.toMatch(/^ELIGIBLE/);
      const result = await destroy(rec.id);
      expect(result).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "DESTRUCTION_APPROVAL_REQUIRED" });
      expect(objects.has(rec.object)).toBe(true);
      expect(await state(rec.id)).toMatchObject({ lifecycleState: "TRASHED", destroyedAtUtc: null });
    }
  });

  it("with its owner's approval and retention elapsed it becomes eligible and is destroyed", async () => {
    const owner = await workspacelessOwner();
    const rec = await record({ ownerUserId: owner.id });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${rec.id}/owner-destruction-approval`,
      headers: { authorization: `Bearer ${tokens.get(owner.id)}` },
      payload: { confirm: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    // No workspace was invented for the owner.
    expect(await prisma.team.count({ where: { ownerUserId: owner.id } })).toBe(0);
    expect(await resolveDestructionApproval(prisma as never, { evidenceId: rec.id, teamId: null })).toMatchObject({
      required: true,
      approved: true,
      approvedByUserIds: [owner.id],
    });
    expect((await nominate(rec.id))?.disposition).toBe("ELIGIBLE_OBSERVE_ONLY");
    const result = await destroy(rec.id);
    expect(result).toMatchObject({ ok: true, outcome: "DESTROYED" });
    expect(objects.has(rec.object)).toBe(false);
    expect((await state(rec.id)).lifecycleState).toBe("DESTROYED");
  });

  it("the approval is the owner's, for this record and this trash cycle only — never retention, never another person", async () => {
    const owner = await workspacelessOwner();
    const stranger = await workspacelessOwner();

    // Retention not over: approval does not lift it.
    const retained = await record({ ownerUserId: owner.id, over: { retentionUntilUtc: new Date(Date.now() + 30 * DAY) } });
    expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: retained.id, actorUserId: owner.id })).toMatchObject({ ok: true });
    expect(await destroy(retained.id)).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "APP_RETENTION_ACTIVE" });
    expect(objects.has(retained.object)).toBe(true);

    // Someone else cannot approve it.
    const other = await record({ ownerUserId: owner.id });
    expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: other.id, actorUserId: stranger.id })).toEqual({
      ok: false,
      refusal: "NOT_FOUND",
    });
    const strangerRes = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${other.id}/owner-destruction-approval`,
      headers: { authorization: `Bearer ${tokens.get(stranger.id)}` },
      payload: { confirm: true },
    });
    expect(strangerRes.statusCode).toBe(404);
    expect(await destroy(other.id)).toMatchObject({ ok: false, reason: "DESTRUCTION_APPROVAL_REQUIRED" });

    // An approval from an earlier trash cycle does not carry over a restore.
    const cycled = await record({ ownerUserId: owner.id });
    await ownerApproval.approveOwnRecordDestruction({ evidenceId: cycled.id, actorUserId: owner.id });
    await prisma.evidence.update({
      where: { id: cycled.id },
      data: { deletedAt: new Date(Date.now() - 100 * DAY), deletedAtUtc: new Date(Date.now() - 100 * DAY) } as never,
    });
    expect(await destroy(cycled.id)).toMatchObject({ ok: false, reason: "DESTRUCTION_APPROVAL_REQUIRED" });

    // A withdrawn approval no longer counts.
    const withdrawn = await record({ ownerUserId: owner.id });
    await ownerApproval.approveOwnRecordDestruction({ evidenceId: withdrawn.id, actorUserId: owner.id });
    expect(await ownerApproval.withdrawOwnRecordDestructionApproval({ evidenceId: withdrawn.id, actorUserId: owner.id })).toEqual({
      ok: true,
      withdrawn: 1,
    });
    expect(await destroy(withdrawn.id)).toMatchObject({ ok: false, reason: "DESTRUCTION_APPROVAL_REQUIRED" });

    // The confirm flag is required.
    const unconfirmed = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${withdrawn.id}/owner-destruction-approval`,
      headers: { authorization: `Bearer ${tokens.get(owner.id)}` },
      payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);
  });

  it("a legal hold is never overridden by the owner's approval", async () => {
    const P = h.fixtures.personal;
    const rec = await record({ ownerUserId: P.userId });
    const c = await prisma.case.create({
      data: { name: `M626 case ${randomUUID().slice(0, 6)}`, teamId: P.teamId, ownerUserId: P.userId } as never,
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { teamId: P.teamId, caseId: c.id, evidenceId: rec.id } as never });
    const hold = await prisma.evidenceLegalHold.create({
      data: { teamId: P.teamId, scope: "CASE", caseId: c.id, status: "ACTIVE", title: "M626 hold", placedByUserId: P.userId } as never,
      select: { id: true },
    });
    try {
      expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: rec.id, actorUserId: P.userId })).toMatchObject({ ok: true });
      expect((await nominate(rec.id))?.legalHold).toBe(true);
      expect(await destroy(rec.id)).toMatchObject({ ok: false, outcome: "BLOCKED" });
      expect(objects.has(rec.object)).toBe(true);
      expect((await state(rec.id)).destroyedAtUtc).toBeNull();
    } finally {
      await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED" } as never });
    }
  });

  it("an Enterprise record needs its own governed approval; an owner approval is refused and does not count", async () => {
    const A = h.fixtures.teamA;
    const rec = await record({ ownerUserId: A.ownerUserId, teamId: A.teamId });
    expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: rec.id, actorUserId: A.ownerUserId })).toEqual({
      ok: false,
      refusal: "WORKSPACE_RECORD_USES_REVIEW",
    });
    expect(await prisma.evidenceOwnerDestructionApproval.count({ where: { evidenceId: rec.id } })).toBe(0);
    expect(await destroy(rec.id)).toMatchObject({ ok: false, reason: "DESTRUCTION_APPROVAL_REQUIRED" });
    expect(objects.has(rec.object)).toBe(true);
    await seedExecutableReview(prisma as never, rec.id);
    expect(await destroy(rec.id)).toMatchObject({ ok: true, outcome: "DESTROYED" });
  });

  it("an unsealed abandoned upload still expires under its existing rules, with no approval", async () => {
    const owner = await workspacelessOwner();
    for (const status of ["CREATED", "UPLOADING"] as const) {
      const rec = await record({ ownerUserId: owner.id, status, over: { retentionUntilUtc: null } });
      expect(await resolveDestructionApproval(prisma as never, { evidenceId: rec.id, teamId: null })).toMatchObject({
        required: false,
      });
      expect(await ownerApproval.approveOwnRecordDestruction({ evidenceId: rec.id, actorUserId: owner.id })).toEqual({
        ok: false,
        refusal: "UNSEALED_RECORD",
      });
      expect(await destroy(rec.id)).toMatchObject({ ok: true, outcome: "DESTROYED" });
      expect(objects.has(rec.object)).toBe(false);
    }
    // …and its grace window still protects it.
    const fresh = await record({
      ownerUserId: owner.id,
      status: "CREATED",
      over: { retentionUntilUtc: null, deleteScheduledForUtc: new Date(Date.now() + 10 * DAY) },
    });
    expect(await destroy(fresh.id)).toMatchObject({ ok: false, reason: "TRASH_GRACE_ACTIVE" });
    expect(objects.has(fresh.object)).toBe(true);
  });
});
