/**
 * PRO-101 / WORKERS-03 and PRO-110 / WORKERS-12 — a legal hold protects every
 * record linked to the held case, and every record of the held workspace,
 * whatever the workspace kind.
 *
 * A Personal record may be stored with team_id NULL. The one hold evaluator
 * evaluated CASE and WORKSPACE holds only when the caller passed a teamId, and
 * every destructive caller passes the raw `Evidence.teamId`. The trash-grace
 * nomination saw no hold, and the purge job's canonical executor destroyed such
 * a record while its case hold was ACTIVE. Team-scoped sweep modes filtered on a
 * bare teamId and left the NULL-team record out altogether.
 *
 * Each case seeds the same owner, case and hold for a NULL-team record and for a
 * control record whose team_id is the Personal Space, plus another tenant's
 * record that must stay untouched.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateEffectiveLegalHold, executeEvidenceDestruction } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { versionedDestructionPort } from "./helpers/versioned-destruction-port.js";

const DAY = 86_400_000;

describe("legal holds reach Personal team_id NULL records (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let trashGrace: typeof import("../../worker/src/governance/trash-grace-reconciler.js");

  const P = () => h.fixtures.personal;
  const B = () => h.fixtures.teamB;

  const objects = new Set<string>();
  const port = versionedDestructionPort({
    exists: (id) => objects.has(id),
    remove: (id) => objects.delete(id),
    ids: () => [...objects],
  });

  const trashed = () => ({
    lifecycleState: "TRASHED",
    deletedAt: new Date(Date.now() - 40 * DAY),
    deletedAtUtc: new Date(Date.now() - 40 * DAY),
    deleteScheduledForUtc: new Date(Date.now() - 10 * DAY),
  });

  async function record(teamId: string | null, ownerUserId: string) {
    const organizationId = teamId
      ? (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId
      : null;
    const key = `pro-101/${randomUUID()}.bin`;
    const row = await prisma.evidence.create({
      data: {
        title: `PRO-101 ${key}`,
        type: "DOCUMENT",
        status: "CREATED",
        teamId,
        organizationId,
        ownerUserId,
        storageBucket: "pro-101-bucket",
        storageKey: key,
        ...trashed(),
      } as never,
      select: { id: true },
    });
    objects.add(`pro-101-bucket/${key}`);
    return row.id;
  }

  async function personalCase(evidenceIds: string[]) {
    const c = await prisma.case.create({
      data: { name: `PRO-101 case ${randomUUID().slice(0, 6)}`, teamId: P().teamId, ownerUserId: P().userId } as never,
      select: { id: true },
    });
    for (const evidenceId of evidenceIds) {
      await prisma.caseEvidenceLink.create({ data: { teamId: P().teamId, caseId: c.id, evidenceId } as never });
    }
    return c.id;
  }

  const hold = (scope: "CASE" | "WORKSPACE", caseId: string | null) =>
    prisma.evidenceLegalHold.create({
      data: {
        teamId: P().teamId,
        scope,
        caseId,
        status: "ACTIVE",
        title: `PRO-101 ${scope} hold`,
        placedByUserId: P().userId,
      } as never,
      select: { id: true },
    });

  const release = (id: string) =>
    prisma.evidenceLegalHold.update({ where: { id }, data: { status: "RELEASED" } as never });

  const lifecycle = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true, destroyedAtUtc: true } }));

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    trashGrace = await import("../../worker/src/governance/trash-grace-reconciler.js");
  }, 600_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("a CASE hold holds the NULL-team record exactly as it holds the team_id control", async () => {
    const nullTeam = await record(null, P().userId);
    const control = await record(P().teamId, P().userId);
    const caseId = await personalCase([nullTeam, control]);
    const caseHold = await hold("CASE", caseId);
    try {
      for (const [id, teamId] of [[nullTeam, null], [control, P().teamId]] as const) {
        const verdict = await evaluateEffectiveLegalHold(prisma as never, { teamId, evidenceId: id });
        expect(verdict.held, id).toBe(true);
        expect(verdict.reasonCode).toBe("CASE_HOLD");
        expect(verdict.holdIds).toContain(caseHold.id);
      }

      // The trash-grace nomination reads the same verdict for both.
      const dry = await trashGrace.runTrashGraceReconciliation({ dryRun: true, trigger: "pro-101", batchSize: 500 });
      for (const id of [nullTeam, control]) {
        const candidate = dry.candidates.find((c) => c.evidenceId === id);
        expect(candidate, id).toBeDefined();
        expect(candidate!.legalHold, id).toBe(true);
      }

      // The canonical executor's own re-check refuses the NULL-team record even
      // when a stale nomination says "not held": nothing is deleted.
      const before = objects.size;
      const refused = await executeEvidenceDestruction(
        prisma as never,
        { evidenceId: nullTeam, trigger: "purge_job", legalHold: false, destructionApprovalRequired: false },
        port,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.outcome).toBe("BLOCKED");
      expect(objects.size).toBe(before);
      expect(await lifecycle(nullTeam)).toMatchObject({ lifecycleState: "TRASHED", destroyedAtUtc: null });
    } finally {
      await release(caseHold.id);
    }

    // Positive control: once released, the same record is no longer held.
    expect((await evaluateEffectiveLegalHold(prisma as never, { teamId: null, evidenceId: nullTeam })).held).toBe(false);
  });

  it("a WORKSPACE hold on the Personal Space holds the NULL-team record; another tenant is not held", async () => {
    const nullTeam = await record(null, P().userId);
    const control = await record(P().teamId, P().userId);
    const foreign = await record(B().teamId, B().ownerUserId);
    const wsHold = await hold("WORKSPACE", null);
    try {
      for (const [id, teamId] of [[nullTeam, null], [control, P().teamId]] as const) {
        const verdict = await evaluateEffectiveLegalHold(prisma as never, { teamId, evidenceId: id });
        expect(verdict.held, id).toBe(true);
        expect(verdict.reasonCode).toBe("WORKSPACE_HOLD");
      }
      expect((await evaluateEffectiveLegalHold(prisma as never, { teamId: B().teamId, evidenceId: foreign })).held).toBe(false);

      const dry = await trashGrace.runTrashGraceReconciliation({ dryRun: true, trigger: "pro-101", batchSize: 500 });
      expect(dry.candidates.find((c) => c.evidenceId === nullTeam)?.legalHold).toBe(true);
      expect(dry.candidates.find((c) => c.evidenceId === foreign)?.legalHold).toBe(false);
    } finally {
      await release(wsHold.id);
    }
  });

  it("a Personal-Space-scoped sweep includes the NULL-team record and nothing of another tenant (PRO-110)", async () => {
    const nullTeam = await record(null, P().userId);
    const control = await record(P().teamId, P().userId);
    const foreign = await record(B().teamId, B().ownerUserId);

    const scoped = await trashGrace.runTrashGraceReconciliation({
      dryRun: true,
      teamId: P().teamId,
      trigger: "pro-110",
      batchSize: 500,
    });
    const ids = scoped.candidates.map((c) => c.evidenceId);
    expect(ids).toContain(nullTeam);
    expect(ids).toContain(control);
    expect(ids).not.toContain(foreign);
  });

  it("the purge path destroys the NULL-team record once no hold applies (positive control)", async () => {
    const nullTeam = await record(null, P().userId);
    const result = await executeEvidenceDestruction(
      prisma as never,
      { evidenceId: nullTeam, trigger: "purge_job", legalHold: false, destructionApprovalRequired: false },
      port,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await lifecycle(nullTeam)).lifecycleState).toBe("DESTROYED");
  });
});
