/**
 * GOV-010 and EVID-016 — a destroyed record keeps its audit trail and loses its
 * content, on the record, in the derived tables and in the graph.
 *
 * Before: title, notes, file names, submitter email and GPS stayed on the row,
 * extracted entities and AI summaries stayed in their tables, and the graph kept
 * answering by filename, for trashed records as well.
 *
 * FIXTURES (labelled): the derived rows are seeded directly, standing for what the
 * extraction pipeline writes. Destruction runs through the real executor against a
 * disposable in-memory storage port.
 */
import { EvidenceEntityKind, EvidenceEntitySource, EvidenceSimilarityKind } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeEvidenceDestruction, reconcileTeamGraph } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedExecutableReview } from "./support/executable-destruction-review.js";

const storage = {
  listObjectVersions: async () => [],
  deleteObjectVersion: async () => ({ ok: true }),
  listKeysUnderPrefix: async () => [],
};

describe("GOV-010 EVID-016 the tombstone keeps history, not content (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const A = () => h.fixtures.teamA;

  async function richRecord(fileName: string) {
    const past = new Date(Date.now() - 86_400_000);
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const ev = await prisma.evidence.create({
      data: {
        title: "Jane Doe accident photo",
        internalNotes: "call Jane on Friday",
        originalFileName: fileName,
        displayFileName: fileName,
        submittedByEmail: "jane@example.test",
        lat: 52.52,
        lng: 13.4,
        accuracyMeters: 4,
        technicalMetadata: { camera: "X" },
        captureEnvironment: { device: "Y" },
        intakeCustomerId: "cust-1",
        fingerprintCanonicalJson: "{}",
        fingerprintHash: "a".repeat(64),
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        lifecycleState: "TRASHED",
        deletedAt: past,
        deleteScheduledForUtc: past,
      } as never,
      select: { id: true },
    });
    return ev.id;
  }

  async function derive(evidenceId: string) {
    const entity = await prisma.evidenceEntity.create({
      data: {
        evidenceId,
        teamId: A().teamId,
        kind: Object.values(EvidenceEntityKind)[0]!,
        source: Object.values(EvidenceEntitySource)[0]!,
        value: "Jane Doe",
      },
      select: { id: true },
    });
    await prisma.evidenceAiCategorization.create({
      data: {
        evidenceId,
        requestedByUserId: A().ownerUserId,
        legalDisclaimer: "advisory",
        summary: "a person named Jane Doe",
      } as never,
    });
    const record = await prisma.mediaIntelligenceRecord.create({
      data: {
        teamId: A().teamId,
        evidenceId,
        modality: "IMAGE",
        kind: "OBJECT",
        provider: "test",
        providerRecordKey: `k-${evidenceId}`,
        label: "licence plate B-XY 123",
      } as never,
      select: { id: true },
    });
    await prisma.mediaIntelligenceEntity.create({
      data: {
        teamId: A().teamId,
        evidenceId,
        recordId: record.id,
        kind: "PLATE",
        valueHash: "b".repeat(64),
        rawConfidence: 0.9,
        previewLabel: "B-XY",
      } as never,
    });
    await prisma.mediaIntelligenceSignal.create({
      data: { teamId: A().teamId, evidenceId, signalType: "EXIF_MISSING", safeSummary: "Jane" } as never,
    });
    await prisma.videoTimelineEvent.create({
      data: { teamId: A().teamId, evidenceId, layer: "L", code: "C", startFrame: 0, endFrame: 1, label: "Jane" } as never,
    });
    const { organizationId } = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const other = await prisma.evidence.create({
      data: { title: "other", type: "PHOTO", status: "SIGNED", teamId: A().teamId, organizationId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    await prisma.evidenceSimilarity.create({
      data: {
        teamId: A().teamId,
        sourceEvidenceId: evidenceId,
        targetEvidenceId: other.id,
        kind: Object.values(EvidenceSimilarityKind)[0]!,
        score: 0.8,
      } as never,
    });
    await prisma.evidenceLegalNote.create({
      data: { evidenceId, authorUserId: A().ownerUserId, body: "privileged view" } as never,
    });
    return entity.id;
  }

  const destroy = (evidenceId: string) =>
    executeEvidenceDestruction(
      prisma as never,
      { evidenceId, trigger: "manual", legalHold: false },
      storage as never,
    );

  async function graphNode(externalId: string, nodeKind = "EVIDENCE") {
    return prisma.investigationGraphNode.findFirst({
      where: { teamId: A().teamId, nodeKind, externalId },
      select: { id: true, safeLabel: true, staleAtUtc: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("clears the record's content, deletes what was derived, keeps audit and identifies what stays", async () => {
    const id = await richRecord("jane-doe.jpg");
    await derive(id);
    await seedExecutableReview(prisma as never, id);
    const res = await destroy(id);
    expect(res).toMatchObject({ ok: true, outcome: "DESTROYED" });
    if (res.ok && res.outcome === "DESTROYED") {
      expect(res.certificate.retainedByDesign).toContain("human_note_authorship");
      expect(res.certificate.retainedByDesign).toContain("sealed_capture_facts");
    }

    const row = await prisma.evidence.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      title: null,
      internalNotes: null,
      originalFileName: null,
      displayFileName: null,
      submittedByEmail: null,
      technicalMetadata: null,
      captureEnvironment: null,
      intakeCustomerId: null,
      lifecycleState: "DESTROYED",
    });
    expect(row.fingerprintHash, "the hash still identifies what existed").toBe("a".repeat(64));
    // Held permanent by database triggers, and named on every certificate until
    // the policy decision: see EVIDENCE_TOMBSTONE_SEALED_FIELDS.
    expect(row).toMatchObject({ lat: 52.52, lng: 13.4, fingerprintCanonicalJson: "{}" });

    for (const count of [
      prisma.evidenceEntity.count({ where: { evidenceId: id } }),
      prisma.evidenceAiCategorization.count({ where: { evidenceId: id } }),
      prisma.mediaIntelligenceRecord.count({ where: { evidenceId: id } }),
      prisma.mediaIntelligenceEntity.count({ where: { evidenceId: id } }),
      prisma.mediaIntelligenceSignal.count({ where: { evidenceId: id } }),
      prisma.videoTimelineEvent.count({ where: { evidenceId: id } }),
      prisma.evidenceSimilarity.count({ where: { sourceEvidenceId: id } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_PURGED" } })).toBe(1);
    // GOV-010 (decided): the note stays as history — its author and time — and its text goes.
    const notes = await prisma.evidenceLegalNote.findMany({ where: { evidenceId: id }, select: { body: true, authorUserId: true } });
    expect(notes).toEqual([{ body: "", authorUserId: A().ownerUserId }]);
  });

  it("EVID-016: the graph forgets a destroyed record and its entities, and a later reconcile does not rebuild them", async () => {
    const id = await richRecord("graph-target.jpg");
    const entityId = await derive(id);
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "ACTIVE", deletedAt: null, deleteScheduledForUtc: null },
    });
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect((await graphNode(id))?.safeLabel).toBe("graph-target.jpg");
    expect((await graphNode(entityId, "EXTRACTED_ENTITY"))?.staleAtUtc).toBeNull();

    // Destroyed from the review path: no trash timestamp, as an ACTIVE record has.
    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "PENDING_DESTRUCTION" } });
    await seedExecutableReview(prisma as never, id);
    expect(await destroy(id)).toMatchObject({ ok: true, outcome: "DESTROYED" });

    for (const node of [await graphNode(id), await graphNode(entityId, "EXTRACTED_ENTITY")]) {
      expect(node?.staleAtUtc).not.toBeNull();
      expect(node?.safeLabel).toBeNull();
    }
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect((await graphNode(id))?.staleAtUtc).not.toBeNull();
    expect((await graphNode(id))?.safeLabel).toBeNull();
    const edges = await prisma.investigationGraphEdge.count({
      where: { teamId: A().teamId, sourceNodeId: (await graphNode(id))!.id, staleAtUtc: null },
    });
    expect(edges).toBe(0);
  });

  it("EVID-016: a trashed record leaves the graph, a restored one comes back, and a record destroyed earlier is swept", async () => {
    const id = await richRecord("trashed.jpg");
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "ACTIVE", deletedAt: null, deleteScheduledForUtc: null },
    });
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect((await graphNode(id))?.staleAtUtc).toBeNull();

    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "TRASHED", deletedAt: new Date() } });
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect((await graphNode(id))?.staleAtUtc).not.toBeNull();
    expect((await graphNode(id))?.safeLabel, "a trashed record can come back").toBe("trashed.jpg");

    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "ACTIVE", deletedAt: null } });
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect((await graphNode(id))?.staleAtUtc).toBeNull();

    // Destroyed by a build that predates the executor's graph write.
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "DESTROYED", destroyedAtUtc: new Date() },
    });
    await reconcileTeamGraph(A().teamId, prisma as never);
    expect(await graphNode(id)).toMatchObject({ safeLabel: null });
    expect((await graphNode(id))?.staleAtUtc).not.toBeNull();
  });
});
