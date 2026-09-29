/**
 * ET-UPL-02 / ET-UPL-03 — upload-session idempotency and terminal sessions.
 * Live PostgreSQL 16, the real service.
 *
 * On a40ca76f:
 *   ET-UPL-03 — an idempotency key collapsed onto ANY session of the team with
 *     that key, so a member who pre-created capture:<X>:<i> for their own
 *     record Y diverted the victim's upload for X to Y's storage key.
 *   ET-UPL-02 — one ABORTED/EXPIRED session blocked its record's finalization
 *     forever; the retry got the dead session back through its key; and any
 *     team member could abort another member's session.
 *   ET-UPL-05 — the parts-state CHECK admitted only VERIFIED as a settled
 *     state, so there was no truthful state for a server-hashed part that
 *     matched no declared reference.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("upload-session keys and terminal sessions (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/uploads/upload-session.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/uploads/upload-session.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function uploading(ownerUserId: string) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `upl ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "UPLOADING", teamId: A.teamId, organizationId: team.organizationId, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  const open = (evidenceId: string, actorUserId: string, idempotencyKey?: string) =>
    svc.createUploadSession({ teamId: h.fixtures.teamA.teamId, evidenceId, actorUserId, expectedPartCount: 1, idempotencyKey });

  it("ET-UPL-03: a key pre-created for another record or actor is refused, never reused", async () => {
    const A = h.fixtures.teamA;
    const key = `capture:${randomUUID()}:0`;
    const attackerRecord = await uploading(A.memberUserId);
    const victimRecord = await uploading(A.ownerUserId);
    const planted = await open(attackerRecord, A.memberUserId, key);
    expect(planted.ok).toBe(true);
    expect(await open(victimRecord, A.ownerUserId, key)).toEqual({ ok: false, reason: "idempotency_key_conflict" });
    // The same record and actor still collapse onto their own session.
    const again = await open(attackerRecord, A.memberUserId, key);
    expect(again).toMatchObject({ ok: true, reused: true });
  });

  it("ET-UPL-02: a retry after an aborted session mints a FRESH session, and the aborted one does not block finalization", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await uploading(A.ownerUserId);
    const key = `capture:${evidenceId}:0`;
    const first = (await open(evidenceId, A.ownerUserId, key)) as { ok: true; session: { id: string } };
    expect(first.ok).toBe(true);
    await prisma.$executeRawUnsafe(`UPDATE "evidence_upload_sessions" SET "state" = 'ABORTED' WHERE "id" = $1`, first.session.id);

    const retry = (await open(evidenceId, A.ownerUserId, key)) as { ok: true; session: { id: string; state: string }; reused?: boolean };
    expect(retry.ok).toBe(true);
    expect(retry.session.id).not.toBe(first.session.id);
    expect(retry.reused ?? false).toBe(false);

    // The retry completes; the aborted session no longer blocks the record.
    await prisma.$executeRawUnsafe(`UPDATE "evidence_upload_session_parts" SET "state" = 'VERIFIED' WHERE "session_id" = $1`, retry.session.id);
    expect(await svc.completeUploadSession({ teamId: A.teamId, sessionId: retry.session.id })).toMatchObject({ ok: true });
    const gate = await svc.evaluateUploadSessionFinalizeGate({ teamId: A.teamId, evidenceId });
    expect(gate).toMatchObject({ ok: true, applies: true });
  });

  it("ET-UPL-05: a HASHED part is admitted by the live constraint, settles completion, and never stamps verified_at", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await uploading(A.ownerUserId);
    const s = (await open(evidenceId, A.ownerUserId)) as { ok: true; session: { id: string } };
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_upload_session_parts" SET "state" = 'HASHED', "server_sha256" = $2 WHERE "session_id" = $1`,
      s.session.id,
      "b".repeat(64),
    );
    const parts = (await prisma.$queryRawUnsafe(
      `SELECT "state", "verified_at_utc" FROM "evidence_upload_session_parts" WHERE "session_id" = $1`,
      s.session.id,
    )) as Array<{ state: string; verified_at_utc: Date | null }>;
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual({ state: "HASHED", verified_at_utc: null });
    // Any other value is still refused by the bounded constraint.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "evidence_upload_session_parts" SET "state" = 'TRUSTED' WHERE "session_id" = $1`, s.session.id),
    ).rejects.toThrow(/evidence_upload_session_parts_state_bounded/);

    expect(await svc.completeUploadSession({ teamId: A.teamId, sessionId: s.session.id })).toMatchObject({ ok: true });
    expect(await svc.evaluateUploadSessionFinalizeGate({ teamId: A.teamId, evidenceId })).toMatchObject({ ok: true, applies: true });
  });

  it("ET-UPL-02: only the session's actor or the record's owner may abort it", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await uploading(A.ownerUserId);
    const s = (await open(evidenceId, A.ownerUserId)) as { ok: true; session: { id: string } };
    const byTeammate = await svc.abortUploadSession({ teamId: A.teamId, sessionId: s.session.id, actorUserId: A.adminUserId, reason: "not mine" });
    expect(byTeammate).toEqual({ ok: false, reason: "session_not_found" });
    const row = (await prisma.$queryRawUnsafe(`SELECT "state" FROM "evidence_upload_sessions" WHERE "id" = $1`, s.session.id)) as Array<{ state: string }>;
    expect(row[0]?.state).not.toBe("ABORTED");
  });
});
