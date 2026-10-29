/**
 * 2026-10-29 — the DERIVED combined screen recording, API side, on the real
 * stack: live PostgreSQL 16 migrated through 20281029000000, real MinIO
 * (its own versioned bucket), real routes, the real byte-release gate.
 *
 *   * the migration admits the run kind, the asset kind and a 600 MB row (and
 *     still refuses one above the 640 MiB ceiling);
 *   * readiness moves NOT_STARTED → PENDING (owner's Prepare) → COMPLETED and
 *     carries the lineage's gaps / completeness;
 *   * download hands out a presigned GET pinned to the recorded VERSION with
 *     the safe `<id8>-DERIVED-combined-recording-v<gen>.mp4` attachment name,
 *     which honours HTTP Range (206) — and writes EVIDENCE_DOWNLOADED
 *     (artifact "derived") on custody; playback is inline + EVIDENCE_VIEWED;
 *   * a VIEWER is refused by the gate; a non-segmented record cannot Prepare.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("combined screen recording routes (live PostgreSQL 16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let s3: (typeof import("../src/storage.js"))["s3"];
  const BUCKET = `combined-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ s3 } = await import("../src/storage.js"));
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: "Enabled" } }));
    const A = h.fixtures.teamA;
    for (const u of [A.ownerUserId, A.viewerUserId]) {
      await prisma.user.update({ where: { id: u }, data: { currentWorkspaceId: A.teamId } });
    }
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, token: string, payload: unknown) =>
    h.app.inject({ method: "POST", url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });

  /** A sealed legacy SEGMENTED continuous recording: two segments + the manifest part. */
  async function segmentedRecord(mode = "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS") {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id: evidenceId } = await prisma.evidence.create({
      data: {
        title: "Combined fixture",
        type: "VIDEO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        acquisitionMode: mode,
        acquisitionModeSource: "RECORDED_AT_CREATION",
      } as never,
      select: { id: true },
    });
    const partIds: string[] = [];
    for (const [i, mime, cls] of [
      [0, "video/mp4", "ORIGINAL"],
      [1, "video/mp4", "ORIGINAL"],
      [2, "application/json", "CAPTURE_MANIFEST"],
    ] as const) {
      const bytes = Buffer.from(`part-${i}-${randomUUID()}`);
      const { id } = await prisma.evidencePart.create({
        data: {
          evidenceId,
          partIndex: i,
          storageBucket: BUCKET,
          storageKey: `originals/${evidenceId}/${i}`,
          sha256: sha(bytes),
          sizeBytes: bytes.length,
          mimeType: mime,
          artifactClass: cls,
        },
        select: { id: true },
      });
      partIds.push(id);
    }
    return { evidenceId, partIds };
  }

  it("the migration admits the kinds and the 640 MiB ceiling — and nothing above it", async () => {
    const A = h.fixtures.teamA;
    const { evidenceId, partIds } = await segmentedRecord();
    const row = await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: A.teamId,
        evidenceId,
        evidencePartId: partIds[0]!,
        assetKind: "screen_recording_combined",
        status: "SUPERSEDED",
        sizeBytes: 600_000_000,
        variantKey: "combined-v0~ceiling",
      },
      select: { id: true },
    });
    expect(row.id).toBeTruthy();
    await expect(
      prisma.evidencePartDerivedAsset.create({
        data: {
          teamId: A.teamId,
          evidenceId,
          evidencePartId: partIds[0]!,
          assetKind: "screen_recording_combined",
          status: "SUPERSEDED",
          sizeBytes: 700_000_000,
          variantKey: "combined-v0~over",
        },
      }),
    ).rejects.toThrow(/size_bounded|check constraint/i);
    await expect(
      prisma.evidencePartDerivedAsset.create({
        data: { teamId: A.teamId, evidenceId, evidencePartId: partIds[0]!, assetKind: "not_a_kind", status: "PENDING" },
      }),
    ).rejects.toThrow(/kind_bounded|check constraint/i);
  });

  it("NOT_STARTED → Prepare (owner) → PENDING; a run of the new kind is durable", async () => {
    const A = h.fixtures.teamA;
    const { evidenceId } = await segmentedRecord();
    const before = await get(`/v1/evidence/${evidenceId}/combined-recording?teamId=${A.teamId}`, A.ownerToken);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ applicable: true, state: "NOT_STARTED", segmentCount: 2, combined: null });

    const prep = await post(`/v1/evidence/${evidenceId}/combined-recording/prepare`, A.ownerToken, { teamId: A.teamId });
    expect([202, 503]).toContain(prep.statusCode);
    const run = await prisma.mediaIntelligenceRun.findFirstOrThrow({
      where: { evidenceId, kind: "combine_screen_recording" },
    });
    expect(run.status).toBe("PENDING");
    expect(run.idempotencyKey).toBe(`combine_screen_recording:${evidenceId}`);
    const after = await get(`/v1/evidence/${evidenceId}/combined-recording?teamId=${A.teamId}`, A.ownerToken);
    expect(after.json()).toMatchObject({ state: "PENDING", run: { id: run.id, generation: 1 } });
    // Re-asking joins the live run instead of creating a second one.
    const again = await post(`/v1/evidence/${evidenceId}/combined-recording/prepare`, A.ownerToken, { teamId: A.teamId });
    expect([202, 503]).toContain(again.statusCode);
    expect(await prisma.mediaIntelligenceRun.count({ where: { evidenceId, kind: "combine_screen_recording" } })).toBe(1);
  });

  it("a record that is not a segmented continuous recording cannot Prepare", async () => {
    const A = h.fixtures.teamA;
    const { evidenceId } = await segmentedRecord("DIRECT_WEB_CAPTURE_EXTENSION");
    const res = await post(`/v1/evidence/${evidenceId}/combined-recording/prepare`, A.ownerToken, { teamId: A.teamId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("combined_recording_not_applicable");
    const s = await get(`/v1/evidence/${evidenceId}/combined-recording?teamId=${A.teamId}`, A.ownerToken);
    expect(s.json().state).toBe("NOT_APPLICABLE");
  });

  describe("a COMPLETED combined recording", () => {
    let evidenceId = "";
    let bytes: Buffer;
    let versionId = "";

    beforeAll(async () => {
      const A = h.fixtures.teamA;
      const rec = await segmentedRecord();
      evidenceId = rec.evidenceId;
      bytes = randomBytes(6 * 1024 * 1024 + 321);
      const key = `derived-assets/${evidenceId}/screen_recording_combined/combined-v1-${sha(bytes).slice(0, 16)}.mp4`;
      const put = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: "video/mp4" }));
      versionId = put.VersionId!;
      // A later write at the same key must never be what the link serves.
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("later bytes"), ContentType: "video/mp4" }));
      await prisma.evidencePartDerivedAsset.create({
        data: {
          teamId: A.teamId,
          evidenceId,
          evidencePartId: rec.partIds[0]!,
          assetKind: "screen_recording_combined",
          status: "COMPLETED",
          derivedSha256: sha(bytes),
          sizeBytes: bytes.length,
          contentType: "video/mp4",
          widthPx: 1920,
          heightPx: 1920,
          storageBucket: BUCKET,
          storageKey: key,
          storageVersionId: versionId,
          variantKey: "combined-v1",
          transformation: "screen-recording-combine/v1",
          generatedAtUtc: new Date(),
          generationParameters: {
            schema: "PROOVRA_SCREEN_RECORDING_COMBINE_V1",
            transformation: "screen-recording-combine/v1",
            generation: 1,
            mode: "TRANSCODE",
            completeness: "PARTIAL",
            gaps: [{ atMs: 2000, durationMs: 1000, cause: "SEGMENT_MISSING", missingSequences: [2], limitations: ["SEGMENT_UPLOAD_LOST"] }],
            limitations: ["SEGMENT_UPLOAD_LOST", "COMBINE_RE_ENCODED"],
            sources: [
              { partIndex: 0, sequence: 0, sha256: "a".repeat(64), combinedStartMs: 0, durationMs: 1000 },
              { partIndex: 1, sequence: 1, sha256: "b".repeat(64), combinedStartMs: 1000, durationMs: 1000 },
            ],
            sourceSetSha256: "c".repeat(64),
            output: { durationMs: 4000, videoPackets: 36, chapters: 4 },
            statement: "DERIVED review copy.",
          },
        },
      });
    });

    it("status carries the lineage a player renders", async () => {
      const A = h.fixtures.teamA;
      const res = await get(`/v1/evidence/${evidenceId}/combined-recording?teamId=${A.teamId}`, A.ownerToken);
      const body = res.json();
      expect(body.state).toBe("COMPLETED");
      expect(body.release).toEqual({ allowed: true });
      expect(body.combined).toMatchObject({
        generation: 1,
        artifactClass: "DERIVED",
        mode: "TRANSCODE",
        completeness: "PARTIAL",
        durationMs: 4000,
        filename: `${evidenceId.replace(/-/g, "").slice(0, 8)}-DERIVED-combined-recording-v1.mp4`,
        gaps: [{ atMs: 2000, durationMs: 1000, cause: "SEGMENT_MISSING", missingSequences: [2] }],
      });
      expect(JSON.stringify(body)).not.toMatch(/derived-assets\/|storageKey|X-Amz-Signature/);
    });

    it("download: presigned, version-pinned, Range-capable, safe attachment name, custody EVIDENCE_DOWNLOADED", async () => {
      const A = h.fixtures.teamA;
      const res = await get(`/v1/evidence/${evidenceId}/combined-recording/download?teamId=${A.teamId}`, A.ownerToken);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.filename).toMatch(/^[0-9a-f]{8}-DERIVED-combined-recording-v1\.mp4$/);
      const start = 3 * 1024 * 1024 + 5;
      const ranged = await fetch(body.url, { headers: { Range: `bytes=${start}-${start + 1023}` } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(`bytes ${start}-${start + 1023}/${bytes.length}`);
      expect(ranged.headers.get("content-disposition")).toBe(`attachment; filename="${body.filename}"`);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(start, start + 1024))).toBe(true);
      const whole = Buffer.from(await (await fetch(body.url)).arrayBuffer());
      expect(sha(whole)).toBe(sha(bytes)); // the recorded version, not the later write
      const ev = await prisma.custodyEvent.findFirst({
        where: { evidenceId, eventType: "EVIDENCE_DOWNLOADED" },
        orderBy: { sequence: "desc" },
      });
      expect(ev?.payload).toMatchObject({ artifact: "derived", assetKind: "screen_recording_combined", generation: 1 });
    });

    it("playback: inline, seekable, custody EVIDENCE_VIEWED", async () => {
      const A = h.fixtures.teamA;
      const res = await get(`/v1/evidence/${evidenceId}/combined-recording/playback?teamId=${A.teamId}`, A.ownerToken);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ranged = await fetch(body.url, { headers: { Range: "bytes=0-99" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-disposition")).toMatch(/^inline; filename="/);
      expect(ranged.headers.get("content-type")).toBe("video/mp4");
      const ev = await prisma.custodyEvent.findFirst({
        where: { evidenceId, eventType: "EVIDENCE_VIEWED" },
        orderBy: { sequence: "desc" },
      });
      expect(ev?.payload).toMatchObject({ artifact: "derived", channel: "combined_recording_playback" });
    });

    it("a VIEWER is refused by the byte-release gate and is told so in the status", async () => {
      const A = h.fixtures.teamA;
      const res = await get(`/v1/evidence/${evidenceId}/combined-recording/download?teamId=${A.teamId}`, A.viewerToken);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain("X-Amz-Signature");
      const s = await get(`/v1/evidence/${evidenceId}/combined-recording?teamId=${A.teamId}`, A.viewerToken);
      expect(s.json().release.allowed).toBe(false);
    });

    it("Prepare on a COMPLETED recording answers already_prepared (nothing queued)", async () => {
      const A = h.fixtures.teamA;
      const res = await post(`/v1/evidence/${evidenceId}/combined-recording/prepare`, A.ownerToken, { teamId: A.teamId });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ queued: false, reason: "already_prepared", generation: 1 });
    });
  });
});
