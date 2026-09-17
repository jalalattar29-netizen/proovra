/**
 * UC-0c — DERIVATIVE LIFECYCLE CLOSURE, against a real database.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 *   1. P0-7 — destruction removes EVERYTHING derived from a record: the
 *      derived-asset objects (storage), the derived-asset rows, OCR rows,
 *      transcript rows and the record's search documents. The executor used to
 *      enumerate evidence, parts, reports, packages and redaction derivatives
 *      only; this suite was run against that executor first and FAILED on the
 *      derived object still being in the bucket.
 *   2. A legal hold blocks all of it: nothing is deleted, rows stay.
 *   3. Storage accounting counts derived bytes exactly once — original only,
 *      original + derivative, several variants, regeneration, a failed
 *      derivative (no bytes), a failure after success (the bytes still exist),
 *      and zero after destruction.
 *   4. The derivative writer keeps the storage pointer on failure and reports
 *      the pointer a regeneration superseded.
 *
 * DISPOSABLE INFRASTRUCTURE ONLY: the harness's throwaway PostgreSQL 16 and an
 * in-process object store implementing the executor's storage port.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const DAY = 24 * 60 * 60 * 1000;

class DisposableStore {
  objects = new Map<string, Buffer>();
  deleteCalls: string[] = [];
  put(bucket: string, key: string, body = "fictional-bytes") {
    this.objects.set(`${bucket}/${key}`, Buffer.from(body));
  }
  has(bucket: string, key: string) {
    return this.objects.has(`${bucket}/${key}`);
  }
  get port() {
    return {
      deleteObject: async (input: { bucket: string; key: string }) => {
        this.deleteCalls.push(`${input.bucket}/${input.key}`);
        this.objects.delete(`${input.bucket}/${input.key}`);
        return { ok: true };
      },
      objectExists: async (input: { bucket: string; key: string }) =>
        this.objects.has(`${input.bucket}/${input.key}`),
    };
  }
}

describe("UC-0c derivative lifecycle — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let executeEvidenceDestruction: (typeof import("@proovra/shared-runtime"))["executeEvidenceDestruction"];
  let organizationId: string;
  const bucket = "uc0-disposable-bucket";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ executeEvidenceDestruction } = await import("@proovra/shared-runtime"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId as string;
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  const uniq = () => randomBytes(6).toString("hex");

  async function seedRecord(
    store: DisposableStore,
    over: Record<string, unknown> = {},
  ) {
    const team = harness.fixtures.teamA;
    const key = `uc0/${uniq()}.bin`;
    const ev = await prisma.evidence.create({
      data: {
        title: "UC-0 derivative lifecycle record",
        type: "PHOTO",
        status: "SIGNED",
        teamId: team.teamId,
        organizationId,
        ownerUserId: team.ownerUserId,
        storageBucket: bucket,
        storageKey: key,
        sizeBytes: BigInt(1_000),
        ...over,
      } as never,
      select: { id: true },
    });
    store.put(bucket, key);
    const partKey = `${key}.part0`;
    const part = await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: 0,
        storageBucket: bucket,
        storageKey: partKey,
        sha256: "a".repeat(64),
      },
      select: { id: true },
    });
    store.put(bucket, partKey);
    return { id: ev.id, key, partId: part.id, partKey };
  }

  async function seedDerived(
    store: DisposableStore,
    rec: { id: string; partId: string },
    opts: { variantKey?: string; sizeBytes?: number; kind?: string } = {},
  ) {
    const key = `derived-assets/${rec.id}/${rec.partId}/${opts.kind ?? "image_thumbnail"}-${uniq()}.webp`;
    const row = await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: harness.fixtures.teamA.teamId,
        evidenceId: rec.id,
        evidencePartId: rec.partId,
        assetKind: opts.kind ?? "image_thumbnail",
        variantKey: opts.variantKey ?? "default",
        status: "COMPLETED",
        derivedSha256: "b".repeat(64),
        sourceSha256AtGeneration: "a".repeat(64),
        sizeBytes: opts.sizeBytes ?? 300,
        storageBucket: bucket,
        storageKey: key,
      },
      select: { id: true },
    });
    store.put(bucket, key);
    return { id: row.id, key };
  }

  async function seedDerivedText(rec: { id: string; partId: string }) {
    const teamId = harness.fixtures.teamA.teamId;
    await prisma.evidenceOcrText.create({
      data: { teamId, evidenceId: rec.id, partId: rec.partId, engine: "test", text: "OCR TEXT" },
    });
    await prisma.evidenceTranscriptSegment.create({
      data: {
        teamId,
        evidenceId: rec.id,
        partId: rec.partId,
        segmentIndex: 0,
        startMs: 0,
        endMs: 10,
        engine: "test",
        text: "TRANSCRIPT",
      } as never,
    });
    await prisma.evidenceSearchDocument.create({
      data: {
        teamId,
        documentType: "EVIDENCE",
        sourceId: rec.id,
        evidenceId: rec.id,
        title: "UC-0 search doc",
        searchableText: "OCR TEXT",
        sourceUpdatedAtUtc: new Date(),
      } as never,
    });
  }

  function trashedAndExpired() {
    return {
      lifecycleState: "TRASHED",
      deletedAt: new Date(Date.now() - 200 * DAY),
      deletedAtUtc: new Date(Date.now() - 200 * DAY),
      deleteScheduledForUtc: new Date(Date.now() - 110 * DAY),
    };
  }

  async function derivedResidue(evidenceId: string) {
    const [assets, ocr, transcripts, searchDocs] = await Promise.all([
      prisma.evidencePartDerivedAsset.count({ where: { evidenceId } }),
      prisma.evidenceOcrText.count({ where: { evidenceId } }),
      prisma.evidenceTranscriptSegment.count({ where: { evidenceId } }),
      prisma.evidenceSearchDocument.count({ where: { evidenceId } }),
    ]);
    return { assets, ocr, transcripts, searchDocs };
  }

  // ===========================================================================
  // 1. P0-7 — destruction removes derived material
  // ===========================================================================

  it("destruction deletes derived objects and derived rows (P0-7)", async () => {
    const store = new DisposableStore();
    const rec = await seedRecord(store, trashedAndExpired());
    const d1 = await seedDerived(store, rec);
    const d2 = await seedDerived(store, rec, { kind: "video_frame" });
    await seedDerivedText(rec);

    const result = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("DESTROYED");

    // Originals gone (already true before UC-0).
    expect(store.has(bucket, rec.key)).toBe(false);
    expect(store.has(bucket, rec.partKey)).toBe(false);
    // Derived objects gone (P0-7).
    expect(store.has(bucket, d1.key)).toBe(false);
    expect(store.has(bucket, d2.key)).toBe(false);
    if (result.outcome === "DESTROYED") {
      expect(result.destroyedObjectCount).toBe(4);
    }
    // Derived rows gone.
    expect(await derivedResidue(rec.id)).toEqual({
      assets: 0,
      ocr: 0,
      transcripts: 0,
      searchDocs: 0,
    });
    // The custody chain survives as the record of destruction.
    expect(
      await prisma.custodyEvent.count({
        where: { evidenceId: rec.id, eventType: "EVIDENCE_PURGED" },
      }),
    ).toBe(1);
  });

  it("a legal hold blocks destruction of derived material too", async () => {
    const store = new DisposableStore();
    const rec = await seedRecord(store, trashedAndExpired());
    const d1 = await seedDerived(store, rec);
    await seedDerivedText(rec);

    const result = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: true },
      store.port,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe("BLOCKED");
    expect(store.deleteCalls).toHaveLength(0);
    expect(store.has(bucket, d1.key)).toBe(true);
    expect(await derivedResidue(rec.id)).toEqual({
      assets: 1,
      ocr: 1,
      transcripts: 1,
      searchDocs: 1,
    });
  });

  // ===========================================================================
  // 2. Storage accounting — derived bytes counted exactly once (D5)
  // ===========================================================================

  it("storage accounting counts derived bytes exactly once, and none after destruction", async () => {
    const { getWorkspaceUsage } = await import("../src/services/workspace-usage.service.js");
    const { resolveWorkspaceScopeForUser } = await import(
      "../src/services/workspace-billing.service.js"
    );
    const { recordDerivedAsset } = await import("@proovra/shared-runtime");
    const teamId = harness.fixtures.teamA.teamId;
    const scope = await resolveWorkspaceScopeForUser({
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      teamId,
    });
    const used = async () => (await getWorkspaceUsage(scope)).storageBytesUsed;
    const store = new DisposableStore();

    const base = await used();
    // Original only.
    const rec = await seedRecord(store, { sizeBytes: BigInt(10_000) });
    expect(await used()).toBe(base + 10_000n);

    // Original + one derivative.
    await seedDerived(store, rec, { sizeBytes: 300 });
    expect(await used()).toBe(base + 10_300n);

    // Multiple derivatives of different kinds.
    await seedDerived(store, rec, { kind: "video_frame", sizeBytes: 200 });
    await seedDerived(store, rec, { kind: "audio_waveform", sizeBytes: 100 });
    expect(await used()).toBe(base + 10_600n);
    // UC-0 (A3): the variant contract retired the narrow (team, part, kind)
    // key, so a SECOND variant of one kind on the same part now COEXISTS with
    // the first — the capability multi-variant producers (keyframes) need.
    await seedDerived(store, rec, {
      kind: "video_frame",
      variantKey: "keyframe-0001",
      sizeBytes: 50,
    });
    await seedDerived(store, rec, {
      kind: "video_frame",
      variantKey: "keyframe-0002",
      sizeBytes: 50,
    });
    expect(
      await prisma.evidencePartDerivedAsset.count({
        where: { evidencePartId: rec.partId, assetKind: "video_frame" },
      }),
      "three distinct video_frame variants (default + two keyframes) coexist",
    ).toBe(3);
    // Both variant bytes are counted (2 x 50).
    expect(await used()).toBe(base + 10_700n);

    const common = {
      teamId,
      evidenceId: rec.id,
      evidencePartId: rec.partId,
      assetKind: "low_res_proxy" as const,
    };
    // A failed derivative with no bytes counts nothing.
    const failedFirst = await recordDerivedAsset(
      { ...common, status: "FAILED", lastError: "no codec" },
      prisma,
    );
    expect(failedFirst).toEqual({ ok: true, id: expect.any(String), previousStorage: null });
    expect(await used()).toBe(base + 10_700n);

    // Success: 1000 bytes.
    const ok1 = await recordDerivedAsset(
      {
        ...common,
        status: "COMPLETED",
        derivedSha256: "c".repeat(64),
        sizeBytes: 1_000,
        storageBucket: bucket,
        storageKey: "derived-assets/proxy-v1",
      },
      prisma,
    );
    expect(ok1.ok && ok1.previousStorage).toBeNull();
    expect(await used()).toBe(base + 11_700n);

    // Regeneration replaces, never adds; the superseded pointer is reported.
    const ok2 = await recordDerivedAsset(
      {
        ...common,
        status: "COMPLETED",
        derivedSha256: "d".repeat(64),
        sizeBytes: 1_500,
        storageBucket: bucket,
        storageKey: "derived-assets/proxy-v2",
      },
      prisma,
    );
    expect(ok2.ok && ok2.previousStorage).toEqual({
      bucket,
      key: "derived-assets/proxy-v1",
    });
    expect(await used()).toBe(base + 12_200n);

    // A failure AFTER success keeps the bytes that still exist — pointer,
    // digest and size — so they remain counted and destroyable.
    await recordDerivedAsset({ ...common, status: "FAILED", lastError: "retry failed" }, prisma);
    const row = await prisma.evidencePartDerivedAsset.findFirstOrThrow({
      where: { evidencePartId: rec.partId, assetKind: "low_res_proxy" },
    });
    expect(row.status).toBe("FAILED");
    expect(row.storageKey).toBe("derived-assets/proxy-v2");
    expect(row.derivedSha256).toBe("d".repeat(64));
    expect(row.sizeBytes).toBe(1_500);
    expect(row.variantKey).toBe("default");
    expect(row.transformation).toBe("low-res-proxy/v1");
    expect(await used()).toBe(base + 12_200n);

    // Destroyed: nothing of the record counts.
    await prisma.evidence.update({
      where: { id: rec.id },
      data: trashedAndExpired() as never,
    });
    store.put(bucket, "derived-assets/proxy-v2");
    const destroyed = await executeEvidenceDestruction(
      prisma,
      { evidenceId: rec.id, trigger: "manual", legalHold: false },
      store.port,
    );
    expect(destroyed).toMatchObject({ ok: true });
    expect(store.has(bucket, "derived-assets/proxy-v2")).toBe(false);
    expect(await used()).toBe(base);
  });

  // ===========================================================================
  // 3. Acquisition authority — database invariants
  // ===========================================================================

  it("acquisition_mode is set-once at the database, and bounded", async () => {
    const store = new DisposableStore();
    const rec = await seedRecord(store, {
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      acquisitionModeSource: "RECORDED_AT_CREATION",
    });
    // Unrelated updates (completion-shaped, lifecycle) are unaffected.
    await prisma.evidence.update({
      where: { id: rec.id },
      data: { captureMethod: "MULTIPART_PACKAGE", status: "REPORTED", lifecycleState: "ARCHIVED" },
    });
    await expect(
      prisma.evidence.update({
        where: { id: rec.id },
        data: { acquisitionMode: "SECURE_INTAKE_LINK" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.evidence.update({
        where: { id: rec.id },
        data: { acquisitionMode: null, acquisitionModeSource: null },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.evidence.update({
        where: { id: rec.id },
        data: { acquisitionModeSource: "BACKFILL_INTAKE_SESSION_LINK" },
      }),
    ).rejects.toThrow(/immutable/);
    const after = await prisma.evidence.findUniqueOrThrow({
      where: { id: rec.id },
      select: { acquisitionMode: true, acquisitionModeSource: true },
    });
    expect(after).toEqual({
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
      acquisitionModeSource: "RECORDED_AT_CREATION",
    });

    // Unbounded values and a mode without its source are refused.
    const store2 = new DisposableStore();
    await expect(seedRecord(store2, { acquisitionMode: "DIRECT_CAPTURE", acquisitionModeSource: "RECORDED_AT_CREATION" })).rejects.toThrow();
    await expect(seedRecord(store2, { acquisitionMode: "PROOVRA_WEB_UPLOAD" })).rejects.toThrow();
  });

  it("the D9 backfill statement sets only proven intake records, idempotently", async () => {
    const fs = await import("node:fs");
    const sql = fs.readFileSync(
      new URL(
        "../prisma/migrations/20280601000000_uc0_acquisition_provenance_foundation/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const start = sql.indexOf('UPDATE "evidence" AS e');
    const end = sql.indexOf(";", start);
    const backfill = sql.slice(start, end);
    expect(backfill).toContain("BACKFILL_INTAKE_SESSION_LINK");

    const store = new DisposableStore();
    const intake = await seedRecord(store);
    const legacy = await seedRecord(store);
    const team = harness.fixtures.teamA;
    const link = await prisma.workflowIntakeLink.create({
      data: {
        teamId: team.teamId,
        createdByUserId: team.ownerUserId,
        workflowTemplateSlug: "general-evidence-record",
        workflowTemplateVersion: 1,
        workflowTemplateSnapshot: {},
        intakeMode: "EXTERNAL_ONE_TIME",
        allowedAcceptedKinds: [],
        ipAllowlistCidrs: [],
        tokenHash: randomBytes(32).toString("hex"),
        expiresAtUtc: new Date(Date.now() + DAY),
      } as never,
      select: { id: true },
    });
    await prisma.workflowIntakeSession.create({
      data: {
        intakeLinkId: link.id,
        evidenceId: intake.id,
        expiresAtUtc: new Date(Date.now() + DAY),
      } as never,
    });

    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(backfill); // idempotent

    const [i, l] = await Promise.all([
      prisma.evidence.findUniqueOrThrow({
        where: { id: intake.id },
        select: { acquisitionMode: true, acquisitionModeSource: true },
      }),
      prisma.evidence.findUniqueOrThrow({
        where: { id: legacy.id },
        select: { acquisitionMode: true, acquisitionModeSource: true },
      }),
    ]);
    expect(i).toEqual({
      acquisitionMode: "SECURE_INTAKE_LINK",
      acquisitionModeSource: "BACKFILL_INTAKE_SESSION_LINK",
    });
    // No proof, no value: projected as "not recorded", never guessed.
    expect(l).toEqual({ acquisitionMode: null, acquisitionModeSource: null });
  });

  // =========================================================================
  // A2 — retroactive reconciliation of derived material on DESTROYED tombstones
  // (records destroyed BEFORE the P0-7 fix kept their derived rows + objects).
  // =========================================================================
  describe("A2 — historical destroyed-derivative reconciliation", () => {
    async function seedDestroyedTombstoneWithDerived(store: DisposableStore) {
      const rec = await seedRecord(store, { lifecycleState: "DESTROYED" });
      const derived = await seedDerived(store, rec, { sizeBytes: 512 });
      await seedDerivedText(rec);
      return { rec, derived };
    }

    // Explicit teardown so a record one A2 test leaves behind is not swept by
    // the next (the reconciler is workspace-wide, not id-scoped).
    async function hardDelete(evidenceId: string) {
      await prisma.evidenceLegalHold.deleteMany({ where: { evidenceId } });
      await prisma.evidencePartDerivedAsset.deleteMany({ where: { evidenceId } });
      await prisma.evidenceOcrText.deleteMany({ where: { evidenceId } });
      await prisma.evidenceTranscriptSegment.deleteMany({ where: { evidenceId } });
      await prisma.evidenceSearchDocument.deleteMany({ where: { evidenceId } });
      await prisma.evidencePart.deleteMany({ where: { evidenceId } });
      await prisma.evidence.deleteMany({ where: { id: evidenceId } });
    }

    it("dry-run reports the leftover material and mutates nothing", async () => {
      const store = new DisposableStore();
      const { rec, derived } = await seedDestroyedTombstoneWithDerived(store);
      const { reconcileDestroyedDerivedAssets } = await import("@proovra/shared-runtime");

      const report = await reconcileDestroyedDerivedAssets(prisma, store.port, {
        dryRun: true,
        recordLimit: 500,
      });
      expect(report.dryRun).toBe(true);
      expect(report.tombstonesScanned).toBeGreaterThanOrEqual(1);
      expect(report.derivedBytesReclaimed).toBeGreaterThanOrEqual(512);
      // Nothing actually removed.
      expect(store.deleteCalls).toEqual([]);
      expect(store.has(bucket, derived.key)).toBe(true);
      await hardDelete(rec.id);
    });

    it("apply deletes the objects, removes the rows, and repairs storage accounting; then is idempotent", async () => {
      const store = new DisposableStore();
      const { sumDerivedAssetStorageBytes, reconcileDestroyedDerivedAssets } = await import(
        "@proovra/shared-runtime"
      );
      const teamId = harness.fixtures.teamA.teamId;
      const before = await sumDerivedAssetStorageBytes(prisma, { teamId });
      const { rec, derived } = await seedDestroyedTombstoneWithDerived(store);
      const seeded = await sumDerivedAssetStorageBytes(prisma, { teamId });
      expect(seeded - before).toBe(512n); // the tombstone's derived bytes are being counted

      const report = await reconcileDestroyedDerivedAssets(prisma, store.port, {
        dryRun: false,
        recordLimit: 500,
      });
      expect(report.derivedObjectsDeleted).toBeGreaterThanOrEqual(1);
      expect(report.derivedAssetRowsRemoved).toBeGreaterThanOrEqual(1);
      expect(report.searchDocumentRowsRemoved).toBeGreaterThanOrEqual(1);
      // Object gone, row gone, derived text gone.
      expect(store.has(bucket, derived.key)).toBe(false);
      expect(
        await prisma.evidencePartDerivedAsset.count({ where: { evidenceId: rec.id } }),
      ).toBe(0);
      expect(await prisma.evidenceOcrText.count({ where: { evidenceId: rec.id } })).toBe(0);
      expect(await prisma.evidenceSearchDocument.count({ where: { evidenceId: rec.id } })).toBe(0);
      // Storage accounting returns to where it started for this record.
      expect(await sumDerivedAssetStorageBytes(prisma, { teamId })).toBe(before);

      // Idempotent — this record no longer satisfies the selection.
      const second = await reconcileDestroyedDerivedAssets(prisma, store.port, {
        dryRun: false,
        recordLimit: 500,
      });
      expect(
        second.derivedAssetRowsRemoved,
        "a second run over cleaned data removes nothing for this record",
      ).toBe(0);
    });

    it("never touches a LIVE record's derivatives", async () => {
      const store = new DisposableStore();
      const { reconcileDestroyedDerivedAssets } = await import("@proovra/shared-runtime");
      const rec = await seedRecord(store, { lifecycleState: "ACTIVE" });
      const derived = await seedDerived(store, rec, { sizeBytes: 256 });

      await reconcileDestroyedDerivedAssets(prisma, store.port, {
        dryRun: false,
        recordLimit: 500,
      });
      expect(store.has(bucket, derived.key)).toBe(true);
      expect(
        await prisma.evidencePartDerivedAsset.count({ where: { evidenceId: rec.id } }),
      ).toBe(1);
    });

    it("skips a destroyed record that still carries an ACTIVE legal hold", async () => {
      const store = new DisposableStore();
      const { reconcileDestroyedDerivedAssets } = await import("@proovra/shared-runtime");
      const team = harness.fixtures.teamA;
      const { rec, derived } = await seedDestroyedTombstoneWithDerived(store);
      await prisma.evidenceLegalHold.create({
        data: {
          teamId: team.teamId,
          evidenceId: rec.id,
          organizationId,
          title: "Held tombstone (contrived invariant)",
          status: "ACTIVE",
          placedByUserId: team.ownerUserId,
        } as never,
      });

      const report = await reconcileDestroyedDerivedAssets(prisma, store.port, {
        dryRun: false,
        recordLimit: 500,
      });
      // This record is excluded from the selection; its material is untouched.
      expect(store.has(bucket, derived.key)).toBe(true);
      expect(
        await prisma.evidencePartDerivedAsset.count({ where: { evidenceId: rec.id } }),
      ).toBe(1);
      void report;
    });
  });
});
