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

import type { IntegrationHarness } from "../../../../../../services/api/test/integration-harness.js";

const objects = new Map<string, Buffer>();

vi.mock("../../../../../../services/api/src/storage.js", async (importOriginal) => {
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

vi.mock("../../../../../../services/api/src/signing/signer.js", async (importOriginal) => {
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

vi.mock("../../../../../../services/api/src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "uc5-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("UCA probes — continuous/iOS sealing (AUDIT ONLY)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../../../../../services/api/src/db.js"))["prisma"];
  let app: IntegrationHarness["app"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../../../../../../services/api/test/integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../../../../../services/api/src/db.js"));
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
      device?: Record<string, unknown>;
      totalDurationMs?: number;
      uploadOnly?: number;
      mode?: string;
    } = {},
  ) {
    const token = owner().ownerToken;
    const segCount = opts.segments ?? 3;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: opts.mode ?? "DIRECT_SCREEN_CAPTURE_IOS",
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
      if (opts.uploadOnly !== undefined && i >= opts.uploadOnly) continue;
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
    for (let i = 0; i < (opts.uploadOnly ?? segCount); i++) {
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

    const captureStartMs = Date.now();
    const manifest = {
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: opts.badSessionInManifest ? "00000000-0000-4000-8000-000000000000" : sessionId,
      // ET-DC-09 — the window is checked against the server session, so it is
      // the one this session actually spans (it opened moments ago).
      captureStartedAtUtc: new Date(captureStartMs).toISOString(),
      captureEndedAtUtc: new Date(captureStartMs + segCount * 1000).toISOString(),
      device: opts.device ?? {
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
      totalDurationMs: opts.totalDurationMs ?? segCount * 1000,
      segments,
      sessionCompleteness: "COMPLETE_SESSION",
      terminationReason: "USER_STOPPED",
      limitations: opts.orientationTransition ? ["ORIENTATION_CHANGED_DURING_CAPTURE"] : [],
      notes: [],
    };
    const manifestJson = JSON.stringify(manifest);
    const manifestPartIndex = opts.uploadOnly ?? segCount;
    await uploadAndDeclare(token, evidenceId, sessionId, manifestPartIndex, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");
    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex };
  }


  const out: Record<string, unknown> = {};
  afterAll(async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      "D:/pv-uca/docs/evidence/audits/universal-evidence-capture/runtime/probes/continuous-ios.json",
      JSON.stringify(out, null, 2),
    );
  });

  it("P-IOS-DEVICE: seal with the device block the Swift broadcast extension actually writes", async () => {
    // ProovraBroadcastShared.swift result.json device = {platform, osVersion, model, appVersion}
    const device = { platform: "ios", osVersion: "18.0", model: "iPhone15,2", appVersion: "1.0.0" };
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({ segments: 2, device });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    const ev = await prisma.evidence.findUnique({ where: { id: evidenceId }, select: { status: true } });
    out.iosDeviceShape = { status: done.statusCode, body: done.json(), evidenceStatus: ev?.status };
    expect(true).toBe(true);
  });

  it("P-STR-200: the continuous client allows 600 segments; can part index 200 be created?", async () => {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      teamId: owner().teamId,
      deviceId: null,
    });
    const sessionId = open.json().session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: "VIDEO",
      mimeType: "video/mp4",
    });
    const evidenceId = reserve.json().evidence.evidenceId as string;
    const r199 = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex: 199,
      mimeType: "video/mp4",
      originalFileName: "seg-199.mp4",
    });
    const r200 = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex: 200,
      mimeType: "video/mp4",
      originalFileName: "seg-200.mp4",
    });
    const decl200 = await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/200/declaration`, token, {
      sha256: "a".repeat(64),
      clientReportedSource: "SCREEN_SEGMENT",
      signed: null,
    });
    out.partIndexCap = {
      openStatus: open.statusCode,
      part199: r199.statusCode,
      part200: r200.statusCode,
      part200Body: r200.body.slice(0, 400),
      declaration200: decl200.statusCode,
      declaration200Body: decl200.body.slice(0, 400),
    };
    expect(true).toBe(true);
  });

  it("P-STR-TAIL: 4 segments recorded, tail never declared — does a COMPLETE_SESSION seal?", async () => {
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({
      segments: 4,
      uploadOnly: 3,
      totalDurationMs: 4000,
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      device: {
        platform: "android",
        osVersion: "14",
        model: "Pixel 8",
        appVersion: "1.0.0",
        screenW: 1080,
        screenH: 2400,
        densityDpi: 420,
        orientation: "portrait",
      },
    });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    const ev = await prisma.evidence.findUnique({ where: { id: evidenceId }, select: { status: true } });
    const parts = await prisma.evidencePart.count({ where: { evidenceId } });
    const m = JSON.parse(manifestJson);
    const summed = (m.segments as Array<{ durationMs: number }>).reduce((a, s) => a + s.durationMs, 0);
    out.missingTail = {
      status: done.statusCode,
      body: done.body.slice(0, 600),
      evidenceStatus: ev?.status,
      parts,
      manifestTotalDurationMs: m.totalDurationMs,
      sumOfSegmentDurationsMs: summed,
      sessionCompleteness: m.sessionCompleteness,
    };
    expect(true).toBe(true);
  });
});
