/**
 * REPORT-006 — a published object is accountable before its row exists.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("artifact publication intents (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let orphan: typeof import("../../worker/src/orphan-scan.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    orphan = await import("../../worker/src/orphan-scan.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("the intent is written before the locked write, on both publication paths", () => {
    for (const rel of ["../../worker/src/processor.ts", "../../worker/src/package-issuance.ts"]) {
      const body = src(rel);
      const intent = body.indexOf("await recordPublicationIntent({");
      expect(intent, rel).toBeGreaterThan(-1);
      expect(body.indexOf("await publishImmutableArtifact({", intent), rel).toBeGreaterThan(intent);
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
