/**
 * AUD-0017 (audit sites TXP-006..TXP-012) — direct capture under concurrency
 * ABOVE the database pool size.
 *
 * The part declaration and the seal run interactive transactions that hold the
 * session lock. Inside them, helpers ran on the GLOBAL client: the declaration's
 * trust event (a nested global transaction) and expiry slide, the seal claim's
 * finalization-governance decision (reads plus a nested global transaction),
 * and the bind's case-assignment read. Each transaction held one pooled
 * connection while waiting for a second, so a burst at or above the pool size
 * wedged the pool: every request waited until its transaction expired (P2028).
 * Those calls now run on the transaction's own client, so demand above the pool
 * queues and succeeds.
 *
 * Real routes, PostgreSQL and the object store; the pool is set before the
 * client module is imported.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness, TeamFixture } from "./integration-harness.js";

const POOL = 4;
const N = POOL * 2;

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("AUD-0017 direct-capture declare/seal above the pool size (live PostgreSQL, pool 4)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const poolBefore = process.env.DATABASE_POOL_MAX;

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = String(POOL);
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    for (const t of [h.fixtures.teamA, h.fixtures.teamB]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }
  }, 300_000);

  afterAll(async () => {
    if (poolBefore === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = poolBefore;
    await h?.cleanup();
  }, 300_000);

  function call(team: TeamFixture, url: string, payload?: unknown) {
    return h.app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${team.ownerToken}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  }

  /** Open → reserve → presign part 0 → store its bytes (sequential: setup, not the burst). */
  async function stage(team: TeamFixture, label: string, opts: { caseId?: string } = {}) {
    const open = await call(team, "/v1/capture/direct-sessions", {
      mode: "PROOVRA_MOBILE_APP",
      teamId: team.teamId,
      deviceId: null,
      ...(opts.caseId ? { caseId: opts.caseId } : {}),
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = (open.json() as { session: { captureSessionId: string } }).session.captureSessionId;
    const reserve = await call(team, `/v1/capture/direct-sessions/${sessionId}/evidence`, {
      type: "PHOTO",
      mimeType: "image/jpeg",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = (reserve.json() as { evidence: { evidenceId: string } }).evidence.evidenceId;
    const bytes = Buffer.from(`aud-0017 direct ${label} ${randomUUID()}`);
    const part = await call(team, `/v1/evidence/${evidenceId}/parts`, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: `${label}.jpg`,
      sizeBytes: bytes.length,
    });
    expect(part.statusCode, part.body).toBe(201);
    const up = (part.json() as { upload: { putUrl: string; headers?: Record<string, string> } }).upload;
    const put = await fetch(up.putUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "image/jpeg", ...(up.headers ?? {}) },
    });
    expect(put.status).toBe(200);
    return { sessionId, evidenceId, digest: sha256Hex(bytes) };
  }

  const declare = (team: TeamFixture, s: { sessionId: string; digest: string }) =>
    call(team, `/v1/capture/direct-sessions/${s.sessionId}/parts/0/declaration`, {
      sha256: s.digest,
      clientReportedSource: "CAMERA",
      signed: null,
    });

  it(`${N} concurrent part declarations (one per session) at pool ${POOL} all succeed promptly, one declaration each`, async () => {
    const team = h.fixtures.teamA;
    const staged = [];
    for (let i = 0; i < N; i += 1) staged.push(await stage(team, `d-${i}`));
    const before = await prisma.captureSession.findMany({
      where: { id: { in: staged.map((s) => s.sessionId) } },
      select: { id: true, expiresAtUtc: true },
    });

    const t0 = Date.now();
    const results = await Promise.all(staged.map((s) => declare(team, s)));
    const elapsed = Date.now() - t0;
    expect(
      results.map((r) => r.statusCode),
      results.map((r) => r.body.slice(0, 200)).join("\n"),
    ).toEqual(Array(N).fill(201));
    // A wedged pool answers only when the 30 s transactions expire.
    expect(elapsed).toBeLessThan(20_000);

    for (const s of staged) {
      const declared = await prisma.captureTrustEventRecord.findMany({
        where: { captureSessionId: s.sessionId, code: "CAPTURE_ARTIFACT_RECEIVED" },
        select: { payload: true },
      });
      const parts = declared
        .map((d) => d.payload as Record<string, unknown>)
        .filter((p) => p["stage"] === "part_declared");
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ partIndex: 0, declaredSha256: s.digest });
    }
    // The expiry slid (or stayed) and the sessions are still open.
    const after = await prisma.captureSession.findMany({
      where: { id: { in: staged.map((s) => s.sessionId) } },
      select: { id: true, status: true, expiresAtUtc: true },
    });
    for (const row of after) {
      expect(row.status).toBe("ACTIVE");
      const prior = before.find((b) => b.id === row.id)!;
      expect(row.expiresAtUtc!.getTime()).toBeGreaterThanOrEqual(prior.expiresAtUtc!.getTime());
    }

    // A concurrent idempotent repeat changes nothing.
    const again = await Promise.all(staged.map((s) => declare(team, s)));
    expect(again.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
    for (const s of staged) {
      expect(
        await prisma.captureTrustEventRecord.count({
          where: { captureSessionId: s.sessionId, code: "CAPTURE_ARTIFACT_RECEIVED" },
        }),
      ).toBe(1);
    }
  }, 300_000);

  it(`${N} concurrent seals (case-linked sessions) at pool ${POOL} all seal, bind and link exactly once`, async () => {
    const team = h.fixtures.teamB;
    const staged = [];
    for (let i = 0; i < N; i += 1) {
      const s = await stage(team, `s-${i}`, { caseId: team.caseId });
      // Declared one at a time: this test bursts the seal, not the declaration.
      const d = await declare(team, s);
      expect(d.statusCode, d.body).toBe(201);
      staged.push(s);
    }

    const t0 = Date.now();
    const done = await Promise.all(
      staged.map((s) => call(team, `/v1/capture/direct-sessions/${s.sessionId}/complete`)),
    );
    const elapsed = Date.now() - t0;
    expect(
      done.map((r) => r.statusCode),
      done.map((r) => r.body.slice(0, 200)).join("\n"),
    ).toEqual(Array(N).fill(200));
    expect(elapsed).toBeLessThan(60_000);
    for (const r of done) {
      expect((r.json() as { result: unknown }).result).toMatchObject({
        bound: true,
        alreadyBound: false,
        digestsConfirmed: 1,
        caseLink: { caseId: team.caseId, linked: true, denial: null },
      });
    }

    const sessions = await prisma.captureSession.findMany({
      where: { id: { in: staged.map((s) => s.sessionId) } },
      select: { id: true, status: true, finalizedEvidenceId: true, endReason: true },
    });
    expect(sessions.every((x) => x.status === "BOUND" && x.endReason === "COMPLETED")).toBe(true);
    const records = await prisma.evidence.findMany({
      where: { id: { in: staged.map((s) => s.evidenceId) } },
      select: { id: true, status: true, fileSha256: true },
    });
    for (const s of staged) {
      const rec = records.find((r) => r.id === s.evidenceId)!;
      expect(rec.status === "SIGNED" || rec.status === "REPORTED").toBe(true);
      expect(rec.fileSha256).toBe(s.digest);
      expect(sessions.find((x) => x.id === s.sessionId)!.finalizedEvidenceId).toBe(s.evidenceId);
      expect(
        await prisma.captureTrustEventRecord.count({
          where: { captureSessionId: s.sessionId, code: "CAPTURE_SESSION_BOUND" },
        }),
      ).toBe(1);
      expect(
        await prisma.custodyEvent.count({ where: { evidenceId: s.evidenceId, eventType: "EVIDENCE_COMPLETED" as never } }),
      ).toBe(1);
      expect(
        await prisma.caseEvidenceLink.count({ where: { caseId: team.caseId, evidenceId: s.evidenceId } }),
      ).toBe(1);
    }

    // A concurrent repeat answers "already bound" and binds nothing new.
    const again = await Promise.all(
      staged.map((s) => call(team, `/v1/capture/direct-sessions/${s.sessionId}/complete`)),
    );
    expect(again.map((r) => r.statusCode), again.map((r) => r.body.slice(0, 200)).join("\n")).toEqual(Array(N).fill(200));
    for (const s of staged) {
      expect(
        await prisma.captureTrustEventRecord.count({
          where: { captureSessionId: s.sessionId, code: "CAPTURE_SESSION_BOUND" },
        }),
      ).toBe(1);
    }
  }, 300_000);
});
