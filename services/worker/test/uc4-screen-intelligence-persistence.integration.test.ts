/**
 * UC-4 — persisted screen-intelligence: DB + storage integration.
 *
 * Proves the persistence orchestrator against a REAL PostgreSQL with injected
 * ffmpeg/OCR fakes + an in-memory object store: DERIVED keyframe + reconstruction
 * rows land in `evidence_part_derived_assets`, the descriptor round-trips, derived
 * text lands in the canonical extracted-text authority, and — the MANDATORY §61
 * proof — a persisted reconstructed block traverses actual stored relations back
 * to the ORIGINAL EvidencePart whose digest equals the canonical evidence digest.
 * Also proves idempotency, storage accounting, the UC-2 path, OCR-disabled PARTIAL,
 * and destruction/hold coverage.
 *
 * Runs only when a disposable Postgres is provided (UC4_TEST_DATABASE_URL); it is
 * skipped in the DB-free CI unit phase and executed locally against the throwaway
 * pgvector container.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomUUID } from "node:crypto";
import {
  runAndPersistScreenIntelligence,
  type ScreenIntelligenceDeps,
  type ScreenSourcePartInput,
} from "@proovra/shared-runtime/media-intelligence";
import { sumDerivedAssetStorageBytes } from "@proovra/shared-runtime";
import { UC4_RESOURCE_BOUNDS, type OcrExtractResult } from "@proovra/shared";

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** The REAL digest of `Buffer.from(s)` — a part's recorded sha256 must match its bytes. */
const sha = (s: string) => sha256Hex(Buffer.from(s));

// Uses the harness's canonical live-integration convention: TEST_DATABASE_URL
// survives the test-bootstrap credential scrub (HARNESS_OWNED). Skipped in the
// DB-free CI unit phase; run locally against a disposable migrated pgvector DB.
const DB_URL = process.env.TEST_DATABASE_URL;
const runIf = DB_URL ? describe : describe.skip;

/** In-memory object store implementing the injected storage port. */
function memStore() {
  const objs = new Map<string, Buffer>();
  const k = (b: string, key: string) => `${b}::${key}`;
  return {
    objs,
    put(b: string, key: string, body: Buffer) {
      objs.set(k(b, key), body);
    },
    port(): Pick<ScreenIntelligenceDeps, "getSourceBytes" | "putKeyframeObject" | "deleteObject"> {
      return {
        getSourceBytes: async ({ bucket, key }) => {
          const v = objs.get(k(bucket, key));
          if (!v) throw new Error("not_found");
          return v;
        },
        putKeyframeObject: async ({ bucket, key, body }) => {
          objs.set(k(bucket, key), body);
        },
        deleteObject: async ({ bucket, key }) => {
          objs.delete(k(bucket, key));
        },
      };
    },
  };
}

/** Fake OCR: keyframe/frame bytes are JSON `{rows:[...]}`; parse into regions. */
const fakeOcr = (enabled: boolean) => ({
  name: "tesseract-fake",
  version: "test",
  local: true,
  enabled,
  extractFromBytes: async (bytes: Buffer): Promise<OcrExtractResult> => {
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { rows: string[] };
      return {
        regions: parsed.rows.map((text, i) => ({
          text,
          kind: "TEXT" as const,
          rowOrder: i,
          confidence: 0.9,
        })),
      };
    } catch {
      return { regions: [] };
    }
  },
});

/** Fake ffmpeg keyframe producer: yields keyframes whose bytes carry the rows. */
function fakeKeyframeProducer(
  framesByOffset: Array<{ offsetMs: number; rows: string[] }>,
): ScreenIntelligenceDeps["produceKeyframes"] {
  return async () => ({
    status: "ok" as const,
    boundsReached: false,
    keyframes: framesByOffset.map((f, index) => {
      const bytes = Buffer.from(JSON.stringify({ rows: f.rows }), "utf8");
      return {
        index,
        offsetMs: f.offsetMs,
        bytes,
        contentType: "image/webp",
        derivedSha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      };
    }),
  });
}

runIf("UC-4 persisted screen intelligence (DB + storage)", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const BUCKET = "proovra-test-assets";

  beforeAll(async () => {
    // Prisma 7 driver-adapter construction, mirroring services/worker/src/db.ts.
    pool = new Pool({ connectionString: DB_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** Seed a User→Org→Team→Evidence→parts chain; return ids + a store seeded
   *  with each part's ORIGINAL bytes. */
  async function seed(opts: {
    parts: Array<{ mime: string; sha256: string; bytes: Buffer }>;
  }) {
    const store = memStore();
    const user = await prisma.user.create({
      data: { provider: "EMAIL", providerUserId: `uc4-${randomUUID()}` },
    });
    const org = await prisma.organization.create({ data: { name: "UC4 Org" } });
    const team = await prisma.team.create({
      data: {
        name: "UC4 Team",
        ownerUserId: user.id,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
      },
    });
    const evidence = await prisma.evidence.create({
      data: {
        teamId: team.id,
        organizationId: org.id,
        ownerUserId: user.id,
        type: opts.parts[0]!.mime.startsWith("video/") ? "VIDEO" : "PHOTO",
      },
    });
    const parts: ScreenSourcePartInput[] = [];
    for (let i = 0; i < opts.parts.length; i += 1) {
      const p = opts.parts[i]!;
      const key = `originals/${evidence.id}/part-${i}`;
      store.put(BUCKET, key, p.bytes);
      const part = await prisma.evidencePart.create({
        data: {
          evidenceId: evidence.id,
          partIndex: i,
          storageBucket: BUCKET,
          storageKey: key,
          sha256: p.sha256,
          mimeType: p.mime,
          artifactClass: "ORIGINAL",
        },
      });
      parts.push({
        partIndex: i,
        evidencePartId: part.id,
        storageBucket: BUCKET,
        storageKey: key,
        mimeType: p.mime,
        sha256: p.sha256,
      });
    }
    return { teamId: team.id, evidenceId: evidence.id, parts, store };
  }

  function deps(store: ReturnType<typeof memStore>, ocrEnabled: boolean, frames: Array<{ offsetMs: number; rows: string[] }>): ScreenIntelligenceDeps {
    return {
      prisma,
      holdActive: false,
      ...store.port(),
      produceKeyframes: fakeKeyframeProducer(frames),
      ocr: fakeOcr(ocrEnabled),
    };
  }

  it("UC-3 video: persists keyframes + descriptor + text, reconstructs A..F, source-linked (§30/§61)", async () => {
    const videoSha = sha("original-video");
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: videoSha, bytes: Buffer.from("original-video") }],
    });
    const frames = [
      { offsetMs: 0, rows: ["A", "B", "C", "D"] },
      { offsetMs: 1500, rows: ["C", "D", "E", "F"] },
    ];
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      deps(store, true, frames),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.coverage).toBe("COMPLETE");
    expect(res.keyframeCount).toBe(2);
    expect(res.blockCount).toBe(6); // A..F

    // Keyframe rows persisted as DERIVED assets, source-linked to the ORIGINAL.
    const kfRows = (await prisma.$queryRawUnsafe(
      `SELECT variant_key, source_offset_ms, source_sha256_at_generation, storage_key, size_bytes
         FROM evidence_part_derived_assets
        WHERE evidence_id=$1 AND asset_kind='video_keyframe' ORDER BY variant_key`,
      evidenceId,
    )) as Array<{ variant_key: string; source_offset_ms: number; source_sha256_at_generation: string; storage_key: string; size_bytes: number }>;
    expect(kfRows).toHaveLength(2);
    expect(kfRows[0]!.variant_key).toBe("kf-0000");
    // §61 — the keyframe's recorded source digest equals the ORIGINAL part digest.
    expect(kfRows[0]!.source_sha256_at_generation).toBe(videoSha);
    // Its object actually exists in the store.
    expect(store.objs.has(`${BUCKET}::${kfRows[0]!.storage_key}`)).toBe(true);

    // The reconstruction descriptor round-trips from its stored object bytes.
    const reconRow = (await prisma.$queryRawUnsafe(
      `SELECT storage_bucket, storage_key FROM evidence_part_derived_assets
        WHERE evidence_id=$1 AND asset_kind='screen_reconstruction' AND variant_key='recon-v1' LIMIT 1`,
      evidenceId,
    )) as Array<{ storage_bucket: string; storage_key: string }>;
    expect(reconRow).toHaveLength(1);
    const descriptorBytes = store.objs.get(`${reconRow[0]!.storage_bucket}::${reconRow[0]!.storage_key}`)!;
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    expect(descriptor.schemaVersion).toBe("PROOVRA_SCREEN_INTELLIGENCE_V1");
    expect(descriptor.blocks.map((b: { text: string }) => b.text)).toEqual(["A", "B", "C", "D", "E", "F"]);

    // === MANDATORY §61 lineage traversal via ACTUAL stored relations ===
    // Pick one persisted reconstructed block → its observation → the ORIGINAL
    // EvidencePart id → the evidence_parts row → prove its sha256 equals both the
    // descriptor source digest AND the keyframe's recorded source digest.
    const block = descriptor.blocks.find((b: { text: string }) => b.text === "C");
    const obsId = block.observationIds[0];
    const obs = descriptor.observations.find((o: { id: string }) => o.id === obsId);
    const partRow = (await prisma.$queryRawUnsafe(
      `SELECT sha256 FROM evidence_parts WHERE id=$1`,
      obs.evidencePartId,
    )) as Array<{ sha256: string }>;
    expect(partRow[0]!.sha256).toBe(videoSha);
    expect(block.sourceEvidencePartIds).toContain(obs.evidencePartId);

    // DERIVED text landed in the canonical extracted-text authority with honest
    // provenance kinds (feeds search + swept by destruction).
    const texts = await prisma.evidenceExtractedText.findMany({
      where: { evidenceId },
      select: { kind: true, status: true, text: true },
    });
    const kinds = texts.map((t) => t.kind).sort();
    expect(kinds).toContain("OCR_SCREEN");
    expect(kinds).toContain("SCREEN_RECONSTRUCTION");

    // Storage accounting counts the DERIVED bytes with no extra code.
    const derivedBytes = await sumDerivedAssetStorageBytes(prisma, { teamId });
    expect(Number(derivedBytes)).toBeGreaterThan(0);
  });

  async function rowsOf(evidenceId: string) {
    return (await prisma.$queryRawUnsafe(
      `SELECT id::text, asset_kind, variant_key, status, storage_bucket, storage_key,
              derived_sha256, parameters_sha256, engine_version, source_sha256_at_generation
         FROM evidence_part_derived_assets WHERE evidence_id=$1::uuid
        ORDER BY asset_kind, variant_key`,
      evidenceId,
    )) as Array<{
      id: string;
      asset_kind: string;
      variant_key: string;
      status: string;
      storage_bucket: string;
      storage_key: string;
      derived_sha256: string;
      parameters_sha256: string | null;
      engine_version: string;
      source_sha256_at_generation: string | null;
    }>;
  }

  function readDescriptor(store: ReturnType<typeof memStore>, row: { storage_bucket: string; storage_key: string }) {
    return JSON.parse(store.objs.get(`${row.storage_bucket}::${row.storage_key}`)!.toString("utf8"));
  }

  it("the same generation re-run is idempotent: one current row per variant, nothing lost", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-idem"), bytes: Buffer.from("v-idem") }],
    });
    const frames = [{ offsetMs: 0, rows: ["X", "Y"] }, { offsetMs: 1500, rows: ["Y", "Z"] }];
    await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, deps(store, true, frames));
    await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, deps(store, true, frames));
    const rows = await rowsOf(evidenceId);
    const current = rows.filter((r) => r.status === "COMPLETED");
    expect(current.filter((r) => r.asset_kind === "video_keyframe")).toHaveLength(2); // not 4
    expect(current.filter((r) => r.asset_kind === "screen_reconstruction")).toHaveLength(1);
    // The replaced descriptor object was not deleted: it is kept as SUPERSEDED.
    for (const r of rows) expect(store.objs.has(`${r.storage_bucket}::${r.storage_key}`)).toBe(true);
    const textCount = await prisma.evidenceExtractedText.count({ where: { evidenceId } });
    expect(textCount).toBe(2); // OCR_SCREEN + SCREEN_RECONSTRUCTION, replaced not duplicated
  });

  it("DER-006: regeneration writes a NEW generation; the prior one is SUPERSEDED with its objects, never overwritten or deleted", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-regen"), bytes: Buffer.from("v-regen") }],
    });
    const gen1 = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true, generation: 1, runId: randomUUID() },
      deps(store, true, [
        { offsetMs: 0, rows: ["A", "B"] },
        { offsetMs: 1500, rows: ["B", "C"] },
        { offsetMs: 3000, rows: ["C", "D"] },
      ]),
    );
    expect(gen1.ok).toBe(true);
    const before = await rowsOf(evidenceId);
    const gen1Descriptor = before.find((r) => r.asset_kind === "screen_reconstruction")!;
    expect(gen1Descriptor.variant_key).toBe("recon-v1");
    const gen1Keyframes = before.filter((r) => r.asset_kind === "video_keyframe");
    expect(gen1Keyframes.map((r) => r.variant_key)).toEqual(["kf-0000", "kf-0001", "kf-0002"]);

    // Regenerate with FEWER frames (a changed bound / engine): generation 2.
    const runId2 = randomUUID();
    const gen2 = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true, generation: 2, runId: runId2 },
      deps(store, true, [
        { offsetMs: 0, rows: ["A", "B"] },
        { offsetMs: 1500, rows: ["B", "Q"] },
      ]),
    );
    expect(gen2.ok).toBe(true);
    if (!gen2.ok) return;
    expect(gen2.generation).toBe(2);

    const after = await rowsOf(evidenceId);
    // Every generation-1 row still exists, with the same id, digest and object…
    for (const r of [gen1Descriptor, ...gen1Keyframes]) {
      const same = after.find((x) => x.id === r.id)!;
      expect(same, `gen-1 row ${r.variant_key} kept`).toBeTruthy();
      expect(same.status).toBe("SUPERSEDED");
      expect(same.derived_sha256).toBe(r.derived_sha256);
      expect(same.storage_key).toBe(r.storage_key);
      expect(store.objs.has(`${r.storage_bucket}::${r.storage_key}`)).toBe(true);
    }
    // …including kf-0002, which generation 2 did not produce (no stale "current" variant).
    expect(after.find((x) => x.variant_key === "kf-0002")!.status).toBe("SUPERSEDED");
    // Generation 2 is the only current material.
    const current = after.filter((r) => r.status === "COMPLETED");
    expect(current.map((r) => r.variant_key).sort()).toEqual(["g2-kf-0000", "g2-kf-0001", "recon-v2"]);

    // The current descriptor names what it superseded and how it was produced.
    const d2 = readDescriptor(store, current.find((r) => r.variant_key === "recon-v2")!);
    expect(d2.descriptorVersion).toBe(2);
    expect(d2.generation.generation).toBe(2);
    expect(d2.generation.runId).toBe(runId2);
    expect(d2.generation.supersedes).toEqual({
      generation: 1,
      descriptorAssetId: gen1Descriptor.id,
      descriptorSha256: gen1Descriptor.derived_sha256,
    });
    expect(d2.blocks.map((b: { text: string }) => b.text)).toEqual(["A", "B", "Q"]);
    // The superseded generation-1 descriptor is still readable and unchanged.
    const d1 = readDescriptor(store, gen1Descriptor);
    expect(d1.blocks.map((b: { text: string }) => b.text)).toEqual(["A", "B", "C", "D"]);

    // The ONE reader returns the CURRENT generation.
    const { readScreenReconstructionDescriptor } = await import("@proovra/shared-runtime/media-intelligence");
    const read = await readScreenReconstructionDescriptor(teamId, evidenceId, {
      prisma,
      getObjectBytes: async ({ bucket, key }) => store.objs.get(`${bucket}::${key}`)!,
    });
    expect(read!.descriptor.generation!.generation).toBe(2);
  });

  it("DER-005/014: lineage records the source actually read (digest, version, whole/truncated), parameters_sha256 and tool versions", async () => {
    const original = Buffer.from("original-screen-segment-bytes");
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha256Hex(original), bytes: original }],
    });
    const versioned: string[] = [];
    const d = deps(store, true, [{ offsetMs: 0, rows: ["hello"] }]);
    const getSourceBytes = d.getSourceBytes;
    d.getSourceBytes = async (i) => {
      versioned.push(String(i.versionId));
      return getSourceBytes(i);
    };
    d.toolVersions = { ffmpeg: "6.1.1", tesseract: "5.3.4" };
    d.ocr = { ...d.ocr, language: "eng+ara", parameters: { psm: 6 } };
    const res = await runAndPersistScreenIntelligence(
      {
        teamId,
        evidenceId,
        parts: parts.map((p) => ({ ...p, storageVersionId: "ver-123", sizeBytes: original.byteLength })),
        acquisitionComplete: true,
      },
      d,
    );
    expect(res.ok).toBe(true);
    expect(versioned).toEqual(["ver-123"]); // the read was pinned to the recorded version
    const rows = await rowsOf(evidenceId);
    const kf = rows.find((r) => r.asset_kind === "video_keyframe")!;
    expect(kf.parameters_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kf.engine_version).toBe("ffmpeg-6.1.1");
    expect(kf.source_sha256_at_generation).toBe(sha256Hex(original)); // digest of what was read
    // The generation parameters themselves are readable on the row, not only their hash.
    const params = (await prisma.$queryRawUnsafe(
      `SELECT generation_parameters FROM evidence_part_derived_assets WHERE id=$1::uuid`,
      kf.id,
    )) as Array<{ generation_parameters: Record<string, any> }>;
    expect(params[0]!.generation_parameters.sourceRead).toMatchObject({
      storageVersionId: "ver-123",
      wholeSource: true,
      readSha256: sha256Hex(original),
    });
    expect(params[0]!.generation_parameters.intervalMs).toBe(UC4_RESOURCE_BOUNDS.keyframeIntervalMs);
    const desc = readDescriptor(store, rows.find((r) => r.asset_kind === "screen_reconstruction")!);
    expect(desc.generation.toolVersions).toEqual({ ffmpeg: "6.1.1", tesseract: "5.3.4" });
    expect(desc.generation.parametersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(desc.generation.parameters.ocr.language).toBe("eng+ara");
    expect(desc.generation.parameters.ocr.psm).toBe(6);
    expect(desc.ocrProvider.language).toBe("eng+ara");
    expect(desc.generation.sourceReads).toEqual([
      {
        evidencePartId: parts[0]!.evidencePartId,
        storageVersionId: "ver-123",
        recordedSha256: sha256Hex(original),
        recordedSizeBytes: original.byteLength,
        bytesRead: original.byteLength,
        readSha256: sha256Hex(original),
        wholeSource: true,
        digestMatchesRecorded: true,
      },
    ]);
    // The persisted DERIVED text is digested in the descriptor.
    const ocrRow = await prisma.evidenceExtractedText.findFirst({ where: { evidenceId, kind: "OCR_SCREEN" as never } });
    expect(ocrRow!.language).toBe("eng+ara");
    expect(desc.generation.extractedTextSha256.ocr).toBe(sha256Hex(ocrRow!.text!));
  });

  it("DER-014: a source larger than the bounded read is marked truncated (limitation, PARTIAL) — never presented as the whole part", async () => {
    const original = Buffer.alloc(4096, 7);
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha256Hex(original), bytes: original }],
    });
    const d = deps(store, true, [{ offsetMs: 0, rows: ["A", "B"] }]);
    const inner = d.getSourceBytes;
    d.getSourceBytes = async (i) => (await inner(i)).subarray(0, i.maxBytes);
    const res = await runAndPersistScreenIntelligence(
      {
        teamId,
        evidenceId,
        parts: parts.map((p) => ({ ...p, sizeBytes: original.byteLength })),
        acquisitionComplete: true,
        bounds: { ...UC4_RESOURCE_BOUNDS, maxSourceReadBytesPerPart: 1024 },
      },
      d,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limitations).toContain("RECONSTRUCTION_SOURCE_TRUNCATED");
    expect(res.coverage).toBe("PARTIAL");
    const desc = readDescriptor(store, (await rowsOf(evidenceId)).find((r) => r.asset_kind === "screen_reconstruction")!);
    expect(desc.generation.sourceReads[0]).toMatchObject({ bytesRead: 1024, wholeSource: false, digestMatchesRecorded: null });
  });

  it("DER-014: bytes that do not match the recorded ORIGINAL digest are refused and nothing stays current", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: "9".repeat(64), bytes: Buffer.from("not-the-recorded-bytes") }],
    });
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts: parts.map((p) => ({ ...p, sizeBytes: 22 })), acquisitionComplete: true },
      deps(store, true, [{ offsetMs: 0, rows: ["A"] }]),
    );
    expect(res).toEqual({ ok: false, reason: "source_digest_mismatch" });
    const rows = await rowsOf(evidenceId);
    expect(rows.filter((r) => r.status === "COMPLETED")).toHaveLength(0);
  });

  it("DER-013: a record trashed before processing gets NO derived rows, objects or text", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-trash"), bytes: Buffer.from("v-trash") }],
    });
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { deletedAt: new Date(), lifecycleState: "TRASHED" as never },
    });
    const before = store.objs.size;
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      deps(store, true, [{ offsetMs: 0, rows: ["A"] }]),
    );
    expect(res).toEqual({ ok: false, reason: "evidence_ineligible:evidence_trashed" });
    expect(await rowsOf(evidenceId)).toHaveLength(0);
    expect(store.objs.size).toBe(before);
    expect(await prisma.evidenceExtractedText.count({ where: { evidenceId } })).toBe(0);
  });

  it("DER-013: a record destroyed MID-RUN stops receiving writes; what was written is never current", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-mid"), bytes: Buffer.from("v-mid") }],
    });
    const d = deps(store, true, [
      { offsetMs: 0, rows: ["A"] },
      { offsetMs: 1500, rows: ["B"] },
      { offsetMs: 3000, rows: ["C"] },
    ]);
    let puts = 0;
    const put = d.putKeyframeObject;
    d.putKeyframeObject = async (i) => {
      puts += 1;
      await put(i);
      if (puts === 1) {
        await prisma.evidence.update({
          where: { id: evidenceId },
          data: { lifecycleState: "DESTROYED" as never },
        });
      }
    };
    const res = await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, d);
    expect(res).toEqual({ ok: false, reason: "evidence_ineligible:evidence_destroyed" });
    const rows = await rowsOf(evidenceId);
    expect(rows.filter((r) => r.status === "COMPLETED")).toHaveLength(0);
    expect(rows.filter((r) => r.asset_kind === "screen_reconstruction")).toHaveLength(0);
    expect(await prisma.evidenceExtractedText.count({ where: { evidenceId } })).toBe(0);
  });

  it("DER-003/005: OCR reads the OCR-resolution rendition (not the thumbnail); line geometry is normalised into the descriptor", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-ocr"), bytes: Buffer.from("v-ocr") }],
    });
    const seen: string[] = [];
    const thumb = Buffer.from("thumbnail-256px");
    const full = Buffer.from(JSON.stringify({ rows: ["Invoice 88213"] }));
    const d: ScreenIntelligenceDeps = {
      ...deps(store, true, []),
      produceKeyframes: async () => ({
        status: "ok",
        boundsReached: false,
        keyframes: [
          {
            index: 0,
            offsetMs: 0,
            bytes: thumb,
            contentType: "image/webp",
            derivedSha256: sha256Hex(thumb),
            sizeBytes: thumb.byteLength,
            ocrBytes: full,
            ocrWidthPx: 1080,
            ocrHeightPx: 2400,
          },
        ],
      }),
      ocr: {
        name: "tesseract",
        version: "5.3.4",
        local: true,
        enabled: true,
        extractFromBytes: async (bytes) => {
          seen.push(bytes.toString("utf8"));
          return {
            regions: [
              { text: "Invoice 88213", kind: "TEXT", rowOrder: 0, bbox: { top: 480, left: 108, width: 540, height: 48 } },
            ],
          };
        },
      },
    };
    const res = await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, d);
    expect(res.ok).toBe(true);
    expect(seen).toEqual([full.toString("utf8")]); // never the thumbnail
    const desc = readDescriptor(store, (await rowsOf(evidenceId)).find((r) => r.asset_kind === "screen_reconstruction")!);
    expect(desc.keyframes[0].ocrInput).toEqual({ widthPx: 1080, heightPx: 2400 });
    expect(desc.observations[0].bbox).toEqual({ top: 0.2, left: 0.1, width: 0.5, height: 0.02 });
  });

  it("DER-008: OCR allowed but runtime missing is RUNTIME_UNAVAILABLE, never 'disabled by policy'", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v-rt"), bytes: Buffer.from("v-rt") }],
    });
    const d = deps(store, false, [{ offsetMs: 0, rows: ["A"] }]);
    d.ocr = { ...d.ocr, status: "RUNTIME_UNAVAILABLE", version: "unavailable" };
    const res = await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ocrStatus).toBe("RUNTIME_UNAVAILABLE");
    expect(res.limitations).toContain("RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE");
    const desc = readDescriptor(store, (await rowsOf(evidenceId)).find((r) => r.asset_kind === "screen_reconstruction")!);
    expect(desc.ocrStatus).toBe("RUNTIME_UNAVAILABLE");
    expect(desc.ocrEnabled).toBe(false);
  });

  it("UC-2 image: OCRs the ORIGINAL frame directly (no derived keyframe), links to ORIGINAL part (§58)", async () => {
    const frameBytes = Buffer.from(JSON.stringify({ rows: ["Hello", "World"] }), "utf8");
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "image/webp", sha256: sha256Hex(frameBytes), bytes: frameBytes }],
    });
    // No video ⇒ producer must not be called; provide a throwing one to prove it.
    const d: ScreenIntelligenceDeps = {
      prisma,
      holdActive: false,
      ...store.port(),
      produceKeyframes: async () => { throw new Error("must-not-run-for-image"); },
      ocr: fakeOcr(true),
    };
    const res = await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No DERIVED keyframe objects for a UC-2 image — the ORIGINAL frame is the image.
    const kf = await prisma.evidencePartDerivedAsset.count({ where: { evidenceId, assetKind: "video_keyframe" as never } });
    expect(kf).toBe(0);
    const reconRow = (await prisma.$queryRawUnsafe(
      `SELECT storage_bucket, storage_key FROM evidence_part_derived_assets WHERE evidence_id=$1 AND asset_kind='screen_reconstruction' LIMIT 1`,
      evidenceId,
    )) as Array<{ storage_bucket: string; storage_key: string }>;
    const descriptor = JSON.parse(store.objs.get(`${reconRow[0]!.storage_bucket}::${reconRow[0]!.storage_key}`)!.toString("utf8"));
    // Blocks link back to the ORIGINAL screen_frame part.
    expect(descriptor.blocks.length).toBeGreaterThan(0);
    expect(descriptor.blocks[0].sourceEvidencePartIds).toEqual([parts[0]!.evidencePartId]);
  });

  it("OCR disabled by policy: deterministic-only run is truthfully PARTIAL with no OCR text (§26)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      deps(store, false, [{ offsetMs: 0, rows: ["A"] }]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ocrEnabled).toBe(false);
    expect(res.coverage).toBe("PARTIAL"); // OCR disabled ⇒ never COMPLETE
    expect(res.blockCount).toBe(0);
    // Keyframes still persisted (deterministic visual processing is allowed)…
    const kf = await prisma.evidencePartDerivedAsset.count({ where: { evidenceId, assetKind: "video_keyframe" as never } });
    expect(kf).toBe(1);
    // …but no OCR/reconstruction text written.
    const text = await prisma.evidenceExtractedText.count({ where: { evidenceId } });
    expect(text).toBe(0);
  });

  it("failure matrix: ffmpeg unsupported → PARTIAL, no keyframes, ORIGINAL untouched (§62)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    const d: ScreenIntelligenceDeps = {
      prisma,
      holdActive: false,
      ...store.port(),
      produceKeyframes: async () => ({ status: "unsupported", reason: "ffmpeg_absent" }),
      ocr: fakeOcr(true),
    };
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      d,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.coverage).toBe("PARTIAL");
    expect(res.keyframeCount).toBe(0);
    expect(res.blockCount).toBe(0);
    // ORIGINAL part row is untouched.
    const orig = await prisma.evidencePart.findFirst({ where: { evidenceId }, select: { sha256: true } });
    expect(orig!.sha256).toBe(sha("v"));
  });

  it("failure matrix: ffmpeg failed on a part → PARTIAL, possible-gap limitation (§62)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    const d: ScreenIntelligenceDeps = {
      prisma,
      holdActive: false,
      ...store.port(),
      produceKeyframes: async () => ({ status: "failed", reason: "ffmpeg_exit_1" }),
      ocr: fakeOcr(true),
    };
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      d,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.coverage).toBe("PARTIAL");
    expect(res.limitations).toContain("RECONSTRUCTION_POSSIBLE_GAP");
  });

  it("failure matrix: OCR throws on a frame → that frame degrades, run still COMPLETEs (§62)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    let calls = 0;
    const d: ScreenIntelligenceDeps = {
      prisma,
      holdActive: false,
      ...store.port(),
      produceKeyframes: fakeKeyframeProducer([
        { offsetMs: 0, rows: ["A", "B"] },
        { offsetMs: 1500, rows: ["B", "C"] },
      ]),
      ocr: {
        name: "tesseract-fake",
        version: "test",
        local: true,
        enabled: true,
        extractFromBytes: async (bytes: Buffer) => {
          calls += 1;
          if (calls === 1) throw new Error("ocr_timeout"); // first keyframe fails
          const parsed = JSON.parse(bytes.toString("utf8")) as { rows: string[] };
          return { regions: parsed.rows.map((text, i) => ({ text, kind: "TEXT" as const, rowOrder: i })) };
        },
      },
    };
    const res = await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      d,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The keyframes were still persisted; one frame produced no observations.
    expect(res.keyframeCount).toBe(2);
    // Descriptor records the failed-OCR frame count.
    const reconRow = (await prisma.$queryRawUnsafe(
      `SELECT storage_bucket, storage_key FROM evidence_part_derived_assets WHERE evidence_id=$1 AND asset_kind='screen_reconstruction' LIMIT 1`,
      evidenceId,
    )) as Array<{ storage_bucket: string; storage_key: string }>;
    const descriptor = JSON.parse(
      store.objs.get(`${reconRow[0]!.storage_bucket}::${reconRow[0]!.storage_key}`)!.toString("utf8"),
    );
    expect(descriptor.stats.ocrFailedKeyframes).toBe(1);
  });

  it("failure matrix: source storage failure throws (transient → BullMQ retry), no false COMPLETE (§62)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    const d: ScreenIntelligenceDeps = {
      prisma,
      holdActive: false,
      ...store.port(),
      getSourceBytes: async () => {
        throw new Error("s3_503");
      },
      produceKeyframes: fakeKeyframeProducer([{ offsetMs: 0, rows: ["A"] }]),
      ocr: fakeOcr(true),
    };
    await expect(
      runAndPersistScreenIntelligence(
        { teamId, evidenceId, parts, acquisitionComplete: true },
        d,
      ),
    ).rejects.toThrow(/source_fetch_failed/);
    // No reconstruction descriptor was written (no false COMPLETE).
    const recon = await prisma.evidencePartDerivedAsset.count({
      where: { evidenceId, assetKind: "screen_reconstruction" as never },
    });
    expect(recon).toBe(0);
  });

  it("destruction/hold coverage: the executor's own queries sweep every UC-4 row + object (§53)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: sha("v"), bytes: Buffer.from("v") }],
    });
    await runAndPersistScreenIntelligence(
      { teamId, evidenceId, parts, acquisitionComplete: true },
      deps(store, true, [{ offsetMs: 0, rows: ["A", "B"] }, { offsetMs: 1500, rows: ["B", "C"] }]),
    );
    // The executor enumerates object targets by (evidenceId, storageKey NOT NULL),
    // kind-agnostic — so every UC-4 keyframe + the descriptor are enumerated.
    const objTargets = await prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId, storageKey: { not: null } },
      select: { storageBucket: true, storageKey: true },
    });
    expect(objTargets.length).toBeGreaterThanOrEqual(3); // ≥2 keyframes + descriptor
    for (const t of objTargets) {
      expect(store.objs.has(`${t.storageBucket}::${t.storageKey}`)).toBe(true);
    }
    // The tombstone transaction deletes rows by evidenceId (kind-agnostic).
    const delDerived = await prisma.evidencePartDerivedAsset.deleteMany({ where: { evidenceId } });
    const delText = await prisma.evidenceExtractedText.deleteMany({ where: { evidenceId } });
    expect(delDerived.count).toBeGreaterThanOrEqual(3);
    expect(delText.count).toBe(2);
    // Nothing UC-4 remains.
    expect(await prisma.evidencePartDerivedAsset.count({ where: { evidenceId } })).toBe(0);
    expect(await prisma.evidenceExtractedText.count({ where: { evidenceId } })).toBe(0);
  });
});
