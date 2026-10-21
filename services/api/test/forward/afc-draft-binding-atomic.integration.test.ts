/**
 * Independent forward audit closure — F-20. A web capture DRAFT is bound to
 * the record it reserves in the SAME transaction that creates the record: the
 * binding decides that the server template (not the client's plan) governs the
 * seal. A failure while binding must leave neither a record nor a half-bound
 * draft. Live PostgreSQL 16; the failure is injected by a temporary database
 * trigger on capture_session_events (the binding's own audit row).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

describe("F-20 — draft binding is atomic with record creation (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);
  afterAll(async () => {
    await prisma?.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "afc_f20_fail_bind" ON "capture_session_events"`).catch(() => null);
    await prisma?.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "afc_f20_fail_bind"()`).catch(() => null);
    await h?.cleanup();
  });

  async function draft() {
    const A = h.fixtures.teamA;
    const owner = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { ownerUserId: true } });
    const s = await prisma.captureSession.create({
      data: { ownerUserId: owner.ownerUserId, teamId: A.teamId, status: "DRAFT" } as never,
      select: { id: true },
    });
    return s.id;
  }
  const create = (captureSessionId: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
      payload: { type: "PHOTO", mimeType: "image/jpeg", teamId: h.fixtures.teamA.teamId, captureSessionId },
    });

  it("F-20: a record created with a draft is bound to it, with its audit row, in one commit", async () => {
    const sid = await draft();
    const res = await create(sid);
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sid }, select: { finalizedEvidenceId: true, status: true } });
    expect(session).toEqual({ finalizedEvidenceId: id, status: "DRAFT" });
    expect(await prisma.captureSessionEvent.count({ where: { sessionId: sid, payload: { path: ["evidenceId"], equals: id } } })).toBe(1);
    expect(res.json()).not.toHaveProperty("afterCommit");
  });

  it("F-20: a failure while binding leaves no record and no binding", async () => {
    const sid = await draft();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "afc_f20_fail_bind"() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."session_id" = '${sid}'::uuid THEN
          RAISE EXCEPTION 'injected draft-binding failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "afc_f20_fail_bind" ON "capture_session_events"`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "afc_f20_fail_bind" BEFORE INSERT ON "capture_session_events" FOR EACH ROW EXECUTE FUNCTION "afc_f20_fail_bind"()`);
    const before = new Date();
    try {
      const res = await create(sid);
      const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sid }, select: { finalizedEvidenceId: true } });
      const created = await prisma.evidence.findMany({
        where: { teamId: h.fixtures.teamA.teamId, createdAt: { gte: before }, deletedAt: null },
        select: { id: true },
      });
      // Either the whole creation committed with its binding and audit row, or
      // nothing did. Never a record whose draft binding silently failed.
      if (res.statusCode === 201) {
        expect(session.finalizedEvidenceId).toBe(res.json().id);
        expect(await prisma.captureSessionEvent.count({ where: { sessionId: sid } })).toBe(1);
      } else {
        expect(session.finalizedEvidenceId).toBeNull();
        expect(created).toEqual([]);
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "afc_f20_fail_bind" ON "capture_session_events"`);
    }
  });
});
