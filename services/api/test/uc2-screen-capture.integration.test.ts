/**
 * UC-2 — ANDROID DIRECT SCREEN CAPTURE, against a real database and the real
 * routes.
 *
 * Proves the screen-capture vertical spine on the canonical UC-0 direct-capture
 * session: open (mode DIRECT_SCREEN_CAPTURE_ANDROID) → reserve one Evidence →
 * upload the frame(s) + manifest parts → declare their digests → seal with the
 * manifest through /screen-complete → exactly one CAPTURE_SESSION_BOUND,
 * acquisitionMode DIRECT_SCREEN_CAPTURE_ANDROID (server-set, never client-set),
 * the manifest part classed CAPTURE_MANIFEST, and the record flowing into the
 * canonical library/acquisition surfaces. Plus the refusals: a manifest that
 * omits a declared frame, a session-id mismatch, and screen-completing a mobile
 * session.
 *
 * Object store and signer are doubled in-process; PostgreSQL 16 is real.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://uc2-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        contentType: "application/octet-stream",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
    deleteObject: async (p: { bucket: string; key: string }) => {
      objects.delete(id(p));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`uc2-test-signature:${hex}`).toString("base64"),
        keyId: "uc2-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "uc2-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("UC-2 android direct screen capture — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let app: IntegrationHarness["app"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    app = harness.app;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    if (harness && originalBilling) {
      await prisma.team
        .update({ where: { id: harness.fixtures.teamA.teamId }, data: originalBilling as never })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  const owner = () => harness.fixtures.teamA;

  async function call(method: string, url: string, token: string, body?: unknown) {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  /** Upload one part's bytes and declare its digest. */
  async function uploadAndDeclare(
    token: string,
    evidenceId: string,
    sessionId: string,
    partIndex: number,
    bytes: Buffer,
    clientReportedSource: string,
  ) {
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex,
      mimeType: "application/octet-stream",
      originalFileName: `part-${partIndex}.bin`,
    });
    expect(part.statusCode, part.body).toBe(201);
    const { bucket, key } = part.json().upload as { bucket: string; key: string };
    objects.set(`${bucket}/${key}`, bytes);
    const digest = sha256(bytes);
    const decl = await call(
      "POST",
      `/v1/capture/direct-sessions/${sessionId}/parts/${partIndex}/declaration`,
      token,
      { sha256: digest, clientReportedSource, signed: null },
    );
    expect(decl.statusCode, decl.body).toBe(201);
    return { partIndex, sha256: digest, sizeBytes: bytes.length };
  }

  /** Stage a full screen capture up to (but not including) /screen-complete. */
  async function stageScreenCapture(
    opts: { omitFrameFromManifest?: boolean; badSessionInManifest?: boolean; frames?: number } = {},
  ) {
    const token = owner().ownerToken;
    const frames = opts.frames ?? 2;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;

    const reserve = await call(
      "POST",
      `/v1/capture/direct-sessions/${sessionId}/evidence`,
      token,
      { type: "PHOTO", mimeType: "image/png" },
    );
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;

    const artifacts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < frames; i++) {
      const bytes = Buffer.from(`screen-frame-${i}-${randomBytes(8).toString("hex")}`);
      const declared = await uploadAndDeclare(token, evidenceId, sessionId, i, bytes, "SCREEN_FRAME");
      if (opts.omitFrameFromManifest && i === frames - 1) continue;
      artifacts.push({
        role: "screen_frame",
        partIndex: i,
        frameIndex: i,
        expectedSha256: declared.sha256,
        sizeBytes: declared.sizeBytes,
        mediaType: "image/png",
        widthPx: 1080,
        heightPx: 2400,
        capturedAtOffsetMs: i * 500,
        completeness: "CAPTURED",
      });
    }

    const manifest = {
      schemaVersion: SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
      captureSessionId: opts.badSessionInManifest ? "00000000-0000-4000-8000-000000000000" : sessionId,
      captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
      captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
      device: {
        platform: "android",
        osVersion: "14",
        model: "Pixel 7",
        appVersion: "1.0.0",
        screenW: 1080,
        screenH: 2400,
        densityDpi: 420,
        orientation: "portrait",
      },
      osConsentGranted: true,
      artifacts,
      completeness: "CAPTURED",
      stopReason: "USER_STOPPED",
      limitations: [],
      notes: [],
    };
    const manifestJson = JSON.stringify(manifest);
    await uploadAndDeclare(token, evidenceId, sessionId, frames, Buffer.from(manifestJson, "utf8"), "SCREEN_MANIFEST");
    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex: frames };
  }

  it("seals a screen capture: acquisitionMode is server-set, the manifest part is classed, bound once", async () => {
    const { token, sessionId, evidenceId, manifestJson, manifestPartIndex } = await stageScreenCapture();

    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, {
      manifestJson,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.bound).toBe(true);
    expect(done.json().result.manifestPartIndex).toBe(manifestPartIndex);

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, acquisitionMode: true, acquisitionModeSource: true },
    });
    expect(ev.status).toBe("SIGNED");
    expect(ev.acquisitionMode).toBe("DIRECT_SCREEN_CAPTURE_ANDROID");
    expect(ev.acquisitionModeSource).toBe("RECORDED_AT_CREATION");

    // The manifest part is classed CAPTURE_MANIFEST; the frame parts are ORIGINAL.
    const parts = await prisma.evidencePart.findMany({
      where: { evidenceId },
      select: { partIndex: true, artifactClass: true },
      orderBy: { partIndex: "asc" },
    });
    expect(parts.find((p) => p.partIndex === manifestPartIndex)?.artifactClass).toBe("CAPTURE_MANIFEST");
    expect(parts.find((p) => p.partIndex === 0)?.artifactClass).toBe("ORIGINAL");

    // Exactly one CAPTURE_SESSION_BOUND.
    const bound = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
    });
    expect(bound).toBe(1);

    // The library projection + acquisition filter use the one authority.
    const list = await call("GET", `/v1/evidence?scope=all&acquisition=DIRECT_SCREEN_CAPTURE&limit=50`, token);
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json().items ?? []) as Array<{ id: string; acquisition?: { mode: string; category: string } }>;
    const mine = items.find((x) => x.id === evidenceId);
    expect(mine?.acquisition?.mode).toBe("DIRECT_SCREEN_CAPTURE_ANDROID");
    expect(mine?.acquisition?.category).toBe("DIRECT_SCREEN_CAPTURE");
    // It does not appear under the web-capture filter.
    const webOnly = await call("GET", `/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`, token);
    expect(((webOnly.json().items ?? []) as Array<{ id: string }>).some((x) => x.id === evidenceId)).toBe(false);

    // Idempotent re-complete returns the same binding, mints no second bind.
    const again = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, { manifestJson });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().result.alreadyBound).toBe(true);
    const boundAfter = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
    });
    expect(boundAfter).toBe(1);
  });

  it("refuses a manifest that omits a declared frame", async () => {
    const { token, sessionId, manifestJson } = await stageScreenCapture({ omitFrameFromManifest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("SCREEN_MANIFEST_ARTIFACT_MISMATCH");
  });

  it("refuses a manifest bound to a different session", async () => {
    const { token, sessionId, manifestJson } = await stageScreenCapture({ badSessionInManifest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("SCREEN_MANIFEST_INVALID");
  });

  it("refuses screen-completing a mobile session, and refuses a client-set acquisition string", async () => {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
    });
    expect(reserve.statusCode).toBe(201);
    const manifestJson = JSON.stringify({ schemaVersion: SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION, captureSessionId: sessionId });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(400);
    expect(done.json().denial).toBe("UNSUPPORTED_MODE");

    // An arbitrary acquisition string cannot open a session.
    const forged = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_ADMIN",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect([400, 422]).toContain(forged.statusCode);
  });
});
