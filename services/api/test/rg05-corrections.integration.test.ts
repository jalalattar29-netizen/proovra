/**
 * PRO-AI1Z-03 — the reviewer-correction chain (live PostgreSQL 16).
 *
 * At the base SHA: reverting an accepted correction left the record
 * CORRECTED; a revert marker could itself be reverted; two concurrent accepts
 * of one draft both passed; concurrent writers could take one version number.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-AI1Z-03 correction chain (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/intelligence/reviewer-correction.service.js");
  let teamId: string;
  let userId: string;
  let evidenceId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/intelligence/reviewer-correction.service.js");
    teamId = h.fixtures.teamA.teamId;
    userId = h.fixtures.teamA.ownerUserId;
    evidenceId = h.fixtures.teamA.evidenceId;
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function record() {
    return prisma.mediaIntelligenceRecord.create({
      data: {
        teamId,
        evidenceId,
        modality: "DOCUMENT",
        kind: "DOCUMENT_OCR_TEXT",
        provider: "AZURE_DOCUMENT_INTELLIGENCE",
        providerConfidenceBand: "MEDIUM",
        finalConfidenceBand: "MEDIUM",
        providerRecordKey: randomUUID(),
      },
      select: { id: true },
    });
  }

  async function draft(recordId: string) {
    const c = await svc.createCorrection({
      teamId,
      recordId,
      kind: "OCR_TEXT",
      patch: { text: "corrected" },
      reviewConfidenceBand: "HIGH",
      authoredByUserId: userId,
    });
    expect(c.ok).toBe(true);
    return (c as { correctionId: string }).correctionId;
  }

  it("reverting the accepted head restores the record to the provider output", async () => {
    const rec = await record();
    const id = await draft(rec.id);
    await expect(svc.acceptCorrection({ teamId, correctionId: id, acceptedByUserId: userId })).resolves.toMatchObject({ ok: true });
    expect((await prisma.mediaIntelligenceRecord.findUnique({ where: { id: rec.id } }))?.state).toBe("CORRECTED");
    const rev = await svc.revertCorrection({ teamId, correctionId: id, actorUserId: userId });
    expect(rev.ok).toBe(true);
    const after = await prisma.mediaIntelligenceRecord.findUnique({ where: { id: rec.id } });
    expect(after).toMatchObject({ state: "PENDING", reviewedAt: null, finalConfidenceBand: "MEDIUM" });
  });

  it("a revert marker and an already-reverted correction cannot be reverted", async () => {
    const rec = await record();
    const id = await draft(rec.id);
    const rev = await svc.revertCorrection({ teamId, correctionId: id, actorUserId: userId });
    expect(rev.ok).toBe(true);
    const marker = (rev as { revertedCorrectionId: string }).revertedCorrectionId;
    await expect(svc.revertCorrection({ teamId, correctionId: marker, actorUserId: userId })).resolves.toEqual({
      ok: false,
      denial: "POLICY_REJECTED",
    });
    await expect(svc.revertCorrection({ teamId, correctionId: id, actorUserId: userId })).resolves.toEqual({
      ok: false,
      denial: "POLICY_REJECTED",
    });
  });

  it("two concurrent accepts of one draft: exactly one succeeds", async () => {
    const rec = await record();
    const id = await draft(rec.id);
    const results = await Promise.all([
      svc.acceptCorrection({ teamId, correctionId: id, acceptedByUserId: userId }),
      svc.acceptCorrection({ teamId, correctionId: id, acceptedByUserId: userId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("concurrent drafts on one record take distinct version numbers", async () => {
    const rec = await record();
    await Promise.all(Array.from({ length: 6 }, () => draft(rec.id)));
    const versions = (
      await prisma.reviewerCorrection.findMany({ where: { recordId: rec.id }, select: { versionNumber: true } })
    ).map((r) => r.versionNumber);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
