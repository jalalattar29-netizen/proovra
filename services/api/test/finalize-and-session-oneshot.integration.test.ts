/**
 * ET-SEC-11 / ET-SEC-13 — one-shot finalization and live-only session
 * completion. Live PostgreSQL 16, the real route and service.
 *
 * On a40ca76f:
 *   ET-SEC-11 — a repeat POST /complete on a REPORTED record returned without
 *     alreadyFinalized and re-ran the one-time fan-out (another
 *     EVIDENCE_COMPLETED custody event, webhook, scan, post-finalize).
 *   ET-SEC-13 — completeUploadSession's write guard excluded only COMPLETED, so
 *     a session ABORTED between its read and its write was flipped to COMPLETED.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("finalization and upload-session one-shot guards (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(status: "REPORTED" | "SIGNED" | "UPLOADING") {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `oneshot ${randomUUID().slice(0, 6)}`,
          type: "PHOTO",
          status,
          teamId: A.teamId,
          organizationId: team.organizationId,
          ownerUserId: A.ownerUserId,
          fileSha256: "a".repeat(64),
          fingerprintHash: "b".repeat(64),
          signatureBase64: "sig",
          signingKeyId: "k",
          signingKeyVersion: 1,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  it("ET-SEC-11: a repeat /complete on a REPORTED record is alreadyFinalized and records nothing new", async () => {
    const id = await record("REPORTED");
    const before = await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_COMPLETED" } });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/complete`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(JSON.stringify(res.json())).toContain('"alreadyFinalized":true');
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_COMPLETED" } })).toBe(before);
  });

  it("ET-SEC-13: a session aborted between the read and the write is NOT completed", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await record("UPLOADING");
    const svc = await import("../src/services/uploads/upload-session.service.js");
    const created = await svc.createUploadSession({
      teamId: A.teamId,
      evidenceId,
      actorUserId: A.ownerUserId,
      expectedPartCount: 1,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const sessionId = (created as { session: { id: string } }).session.id;
    // Every part verified: only the race decides the outcome below.
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_upload_session_parts" SET "state" = 'VERIFIED' WHERE "session_id" = $1`,
      sessionId,
    );

    // A client whose FIRST raw read sees the live session; the abort lands
    // before the completion write — the window the guard must close.
    let reads = 0;
    const racing = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === "$queryRawUnsafe") {
          return async (sql: string, ...args: unknown[]) => {
            const out = await (target.$queryRawUnsafe as (...a: unknown[]) => Promise<unknown>)(sql, ...args);
            reads += 1;
            if (reads === 1) {
              await target.$executeRawUnsafe(
                `UPDATE "evidence_upload_sessions" SET "state" = 'ABORTED' WHERE "id" = $1`,
                sessionId,
              );
            }
            return out;
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const result = await svc.completeUploadSession({ teamId: A.teamId, sessionId }, racing as never);
    expect(result).toEqual({ ok: false, reason: "session_already_terminal" });
    const row = (await prisma.$queryRawUnsafe(
      `SELECT "state" FROM "evidence_upload_sessions" WHERE "id" = $1`,
      sessionId,
    )) as Array<{ state: string }>;
    expect(row[0]?.state).toBe("ABORTED");
  });
});
