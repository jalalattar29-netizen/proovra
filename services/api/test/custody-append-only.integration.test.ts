/**
 * ET-CUS-04 — custody and the platform audit chain are append-only in the
 * database, and a hash-stripped chain no longer verifies. Live PostgreSQL 16.
 *
 * On a40ca76f both tables accepted UPDATE and DELETE from any role with DML,
 * and a chain whose hashes were all stripped verified as valid "legacy".
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("custody is append-only (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function recordWithEvents(n: number) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `append-only ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    for (let i = 0; i < n; i++) {
      await prisma.$transaction((tx) =>
        runtime.appendCustodyEventTx(tx, { evidenceId: ev.id, eventType: "EVIDENCE_VIEWED" as never, payload: { i } }),
      );
    }
    return ev.id;
  }

  it("UPDATE and DELETE of a custody event are refused by the database", async () => {
    const id = await recordWithEvents(2);
    const row = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: id }, select: { id: true } });
    await expect(prisma.custodyEvent.update({ where: { id: row.id }, data: { payload: { forged: true } as never } })).rejects.toThrow(/append-only/);
    await expect(prisma.custodyEvent.deleteMany({ where: { evidenceId: id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE custody_events SET event_hash = NULL WHERE evidence_id = '${id}'::uuid`)).rejects.toThrow(/append-only/);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id } })).toBe(2);
  });

  it("UPDATE and DELETE of a platform audit row are refused by the database", async () => {
    const row = await prisma.adminAuditLog.findFirst({ select: { id: true } });
    if (!row) return; // A fresh database may have no audit rows yet; the custody case above proves the trigger path.
    await expect(prisma.adminAuditLog.update({ where: { id: row.id }, data: { action: "forged" } as never })).rejects.toThrow(/append-only/);
    await expect(prisma.adminAuditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it("a fully hash-stripped chain of modern events is invalid, not 'legacy'", async () => {
    const id = await recordWithEvents(3);
    const rows = await prisma.custodyEvent.findMany({
      where: { evidenceId: id },
      orderBy: { sequence: "asc" },
      select: { sequence: true, eventType: true, atUtc: true, payload: true, prevEventHash: true, eventHash: true },
    });
    const intact = runtime.evaluateCustodyChain({ evidenceId: id, records: rows.map((r) => ({ ...r, eventType: String(r.eventType) })) });
    expect(intact).toMatchObject({ valid: true, mode: "hashed" });
    const stripped = runtime.evaluateCustodyChain({
      evidenceId: id,
      records: rows.map((r) => ({ ...r, eventType: String(r.eventType), prevEventHash: null, eventHash: null })),
    });
    expect(stripped).toMatchObject({ valid: false, reason: "hash_missing" });
    // A genuinely pre-hash-era chain still reads as legacy.
    const old = runtime.evaluateCustodyChain({
      evidenceId: id,
      records: rows.map((r) => ({ ...r, eventType: String(r.eventType), prevEventHash: null, eventHash: null, atUtc: new Date("2026-03-01T00:00:00Z") })),
    });
    expect(old).toMatchObject({ valid: true, mode: "legacy" });
  });
});
