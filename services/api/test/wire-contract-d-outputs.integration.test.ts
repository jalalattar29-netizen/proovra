/**
 * WIRE CONTRACT D (2026-10-29) — one continuous screen recording is ONE user
 * item on every API surface, and "Download original" never hands out one
 * fragment of a multipart record as if it were the whole original. Live
 * PostgreSQL 16, real HTTP. (Presigning is a local computation; no object
 * store is contacted.)
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("wire contract D — user items vs technical parts (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  /** A signed recording: `segments` ORIGINAL video parts + one CAPTURE_MANIFEST part. */
  async function recording(acquisitionMode: string, segments: number) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `recording ${randomUUID().slice(0, 6)}`,
        type: "VIDEO",
        status: "SIGNED",
        mimeType: "video/mp4",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        acquisitionMode,
        acquisitionModeSource: "RECORDED_AT_CREATION",
        storageBucket: "recording-bucket",
        storageKey: `parts/${randomUUID()}/0.mp4`,
      } as never,
      select: { id: true, storageKey: true },
    });
    for (let i = 0; i < segments; i++) {
      await prisma.evidencePart.create({
        data: {
          evidenceId: ev.id,
          partIndex: i,
          storageBucket: "recording-bucket",
          storageKey: i === 0 ? ev.storageKey : `parts/${ev.id}/${i}.mp4`,
          mimeType: "video/mp4",
          sha256: String(i).repeat(64),
          originalFileName: segments === 1 ? "screen-recording-2026-10-29T10-00-00Z.mp4" : `segment-${i}.mp4`,
          artifactClass: "ORIGINAL",
        } as never,
      });
    }
    await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: segments,
        storageBucket: "recording-bucket",
        storageKey: `parts/${ev.id}/manifest.json`,
        mimeType: "application/json",
        sha256: "f".repeat(64),
        originalFileName: "continuous-manifest.json",
        artifactClass: "CAPTURE_MANIFEST",
      } as never,
    });
    return ev.id;
  }

  const get = (url: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });
  const downloads = async (evidenceId: string) =>
    prisma.custodyEvent.count({ where: { evidenceId, eventType: "EVIDENCE_DOWNLOADED" as never } });

  it("a SEGMENTED recording counts as ONE item in the list and on the record", async () => {
    const id = await recording("DIRECT_SCREEN_CAPTURE_IOS", 3);

    const list = await get(`/v1/evidence?limit=100`);
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().items as Array<{ id: string; itemCount: number }>).find((i) => i.id === id);
    expect(row?.itemCount).toBe(1);

    const record = await get(`/v1/evidence/${id}`);
    expect(record.statusCode, record.body).toBe(200);
    const body = record.json();
    expect(body.evidence.itemCount).toBe(1);
    expect(body.evidence.contentSummary.itemCount).toBe(1);
    expect(body.evidence.contentSummary.textCount).toBe(0);
    expect(body.evidence.contentArtifacts.userItems).toEqual([
      expect.objectContaining({ kind: "recording", label: "Screen recording", partIndexes: [0, 1, 2], layout: "SEGMENTED" }),
    ]);
    expect(body.evidence.contentArtifacts.technical).toEqual(
      expect.objectContaining({ originalPartCount: 3, captureRecordCount: 1, storedPartCount: 4 }),
    );
    // The inventory keeps every part; the manifest is a capture record, never text evidence.
    const manifest = (body.evidence.contentItems as Array<Record<string, unknown>>).find((i) => i.index === 3);
    expect(manifest).toEqual(
      expect.objectContaining({ partPresentation: "capture_record", label: "Capture record (system-generated)", previewable: false }),
    );
  });

  it("the review workspace states whether this viewer may prepare the combined review video (intelligence.run)", async () => {
    const id = await recording("DIRECT_SCREEN_CAPTURE_IOS", 3);
    const owner = await get(`/v1/evidence/${id}/review-workspace`);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().evidence.combinedRecordingPrepareAllowed).toBe(true);
    expect(owner.json().evidence.contentArtifacts.userItems).toHaveLength(1);
  });

  it("the review workspace states whether this viewer may prepare the combined review video (intelligence.run)", async () => {
    const id = await recording("DIRECT_SCREEN_CAPTURE_IOS", 3);
    const owner = await get(`/v1/evidence/${id}/review-workspace`);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().evidence.combinedRecordingPrepareAllowed).toBe(true);
    expect(owner.json().evidence.contentArtifacts.userItems).toHaveLength(1);
  });

  it("Download original on a SEGMENTED recording refuses part 0 and points at the parts listing", async () => {
    const id = await recording("DIRECT_SCREEN_CAPTURE_IOS", 3);
    const res = await get(`/v1/evidence/${id}/original`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual(
      expect.objectContaining({
        code: "ORIGINAL_IS_MULTIPART",
        originalPartCount: 3,
        technicalPartCount: 4,
        partsUrl: `/v1/evidence/${id}/parts`,
      }),
    );
    expect(JSON.stringify(res.json())).not.toMatch(/X-Amz-Signature/);
    // Nothing was released, so nothing is recorded as downloaded.
    expect(await downloads(id)).toBe(0);

    const parts = await get(`/v1/evidence/${id}/parts`);
    expect(parts.statusCode, parts.body).toBe(200);
    const listed = parts.json().parts as Array<{ partIndex: number; url: string | null; partPresentation: string }>;
    expect(listed.map((p) => [p.partIndex, p.partPresentation])).toEqual([
      [0, "recording_part"],
      [1, "recording_part"],
      [2, "recording_part"],
      [3, "capture_record"],
    ]);
    // Each original file saves under its own RFC 6266-safe name.
    expect(decodeURIComponent(listed[1]!.url ?? "")).toContain(`attachment; filename="segment-1.mp4"`);
    expect(parts.json().artifacts.counts.userItems).toBe(1);
  });

  it("Download original on a SINGLE_FILE recording returns the recording part with a safe Content-Disposition", async () => {
    const id = await recording("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", 1);
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { storageKey: true } });
    const res = await get(`/v1/evidence/${id}/original`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.key).toBe(ev.storageKey);
    expect(body.mimeType).toBe("video/mp4");
    expect(body.downloadFileName).toBe("screen-recording-2026-10-29T10-00-00Z.mp4");
    const url = decodeURIComponent(String(body.url));
    expect(url).toContain(`attachment; filename="screen-recording-2026-10-29T10-00-00Z.mp4"`);
    expect(url).toContain("filename*=UTF-8''screen-recording-2026-10-29T10-00-00Z.mp4");
    // The custody event and the gate are unchanged.
    expect(await downloads(id)).toBe(1);

    const record = await get(`/v1/evidence/${id}`);
    expect(record.json().evidence.itemCount).toBe(1);
    expect(record.json().evidence.contentArtifacts.userItems[0].layout).toBe("SINGLE_FILE");
  });

  it("an ordinary multipart upload keeps one item per original part", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `upload ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        acquisitionMode: "PROOVRA_WEB_UPLOAD",
        acquisitionModeSource: "RECORDED_AT_CREATION",
        storageBucket: "upload-bucket",
        storageKey: `parts/${randomUUID()}/0.jpg`,
      } as never,
      select: { id: true },
    });
    for (let i = 0; i < 2; i++) {
      await prisma.evidencePart.create({
        data: { evidenceId: ev.id, partIndex: i, storageBucket: "upload-bucket", storageKey: `parts/${ev.id}/${i}.jpg`, mimeType: "image/jpeg" } as never,
      });
    }
    const record = await get(`/v1/evidence/${ev.id}`);
    expect(record.json().evidence.itemCount).toBe(2);
    expect((await get(`/v1/evidence/${ev.id}/original`)).statusCode).toBe(409);
  });
});
