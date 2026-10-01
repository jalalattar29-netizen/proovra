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

import { readFileSync } from "node:fs";

import { SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION } from "@proovra/shared";

// UC-IOS-001 — the SAME builder the iOS app runs, fed the SAME native result
// the Swift code produces (the contract fixture the mobile suite pins against
// the Swift sources).
import { buildContinuousManifest } from "../../../apps/mobile/src/continuous-manifest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();
type NativeSegment = {
  sequence: number;
  startedAtOffsetMs: number;
  durationMs: number;
  widthPx: number;
  heightPx: number;
  orientation: "portrait" | "landscape";
};
type MutableManifest = {
  device: Record<string, unknown>;
  segments: Array<{ sequence: number; partIndex: number } & Record<string, unknown>>;
} & Record<string, unknown>;
const IOS_FIXTURE: {
  jsResult: Parameters<typeof buildContinuousManifest>[1];
  jsSegments: NativeSegment[];
  legacyV1DeviceBlock: Record<string, unknown>;
} = JSON.parse(
  readFileSync(new URL("../../../apps/mobile/test/fixtures/ios-broadcast-result.json", import.meta.url), "utf8"),
);

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

  /**
   * Stage a full iOS continuous capture up to (but not including)
   * /continuous-complete — FROM THE NATIVE CONTRACT, not from a hand-written
   * device block (UC-IOS-001 / UC-TQ-001): the manifest is built by the mobile
   * client's own builder (apps/mobile/src/continuous-manifest.ts) from the
   * exact result + segment maps the Swift code produces
   * (apps/mobile/test/fixtures/ios-broadcast-result.json). Only the times are
   * moved to "now", because the server checks the capture window against the
   * session it just opened. `mutate` edits the manifest BEFORE it is uploaded
   * and declared, so a negative case is refused by the gate it targets and not
   * by a digest mismatch (UC-TQ-005).
   */
  async function stageContinuous(
    opts: {
      segments?: number;
      badSequence?: boolean;
      badSessionInManifest?: boolean;
      tamperManifestDigest?: boolean;
      reverseUpload?: boolean;
      tamperStoredBytes?: boolean;
      mutate?: (manifest: MutableManifest) => void;
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

    const nativeSegments = IOS_FIXTURE.jsSegments.slice(0, segCount);
    const segmentBytes = nativeSegments.map((_, i) =>
      Buffer.from(`segment-${i}-${randomBytes(8).toString("hex")}`),
    );
    const uploadOrder = opts.reverseUpload ? [...segmentBytes.keys()].reverse() : [...segmentBytes.keys()];
    const declared = new Map<number, { sha256: string; sizeBytes: number }>();
    for (const i of uploadOrder) {
      const d = await uploadAndDeclare(token, evidenceId, sessionId, i, segmentBytes[i]!, "SCREEN_SEGMENT");
      declared.set(i, d);
      if (opts.tamperStoredBytes && i === 0) {
        for (const key of objects.keys()) {
          // Same LENGTH, different bytes: only the digest recompute can catch it.
          if (objects.get(key) === segmentBytes[0]) objects.set(key, Buffer.alloc(segmentBytes[0]!.length, 0x78));
        }
      }
    }

    // The Swift result map, re-timed to this session.
    const lastEnd = nativeSegments.reduce((m, s) => Math.max(m, s.startedAtOffsetMs + s.durationMs), 0);
    const start = Date.now() - lastEnd - 500;
    const jsResult = {
      ...structuredClone(IOS_FIXTURE.jsResult),
      captureStartedAtUtc: new Date(start).toISOString(),
      captureEndedAtUtc: new Date(start + lastEnd + 200).toISOString(),
      segmentCount: segCount,
      totalDurationMs: lastEnd,
    };
    const manifest = buildContinuousManifest(
      opts.badSessionInManifest ? "00000000-0000-4000-8000-000000000000" : sessionId,
      jsResult,
      nativeSegments.map((s: NativeSegment, i: number) => ({
        partIndex: s.sequence,
        sequence: s.sequence,
        sha256Hex: opts.tamperManifestDigest && i === 0 ? "f".repeat(64) : declared.get(i)!.sha256,
        sizeBytes: declared.get(i)!.sizeBytes,
        startedAtOffsetMs: s.startedAtOffsetMs,
        durationMs: s.durationMs,
        widthPx: s.widthPx,
        heightPx: s.heightPx,
        orientation: s.orientation,
      })),
    ) as unknown as MutableManifest;
    if (opts.badSequence) {
      // A gap: segment 1 claims sequence 2 (and so part 2) — a missing segment.
      manifest.segments = manifest.segments.map((s, i) =>
        i >= 1 ? { ...s, sequence: s.sequence + 1, partIndex: s.partIndex + 1 } : s,
      );
    }
    opts.mutate?.(manifest);
    const manifestJson = JSON.stringify(manifest);
    const manifestPartIndex = segCount;
    await uploadAndDeclare(token, evidenceId, sessionId, manifestPartIndex, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");
    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex };
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

  it("accepts the DEVICE THE BROADCAST EXTENSION ACTUALLY REPORTS (UC-IOS-001: the Swift result, verbatim)", async () => {
    // THE DEFECT THIS SUITE FOUND, twice. First the validator required
    // device.platform === "android"; then the Swift device map carried 4 of
    // the 8 required keys while this suite hand-built all 8, so it passed
    // against a payload the device never produced. The device block now comes
    // from the Swift contract fixture through the app's own builder.
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({ segments: 2 });
    expect(JSON.parse(manifestJson).device).toEqual(IOS_FIXTURE.jsResult.device);

    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } });
    expect(ev.status).toBe("SIGNED");
  });

  it("refuses a platform that is neither — widening is not abolishing (UC-TQ-005: the platform gate alone)", async () => {
    // The forged manifest IS the declared part, so no digest gate can refuse
    // it: only the platform allow-list does, with its own status and denial.
    const { token, sessionId, evidenceId, manifestJson } = await stageContinuous({
      segments: 2,
      mutate: (m) => {
        m.device.platform = "ios_pro_max";
      },
    });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } });
    expect(ev.status).not.toBe("SIGNED");
    // And the ANDROID platform on an iOS session is refused by the same gate.
    const android = await stageContinuous({
      segments: 2,
      mutate: (m) => {
        m.device.platform = "android";
      },
    });
    const refused = await call("POST", `/v1/capture/direct-sessions/${android.sessionId}/continuous-complete`, token, {
      manifestJson: android.manifestJson,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
  });

  it("UC-IOS-001: a malformed native device block is refused with the specific validator error", async () => {
    const { validateScreenContinuousManifest } = await import("@proovra/shared");
    const { token, sessionId, manifestJson } = await stageContinuous({
      segments: 2,
      mutate: (m) => {
        // The pre-remediation Swift map: platform/osVersion/model/appVersion only.
        m.device = { ...IOS_FIXTURE.legacyV1DeviceBlock };
        delete m.device._comment;
      },
    });
    expect(validateScreenContinuousManifest(JSON.parse(manifestJson))).toEqual({ ok: false, error: "invalid device.screenW" });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
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
    // UC-TQ-005 — pinned: the digest gate's own refusal, not "anything but 200".
    expect(done.statusCode, done.body).toBe(409);
    expect(done.json().denial).toBe("CAPTURE_DIGEST_MISMATCH");
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
