/**
 * UC-SEC-001 — a resumable upload session is bound to the member who created
 * it. Live PostgreSQL 16 + the real MinIO object store (P7_HOST_S3_PORT), the
 * real HTTP routes, no doubles.
 *
 * Before: presign / parts/:i/uploaded / multipart initiate / multipart complete
 * / complete loaded the session by (teamId, sessionId) only, so another member
 * of the same workspace who held the session id could write bytes into a
 * colleague's in-flight record (runtime journey J07). Now every step answers
 * that member exactly like an unknown session (anti-enumeration 404) and
 * mutates nothing, while the creator completes the upload normally.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("UC-SEC-001 upload-session actor binding (live PostgreSQL 16 + MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);
  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 120_000);

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  it("another member is refused (404, zero mutation) at every step; the creator completes the upload", async () => {
    const A = h.fixtures.teamA;
    const teamId = A.teamId;
    const created = await call("POST", "/v1/evidence", A.ownerToken, { type: "DOCUMENT", mimeType: "application/octet-stream", teamId });
    expect(created.statusCode, created.body).toBe(201);
    const evidenceId = created.json().id as string;
    const open = await call("POST", "/v1/uploads/sessions", A.ownerToken, {
      teamId,
      evidenceId,
      expectedPartCount: 1,
      targetPartIndex: 0,
      originalFileName: "owner.bin",
      expectedMimeType: "application/octet-stream",
    });
    expect(open.statusCode, open.body).toBe(201);
    const sid = open.json().session.id as string;
    const base = `/v1/uploads/sessions/${sid}`;

    const init = await call("POST", `${base}/multipart/initiate`, A.ownerToken, { teamId });
    expect(init.statusCode, init.body).toBe(200);

    const snapshot = async () => ({
      session: await prisma.$queryRawUnsafe(`SELECT "state", "updated_at_utc" FROM "evidence_upload_sessions" WHERE "id" = $1`, sid),
      parts: await prisma.$queryRawUnsafe(
        `SELECT "part_index", "state", "client_sha256", "updated_at_utc" FROM "evidence_upload_session_parts" WHERE "session_id" = $1 ORDER BY "part_index"`,
        sid,
      ),
      evidenceParts: await prisma.evidencePart.count({ where: { evidenceId } }),
    });
    const before = await snapshot();

    // The member (same workspace, holds evidence.create) at every step.
    const M = A.memberToken;
    const attempts = [
      await call("GET", `${base}?teamId=${teamId}`, M),
      await call("GET", `${base}/status?teamId=${teamId}`, M),
      await call("POST", `${base}/multipart/initiate`, M, { teamId }),
      await call("POST", `${base}/parts/0/presign`, M, { teamId }),
      await call("POST", `${base}/parts/0/uploaded`, M, { teamId, clientSha256: "a".repeat(64), partEtag: '"member-etag"' }),
      await call("POST", `${base}/multipart/complete`, M, { teamId }),
      await call("POST", `${base}/complete`, M, { teamId }),
      await call("POST", `${base}/multipart/abort`, M, { teamId, reason: "not mine" }),
    ];
    for (const [i, res] of attempts.entries()) {
      expect(res.statusCode, `step ${i}: ${res.body}`).toBe(404);
      expect(res.json(), `step ${i}`).toEqual({ error: { code: "not_found" } });
      expect(res.body).not.toContain("X-Amz");
    }
    expect(await snapshot()).toEqual(before);

    // The creator: presign → real PUT to MinIO → uploaded (ETag) → multipart complete.
    const presign = await call("POST", `${base}/parts/0/presign`, A.ownerToken, { teamId });
    expect(presign.statusCode, presign.body).toBe(200);
    const bytes = randomBytes(1024);
    const put = await fetch(presign.json().uploadUrl as string, { method: "PUT", body: bytes });
    expect(put.status).toBe(200);
    const etag = put.headers.get("etag");
    expect(etag).toBeTruthy();
    const uploaded = await call("POST", `${base}/parts/0/uploaded`, A.ownerToken, {
      teamId,
      clientSha256: createHash("sha256").update(bytes).digest("hex"),
      partEtag: etag!,
      partSizeBytes: bytes.length,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const done = await call("POST", `${base}/multipart/complete`, A.ownerToken, { teamId, verifyHash: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().serverSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await prisma.evidencePart.count({ where: { evidenceId } })).toBe(1);
  });
});
