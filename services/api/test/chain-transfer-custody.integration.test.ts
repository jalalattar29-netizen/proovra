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

  // ===========================================================================
  // OBS-CHAIN-TRANSFER (closure phase 3) — acceptance consumes an OUTSTANDING
  // offer. Custody does not change at offer time (INITIATED only records the
  // offer; the records stay in the sending workspace), so the offer stands
  // only while the initiator still holds the transfer authority and every
  // record is still transferable. A refused acceptance writes nothing.
  // ===========================================================================
  describe("OBS-CHAIN-TRANSFER: the offer is re-checked at acceptance", () => {
    const states = async (evidenceId: string) =>
      (await transferEvents(evidenceId)).map((e) => (e.payload as { state: string }).state);
    const stateOf = async (transferId: string) =>
      (await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transferId }, select: { state: true, acceptedByUserId: true } }));

    /** A second OWNER-role member of team A: the only role that holds governance.exchange.manage. */
    async function initiatorMember() {
      const email = `obs-ct-${randomUUID().slice(0, 8)}@test.proovra.local`;
      const user = await prisma.user.create({
        data: { email, firstName: "Chain", lastName: "Initiator", provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
        select: { id: true },
      });
      const member = await prisma.teamMember.create({
        data: { teamId: h.fixtures.teamA.teamId, userId: user.id, role: "OWNER", status: "ACTIVE" },
        select: { id: true },
      });
      return { userId: user.id, memberId: member.id };
    }

    async function offer(initiatedByUserId: string, evidenceIds?: string[]) {
      const A = h.fixtures.teamA;
      const r = await record(A);
      const receiving = (await prisma.team.findUniqueOrThrow({ where: { id: h.fixtures.teamB.teamId }, select: { organizationId: true } }))
        .organizationId!;
      const ids = evidenceIds ?? [r.id];
      const init = await svc.initiateChainTransfer({
        teamId: A.teamId,
        fromOrganizationId: r.organizationId,
        toOrganizationId: receiving,
        evidenceIds: ids,
        initiatedByUserId,
      });
      if (!init.ok) throw new Error(init.denial);
      return { evidenceId: ids[0]!, transferId: init.transferId, organizationId: r.organizationId, receiving };
    }
    const accept = (transferId: string) =>
      svc.acceptChainTransfer({ teamId: h.fixtures.teamB.teamId, transferId, acceptingUserId: h.fixtures.teamB.ownerUserId });

    it("an initiator demoted, or suspended, after the offer: acceptance is refused (INITIATOR_AUTHORITY_ENDED) and nothing is written; restored, the same offer is accepted", async () => {
      const who = await initiatorMember();
      const { evidenceId, transferId } = await offer(who.userId);

      await prisma.teamMember.update({ where: { id: who.memberId }, data: { role: "MEMBER" } });
      expect(await accept(transferId)).toEqual({ ok: false, denial: "OFFER_NO_LONGER_VALID", reason: "INITIATOR_AUTHORITY_ENDED" });
      expect(await stateOf(transferId)).toEqual({ state: "INITIATED", acceptedByUserId: null });
      expect(await states(evidenceId)).toEqual(["INITIATED"]);

      await prisma.teamMember.update({ where: { id: who.memberId }, data: { role: "OWNER", status: "SUSPENDED" } });
      expect(await accept(transferId)).toEqual({ ok: false, denial: "OFFER_NO_LONGER_VALID", reason: "INITIATOR_AUTHORITY_ENDED" });
      expect(await states(evidenceId)).toEqual(["INITIATED"]);

      await prisma.teamMember.update({ where: { id: who.memberId }, data: { status: "ACTIVE" } });
      expect(await accept(transferId)).toEqual({ ok: true });
      expect(await states(evidenceId)).toEqual(["INITIATED", "ACCEPTED"]);
    });

    it("a record deleted after the offer is no longer transferable (RECORD_NOT_TRANSFERABLE); nothing is written", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, transferId } = await offer(A.ownerUserId);
      await prisma.evidence.update({ where: { id: evidenceId }, data: { deletedAt: new Date() } as never });
      expect(await accept(transferId)).toEqual({ ok: false, denial: "OFFER_NO_LONGER_VALID", reason: "RECORD_NOT_TRANSFERABLE" });
      expect(await stateOf(transferId)).toEqual({ state: "INITIATED", acceptedByUserId: null });
      expect(await states(evidenceId)).toEqual(["INITIATED"]);
    });

    it("a record placed under legal hold after the offer is refused (RECORD_UNDER_HOLD); released, the offer is accepted", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, transferId } = await offer(A.ownerUserId);
      const hold = await prisma.evidenceLegalHold.create({
        data: { teamId: A.teamId, evidenceId, scope: "EVIDENCE", title: "obs-ct hold", status: "ACTIVE", placedByUserId: A.ownerUserId } as never,
        select: { id: true },
      });
      expect(await accept(transferId)).toEqual({ ok: false, denial: "OFFER_NO_LONGER_VALID", reason: "RECORD_UNDER_HOLD" });
      expect(await states(evidenceId)).toEqual(["INITIATED"]);
      await prisma.evidenceLegalHold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAtUtc: new Date(), releasedByUserId: A.ownerUserId } as never,
      });
      expect(await accept(transferId)).toEqual({ ok: true });
    });

    it("a newer live transfer of the same record supersedes the older offer (SUPERSEDED); the newer one is accepted; once it is revoked the older one stands again", async () => {
      const A = h.fixtures.teamA;
      const older = await offer(A.ownerUserId);
      const newer = await offer(A.ownerUserId, [older.evidenceId]);
      expect(await accept(older.transferId)).toEqual({ ok: false, denial: "OFFER_NO_LONGER_VALID", reason: "SUPERSEDED" });
      expect(await stateOf(older.transferId)).toEqual({ state: "INITIATED", acceptedByUserId: null });

      expect(await accept(newer.transferId)).toEqual({ ok: true });

      expect(await svc.revokeChainTransfer({ teamId: A.teamId, transferId: newer.transferId, actorUserId: A.ownerUserId })).toEqual({ ok: true });
      expect(await accept(older.transferId)).toEqual({ ok: true });
    });

    it("L7: a newer transfer still INITIATED but past its expiry (no sweeper yet) does not supersede the older offer", async () => {
      const A = h.fixtures.teamA;
      const older = await offer(A.ownerUserId);
      const newer = await offer(A.ownerUserId, [older.evidenceId]);
      await prisma.chainTransfer.update({ where: { id: newer.transferId }, data: { expiresAtUtc: new Date(Date.now() - 60_000) } });
      expect((await stateOf(newer.transferId)).state).toBe("INITIATED");
      expect(await accept(older.transferId)).toEqual({ ok: true });
    });

    // -------------------------------------------------------------------------
    // M1 — the re-check and the claim are one serialised step. The seam runs
    // between the check and the claim; a concurrent hold / demotion started
    // there must either be seen by the check or land AFTER the acceptance.
    // -------------------------------------------------------------------------
    /** Waits until `done()` is true or a lock request is waiting (the writer is blocked). */
    async function settled(done: () => Promise<boolean>): Promise<"committed" | "blocked"> {
      for (let i = 0; i < 200; i += 1) {
        if (await done()) return "committed";
        const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(waiting[0]!.n) > 0) return "blocked";
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("the concurrent writer neither committed nor blocked");
    }

    it("M1: a legal hold placed between the check and the claim is never overtaken: it waits for the acceptance and is recorded AFTER it on the custody chain", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, transferId } = await offer(A.ownerUserId);
      const { placeCanonicalLegalHold } = await import("../src/services/governance/legal-hold.service.js");
      let placing: Promise<unknown> | null = null;
      let atClaim: "committed" | "blocked" | null = null;
      svc.chainTransferTestHooks.afterOfferCheck = async () => {
        placing = placeCanonicalLegalHold(
          { teamId: A.teamId, scope: "EVIDENCE", evidenceId, actorUserId: A.ownerUserId, title: "m1 race hold" } as never,
          prisma as never,
        );
        atClaim = await settled(async () => (await prisma.evidenceLegalHold.count({ where: { evidenceId, status: "ACTIVE" } })) > 0);
      };
      let result: unknown;
      try {
        result = await accept(transferId);
      } finally {
        svc.chainTransferTestHooks.afterOfferCheck = undefined;
      }
      await placing;
      // The hold committed before the claim and the transfer was accepted anyway: the TOCTOU.
      expect({ atClaim, result }).not.toEqual({ atClaim: "committed", result: { ok: true } });
      const chain = (await prisma.custodyEvent.findMany({ where: { evidenceId }, orderBy: { sequence: "asc" }, select: { eventType: true, payload: true } }))
        .map((e) => (e.eventType === "CHAIN_TRANSFER_CUSTODY_EXTENDED" ? `TRANSFER_${(e.payload as { state: string }).state}` : String(e.eventType)));
      const accepted = chain.indexOf("TRANSFER_ACCEPTED");
      const held = chain.findIndex((t) => /LEGAL_HOLD/.test(t));
      expect(held).toBeGreaterThanOrEqual(0);
      if (accepted >= 0) expect(accepted).toBeLessThan(held);
    });

    it("M1: an initiator demoted between the check and the claim is never overtaken: the demotion waits for the acceptance", async () => {
      const who = await initiatorMember();
      const { transferId } = await offer(who.userId);
      let demoting: Promise<unknown> | null = null;
      let atClaim: "committed" | "blocked" | null = null;
      svc.chainTransferTestHooks.afterOfferCheck = async () => {
        // A Prisma query is lazy: `.then` starts it now.
        demoting = prisma.teamMember.update({ where: { id: who.memberId }, data: { role: "MEMBER" } }).then((r) => r);
        atClaim = await settled(async () =>
          (await prisma.teamMember.findUniqueOrThrow({ where: { id: who.memberId }, select: { role: true } })).role === "MEMBER");
      };
      let result: unknown;
      try {
        result = await accept(transferId);
      } finally {
        svc.chainTransferTestHooks.afterOfferCheck = undefined;
      }
      await demoting;
      expect({ atClaim, result }).not.toEqual({ atClaim: "committed", result: { ok: true } });
      expect(atClaim).toBe("blocked");
    });

    it("M1: completion re-checks holds and transferability — a hold placed after acceptance, or a deleted record, refuses the completion and writes nothing", async () => {
      const A = h.fixtures.teamA;
      const pkg = (ids: string[]) =>
        prisma.evidenceExchangePackage.create({
          data: { teamId: A.teamId, kind: "EVIDENCE", state: "READY", evidenceIds: ids as never, createdByUserId: A.ownerUserId } as never,
          select: { id: true },
        });
      const held = await offer(A.ownerUserId);
      expect(await accept(held.transferId)).toEqual({ ok: true });
      await prisma.evidenceLegalHold.create({
        data: { teamId: A.teamId, evidenceId: held.evidenceId, scope: "EVIDENCE", title: "m1 complete hold", status: "ACTIVE", placedByUserId: A.ownerUserId } as never,
      });
      const p1 = await pkg([held.evidenceId]);
      expect(await svc.completeChainTransfer({ teamId: A.teamId, transferId: held.transferId, packageId: p1.id, actorUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_TRANSFERABLE",
        reason: "RECORD_UNDER_HOLD",
      });
      expect((await stateOf(held.transferId)).state).toBe("ACCEPTED");
      expect(await states(held.evidenceId)).toEqual(["INITIATED", "ACCEPTED"]);

      const gone = await offer(A.ownerUserId);
      expect(await accept(gone.transferId)).toEqual({ ok: true });
      await prisma.evidence.update({ where: { id: gone.evidenceId }, data: { deletedAt: new Date() } as never });
      const p2 = await pkg([gone.evidenceId]);
      expect(await svc.completeChainTransfer({ teamId: A.teamId, transferId: gone.transferId, packageId: p2.id, actorUserId: A.ownerUserId })).toEqual({
        ok: false,
        denial: "NOT_TRANSFERABLE",
        reason: "RECORD_NOT_TRANSFERABLE",
      });
      expect((await stateOf(gone.transferId)).state).toBe("ACCEPTED");
    });
  });
});
