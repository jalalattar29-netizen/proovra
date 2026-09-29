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
    const init = await svc.initiateChainTransfer({
      teamId: A.teamId,
      fromOrganizationId: r1.organizationId,
      toOrganizationSlug: "receiving-org",
      evidenceIds: [r1.id, r2.id],
      initiatedByUserId: A.ownerUserId,
    });
    expect(init.ok).toBe(true);
    const transferId = (init as { transferId: string }).transferId;
    expect(await svc.acceptChainTransfer({ teamId: A.teamId, transferId, acceptingUserId: A.ownerUserId })).toEqual({ ok: true });
    expect(
      await svc.completeChainTransfer({ teamId: A.teamId, transferId, packageId: randomUUID(), actorUserId: A.ownerUserId }),
    ).toEqual({ ok: true });
    for (const id of [r1.id, r2.id]) {
      const states = (await transferEvents(id)).map((e) => (e.payload as { state: string }).state);
      expect(states).toEqual(["INITIATED", "ACCEPTED", "COMPLETED"]);
    }
    // A second completion is refused and appends nothing.
    expect(await svc.completeChainTransfer({ teamId: A.teamId, transferId, packageId: randomUUID() })).toEqual({ ok: false, denial: "INVALID_STATE" });
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
        toOrganizationSlug: "receiving-org",
        evidenceIds: [mine.id, theirs.id],
        initiatedByUserId: A.ownerUserId,
      }),
    ).toEqual({ ok: false, denial: "INVALID_EVIDENCE" });
    expect(
      await svc.initiateChainTransfer({
        teamId: A.teamId,
        fromOrganizationId: theirs.organizationId,
        toOrganizationSlug: "receiving-org",
        evidenceIds: [mine.id],
        initiatedByUserId: A.ownerUserId,
      }),
    ).toEqual({ ok: false, denial: "INVALID_ORGANIZATION" });
    expect(await transferEvents(theirs.id)).toHaveLength(0);
    expect(await transferEvents(mine.id)).toHaveLength(0);
  });
});
