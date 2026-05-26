/**
 * Phase 1 — Critical evidence-flow E2E test.
 *
 * Exercises the full happy path end-to-end against the real stack:
 *   1. Guest auth issues a JWT.
 *   2. Legal acceptance gate is satisfied.
 *   3. POST /v1/evidence returns a presigned PUT URL.
 *   4. Direct PUT to MinIO succeeds.
 *   5. POST /v1/evidence/:id/complete transitions the record to SIGNED
 *      with a server-computed fileSha256, fingerprintHash, and Ed25519
 *      signature.
 *   6. GET /v1/evidence/:id returns the SIGNED record with the same
 *      hashes.
 *
 * If any step fails this is a production-critical regression — every
 * downstream verify, report, and package depends on this pipeline.
 */
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  API_BASE,
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
} from "./helpers/api-client";

test.beforeEach(() => {
  clearTestRateLimits();
});

test.describe("evidence flow @critical", () => {
  test("guest creates, uploads, signs evidence and reads it back", async () => {
    const session = await createGuestSession();
    try {
      // 1. Create evidence — server returns a presigned PUT URL.
      const createRes = await session.api.post("/v1/evidence", {
        data: { type: "PHOTO", mimeType: "text/plain" },
      });
      expect(createRes.ok(), `create body: ${await createRes.text()}`).toBe(true);

      const created = (await createRes.json()) as {
        id: string;
        status: string;
        upload: { putUrl: string; bucket: string; key: string };
      };
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.status).toBe("UPLOADING");
      expect(created.upload.putUrl).toContain("X-Amz-Signature=");

      // 2. Upload bytes directly to MinIO via the presigned URL.
      const body = `playwright e2e ${Date.now()}\n`;
      const expectedSha = createHash("sha256").update(body).digest("hex");

      const putRes = await fetch(created.upload.putUrl, {
        method: "PUT",
        body,
        headers: { "Content-Type": "text/plain" },
      });
      expect(putRes.ok, `PUT status ${putRes.status}`).toBe(true);

      // 3. Complete — server re-hashes the object and produces the
      // signature. The fileSha256 returned MUST equal what we hashed
      // locally; otherwise the evidence path is no longer
      // cryptographically grounded.
      const completeRes = await session.api.post(
        `/v1/evidence/${created.id}/complete`,
        { data: {} },
      );
      expect(completeRes.ok(), `complete body: ${await completeRes.text()}`).toBe(
        true,
      );

      const completed = (await completeRes.json()) as {
        id: string;
        status: string;
        fileSha256: string;
        fingerprintHash: string;
        signatureBase64: string;
        signingKeyId: string;
      };
      expect(completed.status).toBe("SIGNED");
      expect(completed.fileSha256.toLowerCase()).toBe(expectedSha);
      expect(completed.fingerprintHash).toMatch(/^[0-9a-f]{64}$/);
      expect(completed.signatureBase64.length).toBeGreaterThan(40);
      expect(completed.signingKeyId).toBeTruthy();

      // 4. Read back through /v1/evidence/:id — same hashes must
      // appear on the persisted record.
      const detailRes = await session.api.get(`/v1/evidence/${created.id}`);
      expect(detailRes.ok()).toBe(true);
      const detail = (await detailRes.json()) as {
        evidence: { fileSha256: string; fingerprintHash: string };
      };
      expect(detail.evidence.fileSha256.toLowerCase()).toBe(expectedSha);
      expect(detail.evidence.fingerprintHash).toBe(completed.fingerprintHash);
    } finally {
      await disposeSession(session);
    }
  });

  test("cross-tenant access is refused (HTTP 403)", async () => {
    const ownerSession = await createGuestSession();
    const intruderSession = await createGuestSession();
    try {
      const create = await ownerSession.api.post("/v1/evidence", {
        data: { type: "PHOTO", mimeType: "text/plain" },
      });
      const created = (await create.json()) as { id: string };

      const intruderRead = await intruderSession.api.get(
        `/v1/evidence/${created.id}`,
      );
      expect(intruderRead.status()).toBe(403);
    } finally {
      await disposeSession(ownerSession);
      await disposeSession(intruderSession);
    }
  });

  test("API /health responds 200", async ({ request }) => {
    const res = await request.get(`${API_BASE}/health`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
  });
});
