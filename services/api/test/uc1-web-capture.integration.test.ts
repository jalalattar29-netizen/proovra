/**
 * UC-1 — DIRECT WEB CAPTURE, against a real database and the real routes.
 *
 * Proves the web-capture vertical spine on the canonical UC-0 direct-capture
 * session: open (mode DIRECT_WEB_CAPTURE_EXTENSION) → reserve one Evidence →
 * upload the screenshot + DOM + manifest parts → declare their digests → seal
 * with the manifest through /web-complete → exactly one CAPTURE_SESSION_BOUND,
 * acquisitionMode DIRECT_WEB_CAPTURE_EXTENSION (server-set, never client-set),
 * the manifest part classed CAPTURE_MANIFEST, and the record flowing into the
 * canonical library/acquisition surfaces. Plus the refusals: a manifest that
 * omits a declared part, a session-id mismatch, and web-completing a mobile
 * session.
 *
 * Object store and signer are doubled in-process; PostgreSQL 16 is real.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { WEB_CAPTURE_MANIFEST_SCHEMA_VERSION } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://uc1-test-store.invalid/${encodeURIComponent(id(p))}`,
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
        signatureBase64: Buffer.from(`uc1-test-signature:${hex}`).toString("base64"),
        keyId: "uc1-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "uc1-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("UC-1 direct web capture — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let app: IntegrationHarness["app"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    app = harness.app;
    // The fixture workspace has no paid plan; the commercial gate refuses
    // capture in it. Give it one for this suite; restored in afterAll.
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

  /** Upload one part's bytes and declare its digest; returns {partIndex, sha256}. */
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
    return { partIndex, sha256: digest };
  }

  /** Stage a full web capture up to (but not including) /web-complete. */
  async function stageWebCapture(opts: { omitDomFromManifest?: boolean; badSessionInManifest?: boolean } = {}) {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const session = open.json().session as { captureSessionId: string };
    const sessionId = session.captureSessionId;

    const reserve = await call(
      "POST",
      `/v1/capture/direct-sessions/${sessionId}/evidence`,
      token,
      { type: "PHOTO", mimeType: "image/png" },
    );
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;

    const shotBytes = Buffer.from(`viewport-${randomBytes(8).toString("hex")}`);
    const domBytes = Buffer.from(`<html>${randomBytes(8).toString("hex")}</html>`);
    const shot = await uploadAndDeclare(token, evidenceId, sessionId, 0, shotBytes, "WEB_VIEWPORT");
    const dom = await uploadAndDeclare(token, evidenceId, sessionId, 1, domBytes, "WEB_DOM");

    const artifacts = [
      { role: "viewport_screenshot", partIndex: 0, expectedSha256: shot.sha256, sizeBytes: shotBytes.length, mediaType: "image/png", completeness: "CAPTURED" },
    ];
    if (!opts.omitDomFromManifest) {
      artifacts.push({ role: "dom_snapshot", partIndex: 1, expectedSha256: dom.sha256, sizeBytes: domBytes.length, mediaType: "text/html", completeness: "CAPTURED" });
    }
    const manifest = {
      schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
      captureMode: "VIEWPORT",
      captureSessionId: opts.badSessionInManifest ? "00000000-0000-4000-8000-000000000000" : sessionId,
      captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
      captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
      page: { domain: "example.com", sourceUrlPrivate: "https://example.com/article?token=secret", title: "Example Article" },
      browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
      extensionVersion: "1.0.0",
      artifacts,
      completeness: "CAPTURED",
      pageMutatedDuringCapture: false,
      limitations: [],
      notes: [],
    };
    const manifestJson = JSON.stringify(manifest);
    const manifestBytes = Buffer.from(manifestJson, "utf8");
    // The manifest is part 2, uploaded and declared like any part.
    await uploadAndDeclare(token, evidenceId, sessionId, 2, manifestBytes, "WEB_MANIFEST");
    return { token, sessionId, evidenceId, manifestJson };
  }

  it("seals a web capture: acquisitionMode is server-set, the manifest part is classed, bound once", async () => {
    const { token, sessionId, evidenceId, manifestJson } = await stageWebCapture();

    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, token, {
      manifestJson,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.bound).toBe(true);
    expect(done.json().result.manifestPartIndex).toBe(2);

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, acquisitionMode: true, acquisitionModeSource: true },
    });
    expect(ev.status).toBe("SIGNED");
    expect(ev.acquisitionMode).toBe("DIRECT_WEB_CAPTURE_EXTENSION");
    expect(ev.acquisitionModeSource).toBe("RECORDED_AT_CREATION");

    // The manifest part is classed CAPTURE_MANIFEST; the artifact parts are ORIGINAL.
    const parts = await prisma.evidencePart.findMany({
      where: { evidenceId },
      select: { partIndex: true, artifactClass: true },
      orderBy: { partIndex: "asc" },
    });
    expect(parts.find((p) => p.partIndex === 2)?.artifactClass).toBe("CAPTURE_MANIFEST");
    expect(parts.find((p) => p.partIndex === 0)?.artifactClass).toBe("ORIGINAL");

    // Exactly one CAPTURE_SESSION_BOUND.
    const bound = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
    });
    expect(bound).toBe(1);

    // The library projection + acquisition filter use the one authority.
    const list = await call("GET", `/v1/evidence?scope=all&acquisition=DIRECT_WEB_CAPTURE&limit=50`, token);
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json().items ?? []) as Array<{ id: string; acquisition?: { mode: string; category: string } }>;
    const mine = items.find((x) => x.id === evidenceId);
    expect(mine?.acquisition?.mode).toBe("DIRECT_WEB_CAPTURE_EXTENSION");
    expect(mine?.acquisition?.category).toBe("DIRECT_WEB_CAPTURE");
    // It does not appear under a different acquisition filter.
    const uploadOnly = await call("GET", `/v1/evidence?scope=all&acquisition=UPLOAD&limit=50`, token);
    expect(((uploadOnly.json().items ?? []) as Array<{ id: string }>).some((x) => x.id === evidenceId)).toBe(false);

    // Idempotent re-complete returns the same binding, mints no second bind.
    const again = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, token, { manifestJson });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().result.alreadyBound).toBe(true);
    const boundAfter = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
    });
    expect(boundAfter).toBe(1);
  });

  it("refuses a manifest that omits a declared part", async () => {
    const { token, sessionId, manifestJson } = await stageWebCapture({ omitDomFromManifest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("WEB_MANIFEST_ARTIFACT_MISMATCH");
  });

  it("refuses a manifest bound to a different session", async () => {
    const { token, sessionId, manifestJson } = await stageWebCapture({ badSessionInManifest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("WEB_MANIFEST_INVALID");
  });

  it("refuses web-completing a mobile session, and refuses a client-set acquisition string", async () => {
    // A mobile session cannot be sealed through the web path.
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
    const manifestJson = JSON.stringify({ schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION, captureSessionId: sessionId });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(400);
    expect(done.json().denial).toBe("UNSUPPORTED_MODE");

    // The open route only admits modes on the server-controlled enum: an
    // arbitrary acquisition string cannot open a session.
    const forged = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION_ADMIN",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect([400, 422]).toContain(forged.statusCode);
  });
});
