/**
 * INGEST-005 — the resumable sequence, on real routes, PostgreSQL and the object
 * store. `upload-resumable-atomicity.test.ts` proves the branches with a mocked
 * client and a mocked store; this drives the real protocol, the one the capture
 * page uses: session, initiate, presign, PUT the bytes, report the ETag, complete.
 *
 * The one fault injected is the database write of the bridge step. Everything
 * else is real, so a retry below really does meet an upload id the store has spent.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const fault = vi.hoisted(() => ({ failNextBridge: false }));

vi.mock("../src/services/evidence/evidence-part-writer.service.js", async (original) => {
  const real = await original<typeof import("../src/services/evidence/evidence-part-writer.service.js")>();
  return {
    ...real,
    writeEvidencePart: async (...args: Parameters<typeof real.writeEvidencePart>) => {
      if (fault.failNextBridge) {
        fault.failNextBridge = false;
        throw new Error("connection reset during the bridge write");
      }
      return real.writeEvidencePart(...args);
    },
  };
});

describe("INGEST-005 the resumable sequence (live PostgreSQL and object store)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let gate: (typeof import("../src/services/uploads/upload-session.service.js"))["evaluateUploadSessionFinalizeGate"];

  const A = () => h.fixtures.teamA;
  const auth = () => ({ authorization: `Bearer ${A().ownerToken}` });
  const post = (url: string, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: auth(), payload: payload as never });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ evaluateUploadSessionFinalizeGate: gate } = await import("../src/services/uploads/upload-session.service.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function uploadedSession(opts: { declaredSha256?: string } = {}) {
    const teamId = A().teamId;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: { title: `ingest-${randomUUID().slice(0, 6)}`, type: "VIDEO", status: "UPLOADING", teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId },
      select: { id: true },
    });
    const bytes = Buffer.from(`resumable-${randomUUID()}`.repeat(200));
    const sha = createHash("sha256").update(bytes).digest("hex");

    const created = await post("/v1/uploads/sessions", {
      teamId,
      evidenceId: evidence.id,
      expectedPartCount: 1,
      expectedTotalBytes: bytes.length,
      expectedSha256: opts.declaredSha256 ?? sha,
      targetPartIndex: 0,
      originalFileName: "large.mov",
      expectedMimeType: "video/quicktime",
    });
    expect(created.statusCode, created.body).toBe(201);
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const initiated = await post(`/v1/uploads/sessions/${sessionId}/multipart/initiate`, { teamId, contentType: "video/quicktime" });
    expect(initiated.statusCode, initiated.body).toBe(200);
    const presigned = await post(`/v1/uploads/sessions/${sessionId}/parts/0/presign`, { teamId, sizeBytes: bytes.length });
    expect(presigned.statusCode, presigned.body).toBe(200);
    const { uploadUrl } = presigned.json() as { uploadUrl: string };
    const put = await fetch(uploadUrl, { method: "PUT", body: bytes });
    expect(put.status, await put.clone().text()).toBe(200);
    const etag = put.headers.get("etag")!.replace(/"/g, "");
    const marked = await post(`/v1/uploads/sessions/${sessionId}/parts/0/uploaded`, {
      teamId,
      clientSha256: sha,
      partEtag: etag,
      partSizeBytes: bytes.length,
    });
    expect(marked.statusCode, marked.body).toBe(200);
    return { teamId, evidenceId: evidence.id, sessionId, sha };
  }

  const complete = (s: { teamId: string; sessionId: string }) =>
    post(`/v1/uploads/sessions/${s.sessionId}/multipart/complete`, { teamId: s.teamId, verifyHash: true });
  const parts = (evidenceId: string) => prisma.evidencePart.findMany({ where: { evidenceId } });

  it("positive control: the object is assembled, hashed by the server and bridged to one part", async () => {
    const s = await uploadedSession();
    const res = await complete(s);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await parts(s.evidenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partIndex: 0 });
  });

  it("AUD-0019: storage completion settles every part (VERIFIED), the session completes, the record seals, and repeating completion changes nothing", async () => {
    const s = await uploadedSession();
    const res = await complete(s);
    expect(res.statusCode, res.body).toBe(200);
    // The settle UPDATE used to fail in Postgres (parameter $4 typed varchar AND
    // text) and the error was swallowed: parts stayed UPLOADED_UNVERIFIED and the
    // session could never complete.
    const settled = await prisma.evidenceUploadSessionPart.findMany({ where: { sessionId: s.sessionId }, select: { state: true, serverSha256: true } });
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every((p) => p.state === "VERIFIED" && p.serverSha256 === s.sha)).toBe(true);

    const done = await post(`/v1/uploads/sessions/${s.sessionId}/complete`, { teamId: s.teamId });
    expect(done.statusCode, done.body).toBe(200);
    const again = await post(`/v1/uploads/sessions/${s.sessionId}/complete`, { teamId: s.teamId });
    expect(again.statusCode, again.body).toBe(200);
    const session = await prisma.$queryRawUnsafe<Array<{ state: string }>>(`SELECT "state" FROM "evidence_upload_sessions" WHERE "id" = $1`, s.sessionId);
    expect(session[0]?.state).toBe("COMPLETED");

    const sealed = await post(`/v1/evidence/${s.evidenceId}/complete`, {});
    expect(sealed.statusCode, sealed.body).toBeLessThan(300);
    const resealed = await post(`/v1/evidence/${s.evidenceId}/complete`, {});
    expect(resealed.statusCode, resealed.body).toBeLessThan(300);
    const record = await prisma.evidence.findUniqueOrThrow({ where: { id: s.evidenceId }, select: { status: true, fileSha256: true } });
    expect(["SIGNED", "REPORTED"]).toContain(record.status);
    expect(await parts(s.evidenceId)).toHaveLength(1);
  });

  it("INGEST-006: bytes that are not what the client hashed fail the session and bridge nothing", async () => {
    const s = await uploadedSession({ declaredSha256: "0".repeat(64) });
    const res = await complete(s);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: { reason: "hash_mismatch" } });
    expect(await parts(s.evidenceId)).toHaveLength(0);
    const held = await gate({ teamId: s.teamId, evidenceId: s.evidenceId }, prisma as never);
    expect(held).toMatchObject({ ok: false });
  });

  it("INGEST-002: a declared total over the limit gets the typed refusal, and no session", async () => {
    const before = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM evidence_upload_sessions`;
    const { getUploadSizeLimits } = await import("../src/services/reliability/upload-limits.service.js");
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: { title: "too large", type: "VIDEO", status: "UPLOADING", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId },
      select: { id: true },
    });
    const res = await post("/v1/uploads/sessions", {
      teamId: A().teamId,
      evidenceId: evidence.id,
      expectedPartCount: 1,
      expectedTotalBytes: getUploadSizeLimits().maxUploadFileSizeBytes + 1,
      targetPartIndex: 0,
      originalFileName: "large.mov",
      expectedMimeType: "video/quicktime",
    });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json()).toMatchObject({ error: { reason: "evidence_too_large" } });
    const after = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM evidence_upload_sessions`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("a bridge failure is reported as a failure, and the seal is refused meanwhile", async () => {
    const s = await uploadedSession();
    fault.failNextBridge = true;
    const res = await complete(s);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
    expect(await parts(s.evidenceId)).toHaveLength(0);

    const held = await gate({ teamId: s.teamId, evidenceId: s.evidenceId }, prisma as never);
    expect(held, "a record cannot seal without the file the user saw as uploading").toMatchObject({ ok: false });
  });

  it("a retry after that failure completes on the spent upload id and bridges exactly one part", async () => {
    const s = await uploadedSession();
    fault.failNextBridge = true;
    expect((await complete(s)).statusCode).toBeGreaterThanOrEqual(500);

    const retried = await complete(s);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await parts(s.evidenceId)).toHaveLength(1);
    const again = await complete(s);
    expect(again.statusCode, again.body).toBe(200);
    expect(await parts(s.evidenceId)).toHaveLength(1);
  });

  it("a session marked completed with no bridged part refuses the seal", async () => {
    const s = await uploadedSession();
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_upload_sessions" SET "state" = 'COMPLETED', "completed_at_utc" = NOW() WHERE "id" = $1::uuid`,
      s.sessionId,
    );
    const held = await gate({ teamId: s.teamId, evidenceId: s.evidenceId }, prisma as never);
    expect(held).toMatchObject({ ok: false, reason: "session_part_missing", sessionId: s.sessionId });
  });

  it("a cancel after storage completion takes the bridged file out, so a cancelled file is not sealed", async () => {
    const s = await uploadedSession();
    expect((await complete(s)).statusCode).toBe(200);
    expect(await parts(s.evidenceId)).toHaveLength(1);

    const aborted = await post(`/v1/uploads/sessions/${s.sessionId}/multipart/abort`, { teamId: s.teamId, reason: "user_cancel" });
    expect(aborted.statusCode, aborted.body).toBe(200);
    expect(await parts(s.evidenceId)).toHaveLength(0);
  });

  it("a sealed record refuses that cancel, and keeps its file", async () => {
    const s = await uploadedSession();
    expect((await complete(s)).statusCode).toBe(200);
    await prisma.evidence.update({ where: { id: s.evidenceId }, data: { status: "SIGNED", lockedAt: new Date() } });

    const aborted = await post(`/v1/uploads/sessions/${s.sessionId}/multipart/abort`, { teamId: s.teamId, reason: "user_cancel" });
    expect(aborted.statusCode, aborted.body).toBeGreaterThanOrEqual(400);
    expect(await parts(s.evidenceId)).toHaveLength(1);
  });
});
