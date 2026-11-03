/**
 * ET-CUS-02 — chain-of-custody transfers reach the custody chain, and only for
 * the calling workspace's own evidence. Live PostgreSQL 16, the production
 * chain-transfer service.
 *
 * On a40ca76f every transfer appended an event type that did not exist in the
 * enum (the insert failed, the failure was swallowed): no hand-off ever reached
 * a custody chain. The evidence ids and the sending organisation came from the
 * request body and were never bound to the workspace.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("chain transfer custody (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/exchange/chain-transfer.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    svc = await import("../src/services/exchange/chain-transfer.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(fixture: { teamId: string; ownerUserId: string }) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: fixture.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `transfer ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: fixture.teamId, organizationId: team.organizationId, ownerUserId: fixture.ownerUserId } as never,
      select: { id: true },
    });
    return { id: ev.id, organizationId: team.organizationId! };
  }
  const transferEvents = (evidenceId: string) =>
    prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "CHAIN_TRANSFER_CUSTODY_EXTENDED" as never },
      orderBy: { sequence: "asc" },
      select: { payload: true },
    });

  it("each transition appends CHAIN_TRANSFER_CUSTODY_EXTENDED to every record, in order", async () => {
    const A = h.fixtures.teamA;
    const r1 = await record(A);
    const r2 = await record(A);
    const B = h.fixtures.teamB;
    const receiving = (await record(B)).organizationId;
    const init = await svc.initiateChainTransfer({
      teamId: A.teamId,
      fromOrganizationId: r1.organizationId,
      toOrganizationId: receiving,
      toOrganizationSlug: "receiving-org",
      evidenceIds: [r1.id, r2.id],
      initiatedByUserId: A.ownerUserId,
    });
    expect(init.ok).toBe(true);
    const transferId = (init as { transferId: string }).transferId;
    expect(await svc.acceptChainTransfer({ teamId: B.teamId, transferId, acceptingUserId: B.ownerUserId })).toEqual({ ok: true });
    // AZ-R2-02 (e0f257a50): the completing package must be one of A's own
    // exchange packages. Another tenant's package and an id that names nothing
    // are refused alike, and append nothing.
    const pkg = (kind: { teamId: string; ownerUserId: string }, evidenceIds: string[]) =>
      prisma.evidenceExchangePackage.create({
        data: { teamId: kind.teamId, kind: "EVIDENCE", state: "READY", evidenceIds: evidenceIds as never, createdByUserId: kind.ownerUserId } as never,
        select: { id: true },
      });
    const own = await pkg(A, [r1.id, r2.id]);
    const foreign = await pkg(B, []);
    for (const packageId of [foreign.id, randomUUID()]) {
      expect(await svc.completeChainTransfer({ teamId: A.teamId, transferId, packageId, actorUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_FOUND",
      });
    }
    expect(await transferEvents(r1.id)).toHaveLength(2);
    expect(
      await svc.completeChainTransfer({ teamId: A.teamId, transferId, packageId: own.id, actorUserId: A.ownerUserId }),
    ).toEqual({ ok: true });
    expect((await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transferId }, select: { packageId: true } })).packageId).toBe(own.id);
    for (const id of [r1.id, r2.id]) {
      const states = (await transferEvents(id)).map((e) => (e.payload as { state: string }).state);
      expect(states).toEqual(["INITIATED", "ACCEPTED", "COMPLETED"]);
    }
    // A second completion is refused and appends nothing.
    expect(await svc.completeChainTransfer({ teamId: A.teamId, transferId, packageId: own.id })).toEqual({ ok: false, denial: "INVALID_STATE" });
    expect(await transferEvents(r1.id)).toHaveLength(3);
  });

  it("refuses another workspace's evidence and another organisation, appending nothing", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const mine = await record(A);
    const theirs = await record(B);
    expect(
      await svc.initiateChainTransfer({
        teamId: A.teamId,
        fromOrganizationId: mine.organizationId,
        toOrganizationId: theirs.organizationId,
        toOrganizationSlug: "receiving-org",
        evidenceIds: [mine.id, theirs.id],
        initiatedByUserId: A.ownerUserId,
      }),
    ).toEqual({ ok: false, denial: "INVALID_EVIDENCE" });
    expect(
      await svc.initiateChainTransfer({
        teamId: A.teamId,
        fromOrganizationId: theirs.organizationId,
        toOrganizationId: mine.organizationId,
        toOrganizationSlug: "receiving-org",
        evidenceIds: [mine.id],
        initiatedByUserId: A.ownerUserId,
      }),
    ).toEqual({ ok: false, denial: "INVALID_ORGANIZATION" });
    expect(await transferEvents(theirs.id)).toHaveLength(0);
    expect(await transferEvents(mine.id)).toHaveLength(0);
  });

  describe("AUTHZ-007: acceptance is the recipient's act", () => {
    async function outgoing() {
      const A = h.fixtures.teamA;
      const r = await record(A);
      const receiving = (await record(h.fixtures.teamB)).organizationId;
      const init = await svc.initiateChainTransfer({
        teamId: A.teamId,
        fromOrganizationId: r.organizationId,
        toOrganizationId: receiving,
        evidenceIds: [r.id],
        initiatedByUserId: A.ownerUserId,
      });
      if (!init.ok) throw new Error(init.denial);
      return { evidenceId: r.id, transferId: init.transferId, receiving };
    }

    it("the sender cannot accept or reject its own transfer, and custody records nothing", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, transferId } = await outgoing();
      expect(await svc.acceptChainTransfer({ teamId: A.teamId, transferId, acceptingUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_FOUND",
      });
      expect(await svc.rejectChainTransfer({ teamId: A.teamId, transferId, rejectingUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_FOUND",
      });
      const row = await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transferId } });
      expect(row).toMatchObject({ state: "INITIATED", acceptedByUserId: null });
      expect((await transferEvents(evidenceId)).map((e) => (e.payload as { state: string }).state)).toEqual(["INITIATED"]);
    });

    it("a third organization reads it as not found", async () => {
      const { transferId } = await outgoing();
      const p = h.fixtures.personal;
      expect(await svc.acceptChainTransfer({ teamId: p.teamId, transferId, acceptingUserId: p.userId })).toEqual({
        ok: false,
        denial: "NOT_FOUND",
      });
    });

    it("POSITIVE: a member of the receiving organization accepts, and custody names that organization", async () => {
      const B = h.fixtures.teamB;
      const { evidenceId, transferId, receiving } = await outgoing();
      expect((await svc.listChainTransfers({ teamId: B.teamId, viewerUserId: B.ownerUserId })).find((t) => t.id === transferId)?.direction).toBe("INCOMING");
      expect(await svc.acceptChainTransfer({ teamId: B.teamId, transferId, acceptingUserId: B.ownerUserId })).toEqual({ ok: true });
      const accepted = (await transferEvents(evidenceId)).at(-1)!.payload as Record<string, unknown>;
      expect(accepted).toMatchObject({
        state: "ACCEPTED",
        actorUserId: B.ownerUserId,
        actorOrganizationId: receiving,
        toOrganizationId: receiving,
      });
    });

    it("a transfer to a made-up organization or to itself is refused", async () => {
      const A = h.fixtures.teamA;
      const r = await record(A);
      for (const toOrganizationId of [randomUUID(), r.organizationId]) {
        expect(
          await svc.initiateChainTransfer({
            teamId: A.teamId,
            fromOrganizationId: r.organizationId,
            toOrganizationId,
            evidenceIds: [r.id],
            initiatedByUserId: A.ownerUserId,
          }),
        ).toEqual({ ok: false, denial: "INVALID_ORGANIZATION" });
      }
      expect(await transferEvents(r.id)).toHaveLength(0);
    });

    it("a legacy transfer with no resolved recipient can no longer be accepted by anyone", async () => {
      const A = h.fixtures.teamA;
      const r = await record(A);
      const legacy = await prisma.chainTransfer.create({
        data: {
          teamId: A.teamId,
          fromOrganizationId: r.organizationId,
          toOrganizationSlug: "unresolved-org",
          evidenceIds: [r.id],
          state: "INITIATED",
          initiatedByUserId: A.ownerUserId,
        },
        select: { id: true },
      });
      expect(await svc.acceptChainTransfer({ teamId: A.teamId, transferId: legacy.id, acceptingUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_FOUND",
      });
    });
  });
});
