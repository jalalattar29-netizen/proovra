/**
 * REPORT-006 — a published object is accountable before its row exists.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("artifact publication intents (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let orphan: typeof import("../../worker/src/orphan-scan.js");
  let intents: typeof import("../../worker/src/publication-intent.js");
  let publication: typeof import("../../worker/src/immutable-publication.js");
  let platform: typeof import("../src/services/operations/platform-conditions.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    orphan = await import("../../worker/src/orphan-scan.js");
    intents = await import("../../worker/src/publication-intent.js");
    publication = await import("../../worker/src/immutable-publication.js");
    platform = await import("../src/services/operations/platform-conditions.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("both publication paths publish through the intent, and the intent is written before the write", () => {
    for (const rel of ["../../worker/src/processor.ts", "../../worker/src/package-issuance.ts"]) {
      expect(src(rel), rel).toContain("await publishThroughIntent({");
    }
    const body = src("../../worker/src/publication-intent.ts");
    const intent = body.indexOf("await recordPublicationIntent({");
    expect(intent).toBeGreaterThan(-1);
    expect(body.indexOf("await input.publish(key)", intent)).toBeGreaterThan(intent);
  });

  it("a retry of the same request with the same bytes reuses the verified object; other bytes publish anew", async () => {
    const bucket = process.env.S3_BUCKET!;
    const requestId = randomUUID();
    const evidenceId = h.fixtures.teamA.evidenceId;
    const keys: string[] = [];
    const attempt = (bytes: Buffer) =>
      intents.publishThroughIntent({
        evidenceId,
        requestId,
        family: "reports",
        bucket,
        version: 1,
        extension: "pdf",
        sizeBytes: bytes.length,
        sha256Base64: createHash("sha256").update(bytes).digest("base64"),
        lock: null,
        publish: (key) => {
          keys.push(key);
          return publication.publishImmutableArtifact({
            lock: null,
            bucket,
            key,
            body: { kind: "buffer", buffer: bytes },
            sha256Base64: createHash("sha256").update(bytes).digest("base64"),
            contentType: "application/pdf",
          });
        },
      });
    const bytes = Buffer.from(`report-006 ${requestId}`);

    const first = await attempt(bytes);
    expect(first.reused).toBe(false);
    const row = await prisma.artifactPublicationIntent.findFirstOrThrow({ where: { storageKey: first.key } });
    expect(row.verifiedAtUtc).not.toBeNull();
    expect(row.sha256Hex).toBe(first.sha256Hex);

    // The commit failed; the retry renders the same bytes.
    const second = await attempt(bytes);
    expect(second).toMatchObject({ reused: true, key: first.key, versionId: first.versionId });
    expect(keys).toHaveLength(1);
    expect(await prisma.artifactPublicationIntent.count({ where: { requestId } })).toBe(1);

    const third = await attempt(Buffer.from(`other bytes ${requestId}`));
    expect(third.reused).toBe(false);
    expect(third.key).not.toBe(first.key);
    expect(keys).toHaveLength(2);
  });

  it("Operations raises one platform condition for a recent unreferenced publication, and closes it", async () => {
    const openRow = () =>
      prisma.operationalIncident.findFirst({
        where: { fingerprint: platform.UNREFERENCED_PUBLICATIONS_FINGERPRINT, teamId: null, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        select: { id: true, messageCode: true, messageParams: true },
      });
    const intent = await prisma.artifactPublicationIntent.create({
      data: {
        evidenceId: h.fixtures.teamA.evidenceId,
        requestId: randomUUID(),
        family: "verification",
        storageBucket: "bucket-intent-test",
        storageKey: `verification/${randomUUID()}.zip`,
        createdAtUtc: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    });
    try {
      await platform.reconcilePlatformConditions();
      const row = await openRow();
      expect(row?.messageCode).toBe("ops.platform.unreferenced_published_artifacts");
      expect((row?.messageParams as { recent?: number } | null)?.recent).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.artifactPublicationIntent.delete({ where: { id: intent.id } });
    }
    const after = await platform.observeUnreferencedPublications(new Date());
    if (after.recent === 0) {
      await platform.reconcilePlatformConditions();
      expect(await openRow()).toBeNull();
    }
  });

  it("an old intent no row references is counted, for as long as nothing references it", async () => {
    const before = (await orphan.runOrphanArtifactScan({ trigger: "test" })).unreferencedPublishedArtifactCount;
    const key = `reports/${randomUUID()}.pdf`;
    const row = {
      evidenceId: h.fixtures.teamA.evidenceId,
      requestId: randomUUID(),
      family: "reports",
      storageBucket: "bucket-intent-test",
      storageKey: key,
    };
    const old = await prisma.artifactPublicationIntent.create({
      data: { ...row, createdAtUtc: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
    const young = await prisma.artifactPublicationIntent.create({
      data: { ...row, storageKey: `${key}.young` },
    });
    try {
      const counted = await orphan.runOrphanArtifactScan({ trigger: "test" });
      // The young one may still be committing; the old one has no row.
      expect(counted.unreferencedPublishedArtifactCount).toBe(before + 1);
    } finally {
      await prisma.artifactPublicationIntent.deleteMany({ where: { id: { in: [old.id, young.id] } } });
    }
  });
});
