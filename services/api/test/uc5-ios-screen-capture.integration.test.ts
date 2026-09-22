/**
 * UC-5 — APPLE SYSTEM BROADCAST (ReplayKit), against a real database and the
 * real routes.
 *
 * UC-5 has NO pipeline of its own, and that is the claim under test. An iOS
 * broadcast is an ordered-segment continuous session carrying the same
 * continuity manifest as UC-3, so it opens a canonical UC-0 direct-capture
 * session in mode DIRECT_SCREEN_CAPTURE_IOS, reserves ONE Evidence, uploads
 * ordered segments plus the manifest, declares their digests and seals through
 * the SAME /continuous-complete — one CAPTURE_SESSION_BOUND, one Evidence,
 * server-set mode, manifest part classed CAPTURE_MANIFEST.
 *
 * WHY THIS IS ITS OWN SUITE. Sharing a pipeline is a claim that has to be
 * proven for the OTHER platform, not inherited from the first one. This suite
 * found the defect that makes the point: the shared continuity-manifest
 * validator required device.platform === "android", so the iOS broadcast
 * extension's own honest "platform": "ios"
 * (ProovraBroadcastShared.swift:59) was refused as an invalid manifest and a
 * UC-5 session could not be sealed at all — while every Android suite passed.
 * The alternative, an iOS app calling itself Android to satisfy a validator,
 * would have been a false statement about the device on a record whose whole
 * purpose is provenance.
 *
 * Object store and signer are doubled in-process; PostgreSQL 16 is real.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://uc5-test-store.invalid/${encodeURIComponent(id(p))}`,
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
        signatureBase64: Buffer.from(`uc5-test-signature:${hex}`).toString("base64"),
        keyId: "uc5-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "uc5-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("UC-5 iOS system broadcast — live PostgreSQL 16", () => {
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

  /** Stage a full continuous capture up to (but not including) /continuous-complete. */
  async function stageContinuous(
    opts: {
      segments?: number;
      omitLastSegment?: boolean;
      badSequence?: boolean;
      badSessionInManifest?: boolean;
      duplicateSequence?: boolean;
      tamperManifestDigest?: boolean;
      reverseUpload?: boolean;
      tamperStoredBytes?: boolean;
      orientationTransition?: boolean;
    } = {},
  ) {
    const token = owner().ownerToken;
    const segCount = opts.segments ?? 3;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_SCREEN_CAPTURE_IOS",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;

    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: "VIDEO",
      mimeType: "video/mp4",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;

    // Bytes per segment index, generated up front so upload ORDER can vary
    // independently of the manifest's (index-keyed) description.
    const segmentBytes = Array.from({ length: segCount }, (_, i) =>
      Buffer.from(`segment-${i}-${randomBytes(8).toString("hex")}`),
    );
    // Out-of-order upload proves the server is order-independent (it cross-checks by
    // partIndex, never by arrival order).
    const uploadOrder = opts.reverseUpload
      ? [...segmentBytes.keys()].reverse()
      : [...segmentBytes.keys()];

    const declaredByIndex = new Map<number, { partIndex: number; sha256: string; sizeBytes: number }>();
    for (const i of uploadOrder) {
      const declared = await uploadAndDeclare(token, evidenceId, sessionId, i, segmentBytes[i], "SCREEN_SEGMENT");
      declaredByIndex.set(i, declared);
      // Storage tamper: overwrite the stored object with different bytes AFTER the
      // honest digest was declared, so the server recompute at seal finds a mismatch.
      if (opts.tamperStoredBytes && i === 0) {
        for (const key of objects.keys()) {
          if (objects.get(key) === segmentBytes[0]) objects.set(key, Buffer.from("tampered-bytes"));
        }
      }
    }

    const segments: Array<Record<string, unknown>> = [];
    for (let i = 0; i < segCount; i++) {
      if (opts.omitLastSegment && i === segCount - 1) continue;
      const declared = declaredByIndex.get(i)!;
      // A mid-session rotation: segment 1 is landscape (its own true geometry).
      const isLandscape = opts.orientationTransition && i === 1;
      segments.push({
        role: "screen_segment",
        partIndex: i,
        // A non-contiguous sequence (skip 1) makes a missing segment detectable; a
        // duplicate sequence collapses two segments onto one slot (also rejected).
        sequence: opts.badSequence && i >= 1 ? i + 1 : opts.duplicateSequence && i === 1 ? 0 : i,
        expectedSha256:
          opts.tamperManifestDigest && i === 0 ? "f".repeat(64) : declared.sha256,
        sizeBytes: declared.sizeBytes,
        mediaType: "video/mp4",
        startedAtOffsetMs: i * 1000,
        durationMs: 1000,
        widthPx: isLandscape ? 2400 : 1080,
        heightPx: isLandscape ? 1080 : 2400,
        orientation: isLandscape ? "landscape" : "portrait",
      });
    }

    const manifest = {
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: opts.badSessionInManifest ? "00000000-0000-4000-8000-000000000000" : sessionId,
      captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
      captureEndedAtUtc: "2026-09-17T10:00:03.000Z",
      device: {
        platform: "ios",
        osVersion: "18.0",
        model: "iPhone 15 Pro",
        appVersion: "1.0.0",
        screenW: 1179,
        screenH: 2556,
        densityDpi: 460,
        orientation: "portrait",
      },
      osConsentGranted: true,
      totalDurationMs: segCount * 1000,
      segments,
      sessionCompleteness: "COMPLETE_SESSION",
      terminationReason: "USER_STOPPED",
      limitations: opts.orientationTransition ? ["ORIENTATION_CHANGED_DURING_CAPTURE"] : [],
      notes: [],
    };
    const manifestJson = JSON.stringify(manifest);
    await uploadAndDeclare(token, evidenceId, sessionId, segCount, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");
    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex: segCount };
  }

  it("seals an iOS broadcast through the SHARED pipeline: ONE Evidence, server-set mode", async () => {
    const { token, sessionId, evidenceId, manifestJson, manifestPartIndex } = await stageContinuous({ segments: 3 });

    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.bound).toBe(true);
    expect(done.json().result.manifestPartIndex).toBe(manifestPartIndex);

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, acquisitionMode: true, acquisitionModeSource: true },
    });
    expect(ev.status).toBe("SIGNED");
    // The mode is the SERVER's, from the session it issued — an iOS app
    // cannot grant itself a screen-capture provenance claim.
    expect(ev.acquisitionMode).toBe("DIRECT_SCREEN_CAPTURE_IOS");
    expect(ev.acquisitionModeSource).toBe("RECORDED_AT_CREATION");

    const parts = await prisma.evidencePart.findMany({
      where: { evidenceId },
      select: { partIndex: true, artifactClass: true },
      orderBy: { partIndex: "asc" },
    });
    expect(parts.length).toBe(4); // 3 segments + 1 manifest
    expect(parts.find((p) => p.partIndex === manifestPartIndex)?.artifactClass).toBe("CAPTURE_MANIFEST");

    const bound = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
    });
    expect(bound).toBe(1);

    // The Library shows it under the SHARED screen-capture category, beside
    // the Android ones: somebody looking for screen recordings should not
    // have to know which operating system made each of them.
    const list = await call("GET", "/v1/evidence?scope=all&acquisition=DIRECT_SCREEN_CAPTURE&limit=50", token);
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json().items ?? []) as Array<{ id: string; acquisition?: { mode: string; category: string } }>;
    const mine = items.find((x) => x.id === evidenceId);
    expect(mine?.acquisition?.mode).toBe("DIRECT_SCREEN_CAPTURE_IOS");
    expect(mine?.acquisition?.category).toBe("DIRECT_SCREEN_CAPTURE");

    const again = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().result.alreadyBound).toBe(true);
  });

  it("accepts the DEVICE THE BROADCAST EXTENSION ACTUALLY REPORTS", async () => {
    // THE DEFECT THIS SUITE FOUND. validateScreenContinuousManifest required
    // device.platform === "android", so every UC-5 seal was refused
    // CONTINUOUS_MANIFEST_INVALID — on a manifest that was telling the truth.
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({ segments: 2 });
    expect(JSON.parse(manifestJson).device.platform).toBe("ios");

    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } });
    expect(ev.status).toBe("SIGNED");
  });

  it("refuses a platform that is neither — widening is not abolishing", async () => {
    const { token, sessionId, manifestJson } = await stageContinuous({ segments: 2 });
    const forged = JSON.parse(manifestJson);
    forged.device.platform = "ios_pro_max";
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, {
      manifestJson: JSON.stringify(forged),
    });
    // The manifest bytes changed, so it is no longer the artifact that was
    // declared either — refused on both counts, and never sealed.
    expect(done.statusCode).not.toBe(200);
  });

  it("refuses a NON-CONTIGUOUS segment sequence on iOS exactly as on Android", async () => {
    const { token, sessionId, manifestJson } = await stageContinuous({ segments: 3, badSequence: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
  });

  it("refuses a manifest bound to a different session", async () => {
    const { token, sessionId, manifestJson } = await stageContinuous({ segments: 2, badSessionInManifest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
  });

  it("refuses a segment substitution: a manifest digest that disagrees with the declared part", async () => {
    const { token, sessionId, manifestJson } = await stageContinuous({ segments: 3, tamperManifestDigest: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
  });

  it("fails CLOSED when a segment's stored bytes no longer match its declared digest", async () => {
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({ segments: 3, tamperStoredBytes: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode).not.toBe(200);
    const ev = await prisma.evidence.findUnique({ where: { id: evidenceId } });
    expect(ev?.status).not.toBe("SIGNED");
  });

  it("an ANDROID FRAME session cannot be sealed as an iOS broadcast", async () => {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, { type: "PHOTO", mimeType: "image/png" });
    const manifestJson = JSON.stringify({
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: sessionId,
    });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode).toBe(400);
    expect(done.json().denial).toBe("UNSUPPORTED_MODE");
  });
});
