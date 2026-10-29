/**
 * Contract A / C (2026-10-29) — ONE Start→Stop screen recording = ONE file,
 * against a real database and the real routes.
 *
 * A SINGLE_FILE continuous session (iOS broadcast or Android recording) holds
 * exactly two parts: part 0 the recording (declared SCREEN_RECORDING) and
 * part 1 the continuity manifest (CONTINUOUS_MANIFEST). It seals through the
 * SAME /continuous-complete as the legacy segmented session — which must keep
 * sealing exactly as before (installed clients, historical records).
 *
 * Also pinned here: the server-authoritative parts listing
 * (GET /v1/capture/direct-sessions/:id/parts, owner only) and the actionable
 * messages carried by PART_ALREADY_DECLARED / PART_LOST /
 * MANIFEST_SEAL_ROUTE_REQUIRED / CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH.
 *
 * Object store, signer and TSA are doubled in-process; PostgreSQL 16 is real.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION, readContinuousRecordingFacts } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://single-file-test-store.invalid/${encodeURIComponent(id(p))}`,
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
        signatureBase64: Buffer.from(`single-file-test-signature:${hex}`).toString("base64"),
        keyId: "single-file-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "single-file-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const RECORDING_MS = 20_000;

type Mode = "DIRECT_SCREEN_CAPTURE_IOS" | "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS";

describe("Contract A / C — single-file continuous recording (live PostgreSQL 16)", () => {
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

  async function openAndReserve(mode: Mode) {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, { mode, teamId: owner().teamId, deviceId: null });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    // The server saw the session open before the recording began (AUD-017).
    await prisma.captureSession.update({
      where: { id: sessionId },
      data: { startedAtUtc: new Date(Date.now() - RECORDING_MS - 5000) },
    });
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: "VIDEO",
      mimeType: "video/mp4",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    return { token, sessionId, evidenceId: reserve.json().evidence.evidenceId as string };
  }

  async function upload(token: string, evidenceId: string, partIndex: number, bytes: Buffer, mimeType: string, name: string) {
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, { partIndex, mimeType, originalFileName: name });
    expect(part.statusCode, part.body).toBe(201);
    const { bucket, key } = part.json().upload as { bucket: string; key: string };
    objects.set(`${bucket}/${key}`, bytes);
  }

  async function declare(token: string, sessionId: string, partIndex: number, digest: string, source: string, extra: Record<string, unknown> = {}) {
    return call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/${partIndex}/declaration`, token, {
      sha256: digest,
      clientReportedSource: source,
      signed: null,
      ...extra,
    });
  }

  function singleFileManifest(sessionId: string, mode: Mode, rec: { sha256: string; sizeBytes: number }, over: Record<string, unknown> = {}) {
    const start = Date.now() - RECORDING_MS - 1000;
    return {
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: sessionId,
      captureStartedAtUtc: new Date(start).toISOString(),
      captureEndedAtUtc: new Date(start + RECORDING_MS + 200).toISOString(),
      device:
        mode === "DIRECT_SCREEN_CAPTURE_IOS"
          ? { platform: "ios", osVersion: "18.1", model: "iPhone", appVersion: "2.0.0", screenW: 1179, screenH: 2556, densityDpi: 480, orientation: "portrait" }
          : { platform: "android", osVersion: "15", model: "Google Pixel 8", appVersion: "2.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
      osConsentGranted: true,
      totalDurationMs: RECORDING_MS,
      recordedSegmentCount: 1,
      recordingLayout: "SINGLE_FILE",
      segments: [
        {
          role: "screen_recording",
          partIndex: 0,
          sequence: 0,
          expectedSha256: rec.sha256,
          sizeBytes: rec.sizeBytes,
          mediaType: "video/mp4",
          startedAtOffsetMs: 0,
          durationMs: RECORDING_MS,
          widthPx: 1080,
          heightPx: 2400,
          orientation: "portrait",
        },
      ],
      orientationTimeline: [{ atOffsetMs: 0, orientation: "portrait" }],
      pauses: [],
      droppedFrameCount: 0,
      audioTracks: ["APP", "MICROPHONE"],
      sessionCompleteness: "COMPLETE_SESSION",
      terminationReason: "USER_STOPPED",
      limitations: [],
      notes: [],
      ...over,
    };
  }

  /** Stage a SINGLE_FILE session up to /continuous-complete. */
  async function stageSingleFile(
    mode: Mode,
    opts: {
      manifestOver?: Record<string, unknown>;
      recordingSource?: string;
      statedSizeDelta?: number;
      skipManifestDeclaration?: boolean;
    } = {},
  ) {
    const { token, sessionId, evidenceId } = await openAndReserve(mode);
    const recording = Buffer.from(`mp4-${randomBytes(64).toString("hex")}`);
    await upload(token, evidenceId, 0, recording, "video/mp4", `screen-recording-${new Date().toISOString()}.mp4`);
    const recDigest = sha256(recording);
    const d0 = await declare(token, sessionId, 0, recDigest, opts.recordingSource ?? "SCREEN_RECORDING");
    expect(d0.statusCode, d0.body).toBe(201);
    const manifest = singleFileManifest(
      sessionId,
      mode,
      { sha256: recDigest, sizeBytes: recording.length + (opts.statedSizeDelta ?? 0) },
      opts.manifestOver,
    );
    const manifestJson = JSON.stringify(manifest);
    if (!opts.skipManifestDeclaration) {
      const mBytes = Buffer.from(manifestJson, "utf8");
      await upload(token, evidenceId, 1, mBytes, "application/json", "continuity-manifest.json");
      const d1 = await declare(token, sessionId, 1, sha256(mBytes), "CONTINUOUS_MANIFEST");
      expect(d1.statusCode, d1.body).toBe(201);
    }
    return { token, sessionId, evidenceId, manifestJson, recDigest };
  }

  async function persistedRecordingFacts(sessionId: string) {
    const rows = await prisma.captureTrustEventRecord.findMany({
      where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_RECEIVED" },
      select: { payload: true },
    });
    const facts = rows.map((r) => r.payload as Record<string, unknown>).filter((p) => p["stage"] === "manifest_facts");
    expect(facts.length).toBe(1);
    return readContinuousRecordingFacts(facts[0]);
  }

  for (const mode of ["DIRECT_SCREEN_CAPTURE_IOS", "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS"] as const) {
    it(`${mode}: seals ONE recording file + its manifest into ONE Evidence`, async () => {
      const { token, sessionId, evidenceId, manifestJson } = await stageSingleFile(mode);
      const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().result.bound).toBe(true);
      expect(done.json().result.manifestPartIndex).toBe(1);

      const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true, acquisitionMode: true } });
      expect(ev.status).toBe("SIGNED");
      expect(ev.acquisitionMode).toBe(mode);
      const parts = await prisma.evidencePart.findMany({ where: { evidenceId }, select: { partIndex: true, artifactClass: true }, orderBy: { partIndex: "asc" } });
      expect(parts).toEqual([
        { partIndex: 0, artifactClass: "ORIGINAL" },
        { partIndex: 1, artifactClass: "CAPTURE_MANIFEST" },
      ]);
      const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
      expect(session.status).toBe("BOUND");
      expect(session.endReason).toBe("CONTINUOUS_COMPLETE_SESSION");

      const facts = await persistedRecordingFacts(sessionId);
      expect(facts?.layout).toBe("SINGLE_FILE");
      expect(facts?.audioTracks).toEqual(["APP", "MICROPHONE"]);
      expect(facts?.recording?.partIndex).toBe(0);

      // Contract C — after the seal every part reads UPLOADED.
      const listed = await call("GET", `/v1/capture/direct-sessions/${sessionId}/parts`, token);
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().parts.map((p: { partIndex: number; state: string; source: string }) => [p.partIndex, p.state, p.source])).toEqual([
        [0, "UPLOADED", "SCREEN_RECORDING"],
        [1, "UPLOADED", "CONTINUOUS_MANIFEST"],
      ]);
    });
  }

  it("persists orientation changes, pauses, dropped frames and a silent track as recording facts", async () => {
    const { token, sessionId, evidenceId, manifestJson } = await stageSingleFile("DIRECT_SCREEN_CAPTURE_IOS", {
      manifestOver: {
        sessionCompleteness: "INTERRUPTED_SESSION",
        orientationTimeline: [
          { atOffsetMs: 0, orientation: "portrait" },
          { atOffsetMs: 8000, orientation: "landscape", widthPx: 2556, heightPx: 1179 },
        ],
        pauses: [{ startOffsetMs: 12000, endOffsetMs: 15000 }],
        droppedFrameCount: 4,
        audioTracks: [],
        limitations: ["ORIENTATION_CHANGED_DURING_CAPTURE", "BROADCAST_PAUSED", "FRAMES_DROPPED", "AUDIO_NOT_CAPTURED"],
      },
    });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } })).status).toBe("SIGNED");
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
    expect(session.endReason).toBe("CONTINUOUS_INTERRUPTED_SESSION");
    const facts = await persistedRecordingFacts(sessionId);
    expect(facts).toMatchObject({
      layout: "SINGLE_FILE",
      audioTracks: [],
      droppedFrameCount: 4,
      pauses: [{ startOffsetMs: 12000, endOffsetMs: 15000 }],
      orientationTimeline: [
        { atOffsetMs: 0, orientation: "portrait" },
        { atOffsetMs: 8000, orientation: "landscape", widthPx: 2556, heightPx: 1179 },
      ],
    });
  });

  it("refuses a stated size that is not the stored size, with an actionable message", async () => {
    const { token, sessionId, evidenceId, manifestJson } = await stageSingleFile("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", { statedSizeDelta: 7 });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(422);
    const body = done.json() as { denial: string; message?: string; detail?: string };
    expect(body.denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
    expect(body.message).toMatch(/Rebuild the manifest/);
    expect(body.detail).toMatch(/part 0: \d+ bytes stored, the manifest states \d+/);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } })).status).not.toBe("SIGNED");
    // The claim was released: the session is still sealable.
    const s = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
    expect(s).toEqual({ status: "ACTIVE", endReason: null });
  });

  it("refuses a missing manifest (empty, or never declared)", async () => {
    const empty = await stageSingleFile("DIRECT_SCREEN_CAPTURE_IOS");
    const noManifest = await call("POST", `/v1/capture/direct-sessions/${empty.sessionId}/continuous-complete`, empty.token, { manifestJson: "" });
    expect(noManifest.statusCode, noManifest.body).toBe(400);

    const undeclared = await stageSingleFile("DIRECT_SCREEN_CAPTURE_IOS", { skipManifestDeclaration: true });
    const done = await call("POST", `/v1/capture/direct-sessions/${undeclared.sessionId}/continuous-complete`, undeclared.token, {
      manifestJson: undeclared.manifestJson,
    });
    expect(done.statusCode, done.body).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_DIGEST_UNDECLARED");
  });

  it("refuses a recording declared as a SEGMENT in a single-file session (and states why)", async () => {
    const { token, sessionId, manifestJson } = await stageSingleFile("DIRECT_SCREEN_CAPTURE_IOS", { recordingSource: "SCREEN_SEGMENT" });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
    expect(done.json().detail).toMatch(/expects SCREEN_RECORDING/);
  });

  it("refuses a recording past the SESSION byte bound before any hashing", async () => {
    const { token, sessionId, manifestJson } = await stageSingleFile("DIRECT_SCREEN_CAPTURE_IOS", { statedSizeDelta: 600 * 1024 * 1024 });
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(422);
    expect(done.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
    expect(done.json().detail).toMatch(/session byte bound/);
  });

  it("LEGACY: a segmented session (no recordingLayout) still seals exactly as before", async () => {
    const mode = "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" as const;
    const { token, sessionId, evidenceId } = await openAndReserve(mode);
    const segs = [0, 1].map(() => Buffer.from(`segment-${randomBytes(16).toString("hex")}`));
    for (const [i, b] of segs.entries()) {
      await upload(token, evidenceId, i, b, "video/mp4", `segment-${i}.mp4`);
      const d = await declare(token, sessionId, i, sha256(b), "SCREEN_SEGMENT", { recordedThrough: i + 1 });
      expect(d.statusCode, d.body).toBe(201);
    }
    const base = singleFileManifest(sessionId, mode, { sha256: "0".repeat(64), sizeBytes: 0 });
    const legacy: Record<string, unknown> = { ...base };
    for (const k of ["recordingLayout", "orientationTimeline", "pauses", "droppedFrameCount", "audioTracks"]) delete legacy[k];
    legacy.recordedSegmentCount = 2;
    legacy.segments = segs.map((b, i) => ({
      role: "screen_segment",
      partIndex: i,
      sequence: i,
      expectedSha256: sha256(b),
      sizeBytes: b.length,
      mediaType: "video/mp4",
      startedAtOffsetMs: i * (RECORDING_MS / 2),
      durationMs: RECORDING_MS / 2,
      widthPx: 1080,
      heightPx: 2400,
      orientation: "portrait",
    }));
    const manifestJson = JSON.stringify(legacy);
    const mBytes = Buffer.from(manifestJson, "utf8");
    await upload(token, evidenceId, 2, mBytes, "application/json", "continuity-manifest.json");
    expect((await declare(token, sessionId, 2, sha256(mBytes), "CONTINUOUS_MANIFEST")).statusCode).toBe(201);
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.manifestPartIndex).toBe(2);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } })).status).toBe("SIGNED");
    const facts = await persistedRecordingFacts(sessionId);
    expect(facts?.layout).toBe("SEGMENTED");
    expect(facts?.audioTracks).toBeNull();
  });

  it("contract C: lists declared parts for the owner only, with DECLARED / UPLOADED / LOST states", async () => {
    const mode = "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" as const;
    const { token, sessionId, evidenceId } = await openAndReserve(mode);
    // part 0 uploaded + declared; part 1 declared, bytes never landed, then stated lost;
    // part 2 declared with no upload yet.
    const b0 = Buffer.from(`seg0-${randomBytes(8).toString("hex")}`);
    await upload(token, evidenceId, 0, b0, "video/mp4", "segment-0.mp4");
    expect((await declare(token, sessionId, 0, sha256(b0), "SCREEN_SEGMENT", { recordedThrough: 1 })).statusCode).toBe(201);
    expect((await declare(token, sessionId, 1, "1".repeat(64), "SCREEN_SEGMENT", { recordedThrough: 2 })).statusCode).toBe(201);
    const lost = await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/1/loss`, token, {});
    expect(lost.statusCode, lost.body).toBe(201);
    expect((await declare(token, sessionId, 2, "2".repeat(64), "SCREEN_SEGMENT", { recordedThrough: 3 })).statusCode).toBe(201);

    const listed = await call("GET", `/v1/capture/direct-sessions/${sessionId}/parts`, token);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      parts: [
        { partIndex: 0, sha256: sha256(b0), state: "UPLOADED", source: "SCREEN_SEGMENT" },
        { partIndex: 1, sha256: "1".repeat(64), state: "LOST", source: "SCREEN_SEGMENT" },
        { partIndex: 2, sha256: "2".repeat(64), state: "DECLARED", source: "SCREEN_SEGMENT" },
      ],
    });

    // Another member of the same workspace is not the session's owner.
    const other = await call("GET", `/v1/capture/direct-sessions/${sessionId}/parts`, owner().memberToken);
    expect(other.statusCode, other.body).toBe(404);
    expect(other.json().denial).toBe("SESSION_NOT_FOUND");
    // A different workspace's owner neither.
    const foreign = await call("GET", `/v1/capture/direct-sessions/${sessionId}/parts`, harness.fixtures.teamB.ownerToken);
    expect(foreign.statusCode, foreign.body).toBe(404);
    // Unauthenticated.
    const anon = await app.inject({ method: "GET", url: `/v1/capture/direct-sessions/${sessionId}/parts` });
    expect(anon.statusCode).toBe(401);

    // The codes a client maps carry actionable messages; the codes are unchanged.
    const conflict = await declare(token, sessionId, 0, "3".repeat(64), "SCREEN_SEGMENT");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().denial).toBe("PART_ALREADY_DECLARED");
    expect(conflict.json().message).toMatch(/next free part number/);
    const relost = await declare(token, sessionId, 1, "1".repeat(64), "SCREEN_SEGMENT");
    expect(relost.statusCode).toBe(409);
    expect(relost.json().denial).toBe("PART_LOST");
    expect(relost.json().message).toMatch(/stated lost/);
    const generic = await call("POST", `/v1/capture/direct-sessions/${sessionId}/complete`, token, {});
    expect(generic.statusCode).toBe(409);
    expect(generic.json().denial).toBe("MANIFEST_SEAL_ROUTE_REQUIRED");
    expect(generic.json().message).toMatch(/own route/);
    expect(generic.json().detail).toMatch(/continuous-complete/);
  });
});
