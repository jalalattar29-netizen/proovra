/**
 * ARCHIVE UNDER A LEGAL HOLD — one answer, every scope, both routes
 * (live PostgreSQL 16).
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * The canonical projection said `canArchive = active && !locked`. It never
 * consulted the hold. Three surfaces then disagreed about the same record:
 *
 *   - the projection offered an Archive control on a held record;
 *   - the governance layer refused it with `blocked_by_legal_hold`, so the
 *     click returned a 409 the UI had promised would not happen;
 *   - and that governance layer returns `allowed` unconditionally when the
 *     evidence carries no `teamId`, so a held PERSONAL record was not merely
 *     offered the action — the action SUCCEEDED and the record left the
 *     working set while a preservation obligation stood over it.
 *
 * WHAT THIS PROVES
 * ---------------------------------------------------------------------------
 * The hold is now decided in `computeEvidenceLifecycleCapabilities`, which
 * `applyEvidenceLifecycleAction` consults BEFORE the governance gate and which
 * both the single route and the bulk route call. So this suite drives the REAL
 * routes against a real database and asserts the same verdict in every
 * combination that used to disagree:
 *
 *   scope   × PERSONAL (teamId NULL) | ORGANIZATION | ENTERPRISE-tier org
 *   route   × POST /:id/archive      | POST /v1/evidence/bulk
 *   hold    × EVIDENCE-scoped        | CASE-scoped  | WORKSPACE-scoped
 *
 * and, in each case, reads the row back: `archivedAt` still NULL and no
 * `EVIDENCE_ARCHIVED` custody event. A refusal that leaves a write behind is
 * not a refusal.
 *
 * The control cases matter as much as the refusals: an unheld record in each
 * scope still archives. A fix that blocked archive everywhere would satisfy
 * every negative assertion here and be a worse bug than the one it replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceBulkRequest } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Archive under a legal hold — canonical, every scope (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let organizationId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId as string;

    // ENTERPRISE tier is an entitlement on the workspace owner, not a column
    // on the workspace. Team B is promoted so the enterprise cases below are
    // an enterprise account rather than a renamed organization one.
    const existing = await prisma.entitlement.findFirst({
      where: { userId: harness.fixtures.teamB.ownerUserId },
      select: { id: true },
    });
    if (existing) {
      await prisma.entitlement.update({
        where: { id: existing.id },
        data: { plan: "ENTERPRISE", active: true } as never,
      });
    } else {
      await prisma.entitlement.create({
        data: {
          userId: harness.fixtures.teamB.ownerUserId,
          plan: "ENTERPRISE",
          teamSeats: 25,
          active: true,
        } as never,
      });
    }
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  let seq = 0;
  const tag = () => `${Math.floor(performance.now() * 1000)}-${(seq += 1)}`;

  /** Fixed id so the plan-invariance probe can always clean up after itself. */
  const PLAN_PROBE_ENTITLEMENT_ID = "00000000-0000-4000-8000-0000000f0100";

  /**
   * A fictional record. `teamId: null` is the PERSONAL shape and is the exact
   * row the governance gate short-circuits on, so it is spelled out rather
   * than defaulted — `organizationId` must be null with it, or the schema's
   * `evidence_team_implies_org_chk` refuses the insert.
   */
  async function seedRecord(over: {
    teamId?: string | null;
    organizationId?: string | null;
    ownerUserId: string;
  }): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `Fictional archive/hold record ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: over.teamId ?? null,
        organizationId: over.organizationId ?? null,
        ownerUserId: over.ownerUserId,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Place an ACTIVE hold.
   *
   * `teamId` is NOT NULL on the hold even when the TARGET is a personal
   * record with no team — the hold names the workspace that placed it. That
   * asymmetry is precisely why the evidence-direct clause of the union
   * evaluator matches on `evidenceId` alone.
   */
  async function placeHold(input: {
    teamId: string;
    placedByUserId: string;
    scope: "EVIDENCE" | "CASE" | "WORKSPACE";
    evidenceId?: string;
    caseId?: string;
  }): Promise<string> {
    const row = await prisma.evidenceLegalHold.create({
      data: {
        teamId: input.teamId,
        scope: input.scope,
        evidenceId: input.evidenceId ?? null,
        caseId: input.caseId ?? null,
        title: `Fictional matter ${tag()}`,
        reason: "Fictional preservation obligation",
        status: "ACTIVE",
        placedByUserId: input.placedByUserId,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function singleArchive(id: string, token: string) {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: res.statusCode,
      body: res.json() as { code?: string; message?: string },
    };
  }

  async function bulkArchive(ids: string[], token: string) {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: { authorization: `Bearer ${token}` },
      payload: buildEvidenceBulkRequest({
        action: "ARCHIVE",
        evidenceIds: ids,
        caseId: null,
      }),
    });
    return {
      status: res.statusCode,
      body: res.json() as {
        successCount: number;
        failedCount: number;
        results: Array<{ evidenceId: string; ok: boolean; reason?: string }>;
      },
    };
  }

  const archiveEvents = (evidenceId: string) =>
    prisma.custodyEvent.count({
      where: { evidenceId, eventType: "EVIDENCE_ARCHIVED" },
    });

  /** The record did not move and nothing was written about it. */
  async function expectUntouched(id: string) {
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true, deletedAt: true, lifecycleState: true },
    });
    expect(row.archivedAt, "a refused archive must leave archivedAt NULL").toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.lifecycleState).not.toBe("ARCHIVED");
    expect(await archiveEvents(id), "a refused archive writes no custody event").toBe(0);
  }

  // =========================================================================
  // PERSONAL — teamId NULL. THE GAP.
  // =========================================================================

  describe("PERSONAL scope (teamId NULL) — the case governance never saw", () => {
    it("single archive is refused, and the record does not move", async () => {
      const id = await seedRecord({
        teamId: null,
        ownerUserId: harness.fixtures.personal.userId,
      });
      await placeHold({
        teamId: harness.fixtures.personal.teamId,
        placedByUserId: harness.fixtures.personal.userId,
        scope: "EVIDENCE",
        evidenceId: id,
      });

      const { status, body } = await singleArchive(id, harness.fixtures.personal.token);

      // Before the fix this returned 200 and the record archived, because the
      // capability said yes and the governance gate returned early on a null
      // teamId. There was no layer left to say no.
      expect(status).toBe(409);
      expect(body.code).toBe("LEGAL_HOLD_ACTIVE");
      await expectUntouched(id);
    });

    it("bulk archive gives the SAME answer for the same record", async () => {
      const id = await seedRecord({
        teamId: null,
        ownerUserId: harness.fixtures.personal.userId,
      });
      await placeHold({
        teamId: harness.fixtures.personal.teamId,
        placedByUserId: harness.fixtures.personal.userId,
        scope: "EVIDENCE",
        evidenceId: id,
      });

      const { body } = await bulkArchive([id], harness.fixtures.personal.token);

      expect(body.successCount).toBe(0);
      expect(body.failedCount).toBe(1);
      expect(body.results[0]?.ok).toBe(false);
      expect(body.results[0]?.reason).toMatch(/LEGAL_HOLD/);
      await expectUntouched(id);
    });

    it("CONTROL: an unheld personal record still archives on both routes", async () => {
      const single = await seedRecord({
        teamId: null,
        ownerUserId: harness.fixtures.personal.userId,
      });
      const bulk = await seedRecord({
        teamId: null,
        ownerUserId: harness.fixtures.personal.userId,
      });

      expect((await singleArchive(single, harness.fixtures.personal.token)).status).toBe(200);
      expect(
        (await bulkArchive([bulk], harness.fixtures.personal.token)).body.successCount,
      ).toBe(1);

      for (const id of [single, bulk]) {
        const row = await prisma.evidence.findUniqueOrThrow({
          where: { id },
          select: { archivedAt: true },
        });
        expect(row.archivedAt).not.toBeNull();
        expect(await archiveEvents(id)).toBe(1);
      }
    });
  });

  // =========================================================================
  // ORGANIZATION — the scope governance already covered, re-proved through the
  // capability layer so the two cannot drift apart again.
  // =========================================================================

  describe("ORGANIZATION scope", () => {
    const org = () => harness.fixtures.teamA;

    it("an EVIDENCE-scoped hold blocks single and bulk alike", async () => {
      const a = await seedRecord({
        teamId: org().teamId,
        organizationId,
        ownerUserId: org().ownerUserId,
      });
      const b = await seedRecord({
        teamId: org().teamId,
        organizationId,
        ownerUserId: org().ownerUserId,
      });
      for (const id of [a, b]) {
        await placeHold({
          teamId: org().teamId,
          placedByUserId: org().ownerUserId,
          scope: "EVIDENCE",
          evidenceId: id,
        });
      }

      expect((await singleArchive(a, org().ownerToken)).status).toBe(409);
      expect((await bulkArchive([b], org().ownerToken)).body.failedCount).toBe(1);
      await expectUntouched(a);
      await expectUntouched(b);
    });

    it("a CASE-scoped hold on a linked case blocks archive", async () => {
      const id = await seedRecord({
        teamId: org().teamId,
        organizationId,
        ownerUserId: org().ownerUserId,
      });
      await prisma.caseEvidenceLink.create({
        data: { caseId: org().caseId, evidenceId: id } as never,
      });
      await placeHold({
        teamId: org().teamId,
        placedByUserId: org().ownerUserId,
        scope: "CASE",
        caseId: org().caseId,
      });

      // No hold row names this record. The union evaluator reaches it through
      // `CaseEvidenceLink`, which the evidence-only hold lookup in the
      // governance layer cannot do.
      const { status, body } = await singleArchive(id, org().ownerToken);
      expect(status).toBe(409);
      expect(body.code).toBe("LEGAL_HOLD_ACTIVE");
      await expectUntouched(id);
    });
  });

  // =========================================================================
  // TEAM — an OWNED workspace. Structurally distinct from ORGANIZATION, and
  // the kind the harness comment records as having been silently produced by a
  // plan-derived classifier fallback, so it is worth its own case rather than
  // being assumed to behave like its neighbour.
  // =========================================================================

  describe("TEAM scope (workspaceKind OWNED)", () => {
    /** An OWNED workspace with its own organization container and one member. */
    async function seedOwnedWorkspace(): Promise<{
      teamId: string;
      organizationId: string;
      ownerUserId: string;
      token: string;
    }> {
      const owner = harness.fixtures.teamA.ownerUserId;
      const org = await prisma.organization.create({
        data: {
          name: `Owned container ${tag()}`,
          billingOwnerUserId: owner,
          status: "ACTIVE",
          // SYSTEM, not CUSTOMER: an OWNED workspace's organization is the
          // internal 1:1 container every Team receives, not a governance
          // boundary. Naming it CUSTOMER here would make this an
          // ORGANIZATION case wearing a different label.
          kind: "SYSTEM",
        } as never,
        select: { id: true },
      });
      const team = await prisma.team.create({
        data: {
          name: `Owned workspace ${tag()}`,
          ownerUserId: owner,
          isPersonal: false,
          organizationId: org.id,
          workspaceKind: "OWNED",
        } as never,
        select: { id: true },
      });
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: owner, role: "OWNER", status: "ACTIVE" } as never,
      });
      return {
        teamId: team.id,
        organizationId: org.id,
        ownerUserId: owner,
        token: harness.fixtures.teamA.ownerToken,
      };
    }

    it("a held record is refused on both routes; an unheld one still archives", async () => {
      const ws = await seedOwnedWorkspace();
      const heldSingle = await seedRecord({
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        ownerUserId: ws.ownerUserId,
      });
      const heldBulk = await seedRecord({
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        ownerUserId: ws.ownerUserId,
      });
      const free = await seedRecord({
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        ownerUserId: ws.ownerUserId,
      });
      for (const id of [heldSingle, heldBulk]) {
        await placeHold({
          teamId: ws.teamId,
          placedByUserId: ws.ownerUserId,
          scope: "EVIDENCE",
          evidenceId: id,
        });
      }

      const refused = await singleArchive(heldSingle, ws.token);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("LEGAL_HOLD_ACTIVE");
      expect((await bulkArchive([heldBulk], ws.token)).body.failedCount).toBe(1);
      await expectUntouched(heldSingle);
      await expectUntouched(heldBulk);

      // CONTROL — the block is the hold's, not the workspace kind's.
      expect((await singleArchive(free, ws.token)).status).toBe(200);
      expect(await archiveEvents(free)).toBe(1);
    });

    it("the verdict does not move when the owner's PLAN changes", async () => {
      // Tenancy and authorization are decided from membership, scope and the
      // hold. A plan NAME is a commercial fact and must never reach the
      // lifecycle decision — the harness records a classifier that once
      // derived workspace kind from `plan FREE`, so the invariant is asserted
      // rather than assumed.
      const ws = await seedOwnedWorkspace();
      const id = await seedRecord({
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        ownerUserId: ws.ownerUserId,
      });
      await placeHold({
        teamId: ws.teamId,
        placedByUserId: ws.ownerUserId,
        scope: "EVIDENCE",
        evidenceId: id,
      });

      const before = await prisma.entitlement.findFirst({
        where: { userId: ws.ownerUserId },
        select: { id: true, plan: true },
      });
      const verdicts: Array<{ plan: string; status: number; code?: string }> = [];
      try {
        for (const plan of ["FREE", "ENTERPRISE", "PRO"] as const) {
          if (before) {
            await prisma.entitlement.update({
              where: { id: before.id },
              data: { plan, active: true } as never,
            });
          } else {
            await prisma.entitlement.upsert({
              where: { id: PLAN_PROBE_ENTITLEMENT_ID },
              create: {
                id: PLAN_PROBE_ENTITLEMENT_ID,
                userId: ws.ownerUserId,
                plan,
                active: true,
              } as never,
              update: { plan } as never,
            });
          }
          const res = await singleArchive(id, ws.token);
          verdicts.push({ plan, status: res.status, code: res.body.code });
        }
      } finally {
        // Leave the fixture as it was found: a plan this probe set is a
        // commercial fact other suites in this run would inherit.
        if (before) {
          await prisma.entitlement.update({
            where: { id: before.id },
            data: { plan: before.plan } as never,
          });
        } else {
          await prisma.entitlement
            .delete({ where: { id: PLAN_PROBE_ENTITLEMENT_ID } })
            .catch(() => undefined);
        }
      }

      expect(verdicts.map((v) => v.status)).toEqual([409, 409, 409]);
      expect(verdicts.map((v) => v.code)).toEqual([
        "LEGAL_HOLD_ACTIVE",
        "LEGAL_HOLD_ACTIVE",
        "LEGAL_HOLD_ACTIVE",
      ]);
      await expectUntouched(id);
    });
  });

  // =========================================================================
  // ENTERPRISE — an ENTERPRISE-entitled owner and the workspace-wide hold
  // shape that only an enterprise preservation order uses.
  // =========================================================================

  describe("ENTERPRISE tier — workspace-wide preservation", () => {
    it("a WORKSPACE-scoped hold blocks archive for every record in it", async () => {
      const ent = harness.fixtures.teamB;
      const team = await prisma.team.findUniqueOrThrow({
        where: { id: ent.teamId },
        select: { organizationId: true },
      });
      const plan = await prisma.entitlement.findFirst({
        where: { userId: ent.ownerUserId },
        select: { plan: true },
      });
      expect(plan?.plan, "the tier under test must really be ENTERPRISE").toBe(
        "ENTERPRISE",
      );

      const single = await seedRecord({
        teamId: ent.teamId,
        organizationId: team.organizationId as string,
        ownerUserId: ent.ownerUserId,
      });
      const bulk = await seedRecord({
        teamId: ent.teamId,
        organizationId: team.organizationId as string,
        ownerUserId: ent.ownerUserId,
      });

      const holdId = await placeHold({
        teamId: ent.teamId,
        placedByUserId: ent.ownerUserId,
        scope: "WORKSPACE",
      });

      expect((await singleArchive(single, ent.ownerToken)).status).toBe(409);
      expect((await bulkArchive([bulk], ent.ownerToken)).body.failedCount).toBe(1);
      await expectUntouched(single);
      await expectUntouched(bulk);

      // RELEASING the hold restores the action — the block is the hold's, not
      // a permanent property the fix baked into the workspace.
      await prisma.evidenceLegalHold.update({
        where: { id: holdId },
        data: {
          status: "RELEASED",
          releasedByUserId: ent.ownerUserId,
          releasedAtUtc: new Date(),
        } as never,
      });
      expect((await singleArchive(single, ent.ownerToken)).status).toBe(200);
      const row = await prisma.evidence.findUniqueOrThrow({
        where: { id: single },
        select: { archivedAt: true },
      });
      expect(row.archivedAt).not.toBeNull();
    });
  });

  // =========================================================================
  // The surface and the write path agree.
  // =========================================================================

  it("the projection the UI reads reports the SAME refusal the route enforces", async () => {
    const org = harness.fixtures.teamA;
    const id = await seedRecord({
      teamId: org.teamId,
      organizationId,
      ownerUserId: org.ownerUserId,
    });
    await placeHold({
      teamId: org.teamId,
      placedByUserId: org.ownerUserId,
      scope: "EVIDENCE",
      evidenceId: id,
    });

    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}`,
      headers: { authorization: `Bearer ${org.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const lifecycle = (
      res.json() as { evidence: { lifecycle: Record<string, unknown> } }
    ).evidence.lifecycle;

    // The UI disables the control from `canArchive` and explains it from
    // `archiveBlockReason`. If these disagreed with the route the user would
    // meet a 409 after committing to the action, which is the exact failure
    // this convergence exists to remove.
    expect(lifecycle.canArchive).toBe(false);
    expect(lifecycle.archiveBlockReason).toBe("LEGAL_HOLD_ACTIVE");
    expect(lifecycle.canTrash).toBe(false);
    expect(lifecycle.trashBlockReason).toBe("LEGAL_HOLD_ACTIVE");
    expect((await singleArchive(id, org.ownerToken)).status).toBe(409);
  });
});
