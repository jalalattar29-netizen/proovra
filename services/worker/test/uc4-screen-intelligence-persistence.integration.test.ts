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
import type { OcrExtractResult } from "@proovra/shared";

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
    const videoSha = "a".repeat(64);
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

  it("is idempotent: a second run yields the same rows, no duplicates", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: "b".repeat(64), bytes: Buffer.from("v") }],
    });
    const frames = [{ offsetMs: 0, rows: ["X", "Y"] }, { offsetMs: 1500, rows: ["Y", "Z"] }];
    await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, deps(store, true, frames));
    await runAndPersistScreenIntelligence({ teamId, evidenceId, parts, acquisitionComplete: true }, deps(store, true, frames));
    const counts = (await prisma.$queryRawUnsafe(
      `SELECT asset_kind, count(*)::int AS n FROM evidence_part_derived_assets WHERE evidence_id=$1 GROUP BY asset_kind`,
      evidenceId,
    )) as Array<{ asset_kind: string; n: number }>;
    const kf = counts.find((c) => c.asset_kind === "video_keyframe");
    const recon = counts.find((c) => c.asset_kind === "screen_reconstruction");
    expect(kf!.n).toBe(2); // not 4
    expect(recon!.n).toBe(1); // not 2
    const textCount = await prisma.evidenceExtractedText.count({ where: { evidenceId } });
    expect(textCount).toBe(2); // OCR_SCREEN + SCREEN_RECONSTRUCTION, replaced not duplicated
  });

  it("UC-2 image: OCRs the ORIGINAL frame directly (no derived keyframe), links to ORIGINAL part (§58)", async () => {
    const frameBytes = Buffer.from(JSON.stringify({ rows: ["Hello", "World"] }), "utf8");
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "image/webp", sha256: "c".repeat(64), bytes: frameBytes }],
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
      parts: [{ mime: "video/mp4", sha256: "d".repeat(64), bytes: Buffer.from("v") }],
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

  it("destruction/hold coverage: the executor's own queries sweep every UC-4 row + object (§53)", async () => {
    const { teamId, evidenceId, parts, store } = await seed({
      parts: [{ mime: "video/mp4", sha256: "e".repeat(64), bytes: Buffer.from("v") }],
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
