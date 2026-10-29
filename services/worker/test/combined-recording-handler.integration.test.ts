/**
 * 2026-10-29 — processCombineScreenRecordingJob END TO END against a REAL
 * PostgreSQL (migrated through 20281029000000) and a REAL S3 store (local
 * MinIO, its own Object-Lock bucket), with REAL ffmpeg. Nothing in the
 * pipeline is replaced: the run tracker, the eligibility gate, the manifest
 * facts lookup, the streamed + hashed reads at recorded versions, the combine,
 * the multipart upload with the record's artifact lock, the derived-asset
 * writer and the supersede all run for real. Only the worker's `db.js` (to
 * point Prisma at TEST_DATABASE_URL) and `storage.js` (to point its S3 client
 * at MinIO) are re-bound.
 *
 * Seeds a sealed legacy SEGMENTED continuous record exactly as the seal leaves
 * it: three ffmpeg-generated segments uploaded with versions (the third after
 * a 3 s gap), the continuity manifest part, and the CAPTURE_ARTIFACT_RECEIVED
 * manifest-facts trust event built by `continuousCaptureManifestFacts`.
 *
 * Asserts: derived row COMPLETED with lineage sources / gaps / sourceSetSha256;
 * the object stored with a VersionId and a GOVERNANCE retention; the stored
 * bytes decode to exactly the sources' frame count; a second generation
 * supersedes (keeps) the first; the temp dir is removed; a tampered segment
 * fails closed with no derived row and no object.
 *
 * DB-dependent (same convention as the UC-4 handler suite): runs where
 * TEST_DATABASE_URL points at a disposable migrated database AND MinIO answers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DB_URL = process.env.TEST_DATABASE_URL;
const S3_ENDPOINT = process.env.COMBINE_TEST_S3_ENDPOINT ?? "http://127.0.0.1:59000";

// The record's artifact lock: Object Lock on, GOVERNANCE (bypassable for cleanup).
process.env.S3_OBJECT_LOCK_ENABLED = "true";
process.env.S3_OBJECT_LOCK_MODE = "GOVERNANCE";

vi.mock("../src/db.js", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { Pool } = await import("pg");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://invalid/none" });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), __pool: pool };
});

vi.mock("../src/storage.js", async () => {
  const sdk = await import("@aws-sdk/client-s3");
  const s3 = new sdk.S3Client({
    region: "us-east-1",
    endpoint: process.env.COMBINE_TEST_S3_ENDPOINT ?? "http://127.0.0.1:59000",
    forcePathStyle: true,
    credentials: { accessKeyId: "point7-local-minio", secretAccessKey: "point7-local-minio-secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return {
    s3,
    isObjectLockEnabled: () => process.env.S3_OBJECT_LOCK_ENABLED === "true",
    getObjectStream: async (p: { bucket: string; key: string; versionId?: string | null }) => {
      const res = await s3.send(
        new sdk.GetObjectCommand({ Bucket: p.bucket, Key: p.key, ...(p.versionId ? { VersionId: p.versionId } : {}) }),
      );
      if (!res.Body) throw new Error("S3 returned empty body");
      return res.Body;
    },
    deleteObjectVersions: async (p: { bucket: string; key: string; versionId?: string | null }) => {
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: p.bucket, Key: p.key, VersionId: p.versionId ?? undefined }));
      return { deleted: true, retainedVersions: [], failed: [] };
    },
  };
});

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { continuousCaptureManifestFacts, screenRecordingCombineIdempotencyKey, screenRecordingSourceSetCanonical, readScreenRecordingCombineLineage, CAPTURE_MANIFEST_FACTS_STAGE, type ScreenContinuousManifest } from "@proovra/shared";
import { enqueueMediaIntelligenceRun } from "@proovra/shared-runtime/media-intelligence";

import { prisma } from "../src/db.js";
import { s3 } from "../src/storage.js";
import { detectFfmpegCapability } from "../src/ffmpeg-capability.js";
import { processCombineScreenRecordingJob } from "../src/combined-recording/combined-recording.handler.js";
import { readVideoPackets, runFfmpeg } from "../src/combined-recording/media-tools.js";

async function minioUp(): Promise<boolean> {
  try {
    return (await fetch(`${S3_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
const runIf = DB_URL && (await minioUp()) ? describe : describe.skip;

const BUCKET = `combine-e2e-${randomUUID().slice(0, 8)}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let ff = "";
let fixtures = "";
let tmpRoot = "";
const savedTmp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };

runIf("combine_screen_recording handler (live PostgreSQL + MinIO + ffmpeg)", () => {
  beforeAll(async () => {
    const cap = await detectFfmpegCapability();
    if (!cap.ok) throw new Error(cap.reason);
    ff = cap.ffmpegPath;
    fixtures = await mkdtemp(path.join(os.tmpdir(), "proovra-combine-fixtures-"));
    // A private temp root: the handler's mkdtemp lands here, so "removed" is provable.
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "proovra-combine-root-"));
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
    await prisma.$connect();
  });

  afterAll(async () => {
    Object.assign(process.env, savedTmp);
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET })).catch(() => null);
    for (const v of [...(versions?.Versions ?? []), ...(versions?.DeleteMarkers ?? [])]) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: v.Key!, VersionId: v.VersionId, BypassGovernanceRetention: true }))
        .catch(() => undefined);
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    await prisma.$disconnect();
    const mod = (await import("../src/db.js")) as unknown as { __pool?: { end(): Promise<void> } };
    await mod.__pool?.end();
    for (const d of [fixtures, tmpRoot]) if (d) await rm(d, { recursive: true, force: true });
  });

  /** One 2 s, 12 fps, 360x640 H.264 segment with a distinct marker colour. */
  async function makeSegment(seq: number): Promise<Buffer> {
    const file = path.join(fixtures, `seg-${randomUUID()}.mp4`);
    const r = await runFfmpeg(
      ff,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=12:duration=2",
        "-vf", `drawbox=x=0:y=0:w=40:h=40:color=${["red", "green", "blue"][seq]}:t=fill`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12", file],
      { timeoutMs: 30_000 },
    );
    if (!r.ok) throw new Error(r.reason);
    return readFile(file);
  }

  async function put(key: string, body: Buffer, contentType: string): Promise<string> {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentMD5: createHash("md5").update(body).digest("base64"),
      }),
    );
    return res.VersionId!;
  }

  /** A sealed legacy SEGMENTED continuous record, as the seal leaves it. */
  async function seedSealedSegmentedRecord() {
    const user = await prisma.user.create({ data: { provider: "EMAIL", providerUserId: `combine-${randomUUID()}` } });
    const org = await prisma.organization.create({ data: { name: "Combine Org" } });
    const team = await prisma.team.create({
      data: { name: "Combine Team", ownerUserId: user.id, organizationId: org.id, workspaceKind: "ORGANIZATION" },
    });
    const sealedAt = new Date();
    const evidence = await prisma.evidence.create({
      data: {
        teamId: team.id,
        organizationId: org.id,
        ownerUserId: user.id,
        type: "VIDEO",
        status: "SIGNED",
        signedAtUtc: sealedAt,
        acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
        acquisitionModeSource: "RECORDED_AT_CREATION",
      } as never,
    });
    // Segment starts (ms): 0, 2000, 7000 → a real 3 s gap before segment 2.
    const starts = [0, 2000, 7000];
    const segments: ScreenContinuousManifest["segments"] = [];
    const parts: Array<{ id: string; partIndex: number; key: string; versionId: string; bytes: Buffer }> = [];
    for (let i = 0; i < 3; i += 1) {
      const bytes = await makeSegment(i);
      const key = `originals/${evidence.id}/segment-${i}.mp4`;
      const versionId = await put(key, bytes, "video/mp4");
      const row = await prisma.evidencePart.create({
        data: {
          evidenceId: evidence.id,
          partIndex: i,
          storageBucket: BUCKET,
          storageKey: key,
          storageVersionId: versionId,
          sha256: sha(bytes),
          sizeBytes: BigInt(bytes.length),
          mimeType: "video/mp4",
          artifactClass: "ORIGINAL",
          originalFileName: `segment-${i}.mp4`,
        },
      });
      parts.push({ id: row.id, partIndex: i, key, versionId, bytes });
      segments.push({
        role: "screen_segment",
        partIndex: i,
        sequence: i,
        expectedSha256: sha(bytes),
        sizeBytes: bytes.length,
        mediaType: "video/mp4",
        startedAtOffsetMs: starts[i]!,
        durationMs: 2000,
        widthPx: 360,
        heightPx: 640,
        orientation: "portrait",
      });
    }
    const session = await prisma.captureSession.create({
      data: { teamId: team.id, ownerUserId: user.id, finalizedEvidenceId: evidence.id } as never,
    });
    const manifest: ScreenContinuousManifest = {
      schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
      captureSessionId: session.id,
      captureStartedAtUtc: new Date(sealedAt.getTime() - 10_000).toISOString(),
      captureEndedAtUtc: sealedAt.toISOString(),
      device: { platform: "android", osVersion: "14", model: "Pixel", appVersion: "1.0.0", screenW: 360, screenH: 640, densityDpi: 420, orientation: "portrait" },
      osConsentGranted: true,
      totalDurationMs: 9000,
      recordedSegmentCount: 3,
      segments,
      sessionCompleteness: "INTERRUPTED_SESSION",
      terminationReason: "USER_STOPPED",
      limitations: ["BROADCAST_PAUSED"],
      notes: [],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestKey = `originals/${evidence.id}/continuous-capture-manifest.json`;
    const manifestVersion = await put(manifestKey, manifestBytes, "application/json");
    await prisma.evidencePart.create({
      data: {
        evidenceId: evidence.id,
        partIndex: 3,
        storageBucket: BUCKET,
        storageKey: manifestKey,
        storageVersionId: manifestVersion,
        sha256: sha(manifestBytes),
        sizeBytes: BigInt(manifestBytes.length),
        mimeType: "application/json",
        artifactClass: "CAPTURE_MANIFEST",
        originalFileName: "continuous-capture-manifest.json",
      },
    });
    // The seal's manifest-facts record (recordManifestFacts → CAPTURE_ARTIFACT_RECEIVED).
    const facts = continuousCaptureManifestFacts(manifest, { manifestSha256: sha(manifestBytes), manifestPartIndex: 3 });
    await prisma.captureTrustEventRecord.create({
      data: {
        teamId: team.id,
        captureSessionId: session.id,
        evidenceId: null,
        code: "CAPTURE_ARTIFACT_RECEIVED",
        sequence: 1,
        eventHash: sha(Buffer.from(randomUUID())),
        payload: { stage: CAPTURE_MANIFEST_FACTS_STAGE, facts },
      } as never,
    });
    return { teamId: team.id, evidenceId: evidence.id, parts };
  }

  async function newRun(teamId: string, evidenceId: string, generation: number) {
    const r = await enqueueMediaIntelligenceRun(
      { teamId, evidenceId, kind: "combine_screen_recording", idempotencyKey: screenRecordingCombineIdempotencyKey(evidenceId, generation) },
      prisma,
    );
    if (!r.ok) throw new Error("tracker_unavailable");
    return r.run.id;
  }

  async function runJob(teamId: string, evidenceId: string, runId: string) {
    process.env.TEMP = tmpRoot;
    process.env.TMP = tmpRoot;
    process.env.TMPDIR = tmpRoot;
    try {
      return await processCombineScreenRecordingJob({ jobId: "e2e", teamId, evidenceId, runId });
    } finally {
      Object.assign(process.env, savedTmp);
    }
  }

  const combinedRows = (evidenceId: string) =>
    prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId, assetKind: "screen_recording_combined" },
      orderBy: { createdAtUtc: "asc" },
    });

  it("combines, stores locked + versioned, records lineage; a regeneration supersedes and keeps generation 1", async () => {
    const { teamId, evidenceId, parts } = await seedSealedSegmentedRecord();

    const run1 = await newRun(teamId, evidenceId, 1);
    await runJob(teamId, evidenceId, run1);
    const r1 = await prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id: run1 } });
    expect(r1.lastError).toBeNull();
    expect(r1.status).toBe("COMPLETED");

    const [g1] = await combinedRows(evidenceId);
    expect(g1).toMatchObject({
      status: "COMPLETED",
      variantKey: "combined-v1",
      transformation: "screen-recording-combine/v1",
      contentType: "video/mp4",
      evidencePartId: parts[0]!.id,
      sourceSha256AtGeneration: sha(parts[0]!.bytes),
      widthPx: 360,
      heightPx: 640,
    });
    expect(g1!.storageVersionId).toBeTruthy();
    const lineage = readScreenRecordingCombineLineage(g1!.generationParameters)!;
    expect(lineage.mode).toBe("REMUX");
    expect(lineage.sources.map((s) => [s.partIndex, s.sha256, s.versionId, s.combinedStartMs])).toEqual(
      parts.map((p, i) => [p.partIndex, sha(p.bytes), p.versionId, [0, 2000, 7000][i]]),
    );
    expect(lineage.sourceSetSha256).toBe(
      sha(Buffer.from(screenRecordingSourceSetCanonical(parts.map((p) => ({ partIndex: p.partIndex, sha256: sha(p.bytes) }))))),
    );
    expect(lineage.gaps).toEqual([
      { atMs: 4000, durationMs: 3000, cause: "TIMELINE_GAP", missingSequences: [], limitations: ["BROADCAST_PAUSED"] },
    ]);
    expect(lineage.completeness).toBe("PARTIAL");
    expect(lineage.manifest).toMatchObject({ partIndex: 3, recordedSegmentCount: 3 });
    expect(g1!.parametersSha256).toMatch(/^[0-9a-f]{64}$/);

    // The stored object: exactly the recorded version, the digest recorded, locked GOVERNANCE.
    const got = await s3.send(new GetObjectCommand({ Bucket: g1!.storageBucket!, Key: g1!.storageKey!, VersionId: g1!.storageVersionId! }));
    const chunks: Buffer[] = [];
    for await (const c of got.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const stored = Buffer.concat(chunks);
    expect(sha(stored)).toBe(g1!.derivedSha256);
    expect(stored.length).toBe(g1!.sizeBytes);
    const retention = await s3.send(
      new GetObjectRetentionCommand({ Bucket: g1!.storageBucket!, Key: g1!.storageKey!, VersionId: g1!.storageVersionId! }),
    );
    expect(retention.Retention?.Mode).toBe("GOVERNANCE");
    expect(new Date(retention.Retention!.RetainUntilDate!).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000);

    // The stored bytes decode to exactly the sources' frames (3 × 24).
    const local = path.join(fixtures, `stored-${randomUUID()}.mp4`);
    await writeFile(local, stored);
    expect((await readVideoPackets(ff, local, { timeoutMs: 30_000 }))!.count).toBe(72);
    const nul: string[] = [];
    const dec = await runFfmpeg(ff, ["-hide_banner", "-nostdin", "-i", local, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-"], {
      timeoutMs: 30_000,
      onStderrLine: (l) => nul.push(l),
    });
    expect(dec.ok).toBe(true);
    expect(Number(/frame=\s*(\d+)/.exec(nul.filter((l) => /frame=/.test(l)).pop() ?? "")?.[1])).toBe(72);
    expect(lineage.output.videoPackets).toBe(72);

    // The handler's temp dir is gone.
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith("proovra-combine-"))).toEqual([]);

    // A regeneration: generation 2 COMPLETED; generation 1 kept as SUPERSEDED, its object intact.
    const run2 = await newRun(teamId, evidenceId, 2);
    expect(run2).not.toBe(run1);
    await runJob(teamId, evidenceId, run2);
    expect((await prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id: run2 } })).status).toBe("COMPLETED");
    const rows = await combinedRows(evidenceId);
    expect(rows.map((r) => [r.variantKey, r.status])).toEqual([
      ["combined-v1", "SUPERSEDED"],
      ["combined-v2", "COMPLETED"],
    ]);
    const still = await s3.send(new GetObjectCommand({ Bucket: g1!.storageBucket!, Key: g1!.storageKey!, VersionId: g1!.storageVersionId! }));
    expect(still.ContentLength).toBe(g1!.sizeBytes);
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith("proovra-combine-"))).toEqual([]);
  });

  it("fails closed on a tampered segment: run FAILED, no derived row, no object, temp dir removed", async () => {
    const { teamId, evidenceId, parts } = await seedSealedSegmentedRecord();
    // Someone writes different bytes at segment 1's key, and the row no longer
    // pins the sealed version: the bytes read are not the sealed bytes.
    const tampered = Buffer.concat([parts[1]!.bytes.subarray(0, parts[1]!.bytes.length - 16), Buffer.alloc(16, 7)]);
    await put(parts[1]!.key, tampered, "video/mp4");
    await prisma.evidencePart.update({ where: { id: parts[1]!.id }, data: { storageVersionId: null } });

    const run = await newRun(teamId, evidenceId, 1);
    await runJob(teamId, evidenceId, run);
    const r = await prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id: run } });
    expect(r.status).toBe("FAILED");
    expect(r.lastError).toBe("combine:source_read_mismatch:1");
    expect(await combinedRows(evidenceId)).toEqual([]);
    const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `derived-assets/${evidenceId}/` }));
    expect(listed.Versions ?? []).toEqual([]);
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith("proovra-combine-"))).toEqual([]);
  });

  it("a digest disagreeing with the manifest is refused before any byte is read", async () => {
    const { teamId, evidenceId, parts } = await seedSealedSegmentedRecord();
    await prisma.evidencePart.update({ where: { id: parts[2]!.id }, data: { sha256: "0".repeat(64) } });
    const run = await newRun(teamId, evidenceId, 1);
    await runJob(teamId, evidenceId, run);
    const r = await prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id: run } });
    expect([r.status, r.lastError]).toEqual(["FAILED", "combine:segment_digest_mismatch:2"]);
    expect(await combinedRows(evidenceId)).toEqual([]);
  });
});
