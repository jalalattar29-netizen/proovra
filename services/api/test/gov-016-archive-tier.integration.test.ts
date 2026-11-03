/**
 * GOV-016 — archive tiers on a real versioned, Object Lock bucket (MinIO).
 *
 * Two defects. The manual transition copied the sealed version onto its own key,
 * which on a versioned bucket writes a NEW current version: no saving, and
 * `readRequiredObjectRetention` then reports NEWER_DATA_VERSION_THAN_SIGNED, so
 * destruction refused for ever. The auto worker imported a path that never existed
 * and wrote a PENDING label nothing processed, so a record read WARM after 30 days
 * and the label blocked its next step.
 *
 * What is proven here is S3 API behaviour on MinIO: version count, tags and the
 * retention reading. A bucket lifecycle rule moving tagged versions is NOT
 * exercised, here or anywhere, and real AWS is unverified.
 *
 * FIXTURE: records and transition rows are seeded directly around a real object.
 */
import { randomUUID } from "node:crypto";

import {
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readRequiredObjectRetention } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";

const LOCK_BUCKET = process.env.P7_LOCK_BUCKET ?? "point7-lock-bucket";
process.env.S3_BUCKET = LOCK_BUCKET;

describe("GOV-016 archive tiers on a versioned locked bucket (Postgres + MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let tiers: typeof import("../src/services/lifecycle/archive-tier.service.js");
  let worker: typeof import("../../worker/src/governance/archive-tier-auto-transition.worker.js");
  let storage: (typeof import("../src/services/evidence/destruction-storage-port.js"))["apiEvidenceDestructionStorage"];
  let s3: S3Client;

  const A = () => h.fixtures.teamA;

  async function sealedRecord(ageDays = 0) {
    const key = `evidence/${randomUUID()}/original.bin`;
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: LOCK_BUCKET,
        Key: key,
        Body: Buffer.from(`gov-016 ${key}`),
        ContentType: "text/plain",
        Tagging: "kept=yes",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(Date.now() + 60_000),
      }),
    );
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "SIGNED",
        mimeType: "text/plain",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        storageBucket: LOCK_BUCKET,
        storageKey: key,
        storageVersionId: put.VersionId,
        createdAt: new Date(Date.now() - ageDays * 86_400_000),
      } as never,
      select: { id: true },
    });
    return { id: row.id, key, versionId: put.VersionId! };
  }

  const versions = async (key: string) =>
    (await s3.send(new ListObjectVersionsCommand({ Bucket: LOCK_BUCKET, Prefix: key }))).Versions ?? [];

  const tagsOf = async (key: string, versionId: string) =>
    (await s3.send(new GetObjectTaggingCommand({ Bucket: LOCK_BUCKET, Key: key, VersionId: versionId }))).TagSet ?? [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    tiers = await import("../src/services/lifecycle/archive-tier.service.js");
    worker = await import("../../worker/src/governance/archive-tier-auto-transition.worker.js");
    ({ apiEvidenceDestructionStorage: storage } = await import(
      "../src/services/evidence/destruction-storage-port.js"
    ));
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
    });
  }, 900_000);

  beforeEach(() => {
    process.env.S3_BUCKET = LOCK_BUCKET;
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a manual transition writes no new version, keeps other tags, and leaves destruction able to proceed", async () => {
    const rec = await sealedRecord();
    await tiers.transitionEvidenceTier({
      teamId: A().teamId,
      evidenceId: rec.id,
      toTier: "COLD",
      initiatedByUserId: A().ownerUserId,
    });

    const after = await versions(rec.key);
    expect(after.map((v) => v.VersionId)).toEqual([rec.versionId]);
    expect(await tagsOf(rec.key, rec.versionId)).toEqual(
      expect.arrayContaining([
        { Key: "kept", Value: "yes" },
        { Key: "proovra-archive-tier", Value: "COLD" },
      ]),
    );
    const reading = await readRequiredObjectRetention(prisma as never, rec.id, storage, {
      objectLockExpected: true,
    });
    expect(reading.truth).toBe("VERIFIED");
    expect(await tiers.currentTierFor({ teamId: A().teamId, evidenceId: rec.id })).toBe("COLD");
    const row = await prisma.archiveTierTransition.findFirstOrThrow({ where: { evidenceId: rec.id } });
    // The tier is recorded; the byte move has not been observed, and says so.
    expect(row).toMatchObject({ state: "COMPLETED", storageClassAfter: null });
  });

  it("a planned row is not the record's tier", async () => {
    const rec = await sealedRecord();
    await prisma.archiveTierTransition.create({
      data: {
        teamId: A().teamId,
        evidenceId: rec.id,
        fromTier: "HOT",
        toTier: "WARM",
        reason: "AUTO_TRANSITION_PENDING",
        costEstimateUsdMicros: 0n,
        state: "PENDING",
      } as never,
    });
    expect(await tiers.currentTierFor({ teamId: A().teamId, evidenceId: rec.id })).toBe("HOT");
  });

  it("the auto worker tags the sealed version, writes COMPLETED, and takes over a stranded label", async () => {
    const fresh = await sealedRecord(31);
    const stranded = await sealedRecord(31);
    await prisma.archiveTierTransition.create({
      data: {
        teamId: A().teamId,
        evidenceId: stranded.id,
        fromTier: "HOT",
        toTier: "WARM",
        reason: "AUTO_TRANSITION_PENDING",
        costEstimateUsdMicros: 0n,
        state: "PENDING",
      } as never,
    });
    await worker.runArchiveTierAutoTransitions({ trigger: "test" });

    for (const rec of [fresh, stranded]) {
      const rows = await prisma.archiveTierTransition.findMany({ where: { evidenceId: rec.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "COMPLETED", toTier: "WARM", reason: "AUTO_TRANSITION" });
      expect((await versions(rec.key)).length).toBe(1);
      expect(await tagsOf(rec.key, rec.versionId)).toContainEqual({
        Key: "proovra-archive-tier",
        Value: "WARM",
      });
    }
  });

  it("a workspace behind five hundred older ones is still swept", async () => {
    const { organizationId } = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const older = Array.from({ length: 501 }, (_, i) => ({
      id: randomUUID(),
      name: `gov-016 older ${i}`,
      ownerUserId: A().ownerUserId,
      organizationId,
      workspaceKind: "ORGANIZATION",
      isPersonal: false,
      createdAt: new Date(Date.now() - 400 * 86_400_000),
    }));
    await prisma.team.createMany({ data: older as never });
    try {
      const rec = await sealedRecord(31);
      await worker.runArchiveTierAutoTransitions({ trigger: "test" });
      expect(await prisma.archiveTierTransition.count({ where: { evidenceId: rec.id, state: "COMPLETED" } })).toBe(1);
    } finally {
      await prisma.team.deleteMany({ where: { id: { in: older.map((t) => t.id) } } });
    }
  });

  it("a due record behind four hundred records that are not due is still tiered", async () => {
    // CAPACITY (2026-11-03): the sweep read 400 rows of the workspace in index
    // order and judged only those, so a due record outside them waited forever.
    const { organizationId } = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const young = Array.from({ length: 401 }, (_, i) => ({
      // Ids that sort before any random one, so they fill an id-ordered read.
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      type: "DOCUMENT",
      status: "SIGNED",
      teamId: A().teamId,
      organizationId,
      ownerUserId: A().ownerUserId,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    }));
    await prisma.evidence.createMany({ data: young as never });
    try {
      const due = await sealedRecord(31);
      await worker.runArchiveTierAutoTransitions({ trigger: "test" });
      expect(
        await prisma.archiveTierTransition.count({ where: { evidenceId: due.id, state: "COMPLETED", toTier: "WARM" } }),
      ).toBe(1);
      expect(await prisma.archiveTierTransition.count({ where: { evidenceId: { in: young.map((r) => r.id) } } })).toBe(0);
    } finally {
      await prisma.evidence.deleteMany({ where: { id: { in: young.map((r) => r.id) } } });
    }
  });

  it("a record with no sealed version gets no label", async () => {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "CREATED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        createdAt: new Date(Date.now() - 40 * 86_400_000),
      } as never,
      select: { id: true },
    });
    await worker.runArchiveTierAutoTransitions({ trigger: "test" });
    expect(await prisma.archiveTierTransition.count({ where: { evidenceId: row.id } })).toBe(0);
  });
});
