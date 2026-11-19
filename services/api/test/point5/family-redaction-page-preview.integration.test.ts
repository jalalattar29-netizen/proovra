/**
 * PRO-R3-04 — POINT 5 FAMILY 1, the page-preview unit: state machine.
 *
 * Drives the REAL production chain against live PostgreSQL 16:
 *
 *   durable authority  RedactionPagePreview
 *   claim              claimPagePreviewForRender (conditional UPDATE)
 *   processor          services/worker/src/redaction/redaction-page-preview.processor.ts
 *   terminal writer    services/worker/src/redaction/redaction-page-preview-writer.ts
 *   reconciler         reconcileStrandedRedactionPagePreviews (driven by
 *                      RedactionStrandedReconciler)
 *
 * The raster itself (PDF.js, canvas, storage) is a genuine external boundary
 * and never runs here: the seeded records have no stored object, so every
 * case is about what happens BEFORE a page would be rendered, or about what
 * the durable row says AFTER. The render and the read are proven in
 * `services/worker/test/redaction-page-preview.test.ts` and
 * `test/ws-rev-redaction-page-preview.integration.test.ts`.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_NAMES, decodeJobPayload, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import {
  proveCommonConformance,
  type UnitDriver,
  type WorkspaceFixture,
} from "./family-harness.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW);

describe("POINT 5 FAMILY — redaction page preview (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let processor: typeof import("../../../worker/src/redaction/redaction-page-preview.processor.js");
  let writer: typeof import("../../../worker/src/redaction/redaction-page-preview-writer.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../../worker/src/redaction/redaction-page-preview.processor.js");
    writer = await import("../../../worker/src/redaction/redaction-page-preview-writer.js");

    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  });

  afterAll(async () => {
    // Record BEFORE teardown: the proof is what executed.
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /** A fresh record per seed: one redaction project per (team, record). */
  async function seedPreview(input: {
    teamId: string;
    fixture: WorkspaceFixture;
    state?: string;
    overrides?: Record<string, unknown>;
  }): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: input.teamId },
      select: { organizationId: true },
    });
    const evidence = await prisma.evidence.create({
      data: {
        title: `point5-page-preview-${randomUUID()}`,
        type: "DOCUMENT",
        status: "CREATED",
        teamId: input.teamId,
        organizationId: team.organizationId,
        ownerUserId: input.fixture.ownerUserId,
      },
      select: { id: true },
    });
    const project = await prisma.redactionProject.create({
      data: {
        teamId: input.teamId,
        evidenceId: evidence.id,
        state: "OPEN",
        artifactKind: "PDF",
        createdByUserId: input.fixture.ownerUserId,
      },
      select: { id: true },
    });
    const preview = await prisma.redactionPagePreview.create({
      data: {
        teamId: input.teamId,
        projectId: project.id,
        evidenceId: evidence.id,
        pageIndex: 0,
        state: input.state ?? "QUEUED",
        ...(input.overrides ?? {}),
      },
      select: { id: true },
    });
    return preview.id;
  }

  function jobFor(previewId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `rpp-${previewId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: {
        commandId: previewId,
        traceId: "family-matrix",
        schemaVersion: ENTRY.schemaVersion,
        ...overrides,
      },
    } as never;
  }

  const readState = async (rowId: string) =>
    (await prisma.redactionPagePreview.findUnique({ where: { id: rowId }, select: { state: true } }))?.state ?? null;

  const driver: UnitDriver = {
    slug: "redaction.preview",
    workName: JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW,
    terminalStates: ["READY", "FAILED"],
    async seed({ teamId, fixture }) {
      return seedPreview({ teamId, fixture });
    },
    async execute(rowId) {
      // The REAL processor: strict decode, then the claim; the raster is only
      // reached past the claim and the source binding.
      await processor.processRedactionPagePreviewJob(jobFor(rowId));
    },
    readState,
    async makeTerminal(rowId) {
      await prisma.redactionPagePreview.update({ where: { id: rowId }, data: { state: "READY" } });
    },
    async claimFreshly(rowId) {
      await prisma.redactionPagePreview.update({
        where: { id: rowId },
        data: { state: "RENDERING", renderStartedAt: new Date() },
      });
    },
    async countInWorkspace(teamId) {
      return prisma.redactionPagePreview.count({ where: { teamId } });
    },
  };

  it("proves the seven common state-machine invariants", async () => {
    await proveCommonConformance(driver, {
      own,
      foreign,
      readWorkspace: async (rowId) =>
        (await prisma.redactionPagePreview.findUnique({ where: { id: rowId }, select: { teamId: true } }))?.teamId ??
        null,
    });
  });

  it("an unknown payload field is rejected before the claim is attempted", async () => {
    const id = await seedPreview({ teamId: own.teamId, fixture: own });
    expect(() =>
      decodeJobPayload(
        { jobName: ENTRY.workName, schemaVersion: ENTRY.schemaVersion },
        { commandId: id, traceId: "t", schemaVersion: ENTRY.schemaVersion, teamId: foreign.teamId },
      ),
    ).toThrow();
    await processor.processRedactionPagePreviewJob(jobFor(id, { teamId: foreign.teamId }));
    expect(await readState(id)).toBe("QUEUED");
    // A payload of no canonical shape is quarantined: this job has no legacy form.
    await processor.processRedactionPagePreviewJob({
      id: `rpp-${id}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: { previewId: id, teamId: foreign.teamId },
    } as never);
    expect(await readState(id)).toBe("QUEUED");
    provenCase("redaction.preview.payload.rejects_unknown_field");
  });

  it("a job arriving under the WRONG work name is refused", async () => {
    const id = await seedPreview({ teamId: own.teamId, fixture: own });
    await processor.processRedactionPagePreviewJob({
      ...(jobFor(id) as unknown as Record<string, unknown>),
      name: JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
    } as never);
    expect(await readState(id)).toBe("QUEUED");
  });

  it("a page that could not be rendered is FAILED with a reason and no storage pointer, never READY", async () => {
    // No stored object behind the record: the processor refuses at the source
    // binding. READY is written only by the terminal writer after a stored page.
    const id = await seedPreview({ teamId: own.teamId, fixture: own });
    await processor.processRedactionPagePreviewJob(jobFor(id));
    const row = await prisma.redactionPagePreview.findUniqueOrThrow({
      where: { id },
      select: { state: true, storageKey: true, byteSize: true, failureReason: true },
    });
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toBe("source_object_missing");
    expect(row.storageKey).toBeNull();
    expect(row.byteSize).toBeNull();

    // A project that is not a PDF is refused before the record is read.
    const image = await seedPreview({ teamId: own.teamId, fixture: own });
    const imageRow = await prisma.redactionPagePreview.findUniqueOrThrow({ where: { id: image }, select: { projectId: true } });
    await prisma.redactionProject.update({ where: { id: imageRow.projectId }, data: { artifactKind: "IMAGE" } });
    await processor.processRedactionPagePreviewJob(jobFor(image));
    expect(
      await prisma.redactionPagePreview.findUniqueOrThrow({ where: { id: image }, select: { state: true, failureReason: true } }),
    ).toEqual({ state: "FAILED", failureReason: "unsupported_media" });
    provenCase("redaction.preview.failure.no_false_ready");
  });

  it("only the worker holding the current claim can complete, fail or release it", async () => {
    const id = await seedPreview({ teamId: own.teamId, fixture: own });
    const first = await writer.claimPagePreviewForRender(id);
    expect(first).toMatchObject({ claimed: true });
    if (!first.claimed) throw new Error("unreachable");
    // A live claim is not taken.
    expect(await writer.claimPagePreviewForRender(id)).toEqual({ claimed: false, reason: "not_queued" });
    // A stale token (an earlier claim of the same row) writes nothing.
    const stale = new Date(first.claimedAt.getTime() - 60_000);
    expect(await writer.releasePagePreviewClaim(id, stale)).toBe(false);
    expect(
      await writer.markPagePreviewFailedWorker({ previewId: id, teamId: own.teamId, failureReason: "x", claimedAt: stale }),
    ).toEqual({ ok: false, reason: "stale_transition" });
    // Another workspace's id never matches the row.
    expect(
      await writer.markPagePreviewFailedWorker({ previewId: id, teamId: foreign.teamId, failureReason: "x", claimedAt: first.claimedAt }),
    ).toEqual({ ok: false, reason: "stale_transition" });
    expect(await readState(id)).toBe("RENDERING");
    // The holder gives it back; the retry claims it again.
    expect(await writer.releasePagePreviewClaim(id, first.claimedAt)).toBe(true);
    expect(await readState(id)).toBe("QUEUED");
    expect(await writer.claimPagePreviewForRender(id)).toMatchObject({ claimed: true });
  });

  it("the reconciler recovers a stranded QUEUED preview and an expired lease exactly once, and nothing else", async () => {
    const stranded = await seedPreview({ teamId: own.teamId, fixture: own });
    await prisma.redactionPagePreview.update({
      where: { id: stranded },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const expired = await seedPreview({
      teamId: own.teamId,
      fixture: own,
      state: "RENDERING",
      overrides: { renderStartedAt: new Date(Date.now() - writer.REDACTION_PAGE_PREVIEW_LEASE_MS - 60_000) },
    });
    const fresh = await seedPreview({ teamId: own.teamId, fixture: own });
    const live = await seedPreview({
      teamId: own.teamId,
      fixture: own,
      state: "RENDERING",
      overrides: { renderStartedAt: new Date() },
    });
    const terminal = await seedPreview({ teamId: own.teamId, fixture: own, state: "READY" });
    await prisma.redactionPagePreview.update({
      where: { id: terminal },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const enqueued: string[] = [];
    const result = await processor.reconcileStrandedRedactionPagePreviews({
      olderThanMs: 5 * 60_000,
      batchSize: 500,
      enqueue: async (payload) => {
        enqueued.push(payload.previewId);
        return { enqueued: true };
      },
    });
    expect(enqueued.filter((id) => id === stranded)).toHaveLength(1);
    expect(enqueued.filter((id) => id === expired)).toHaveLength(1);
    expect(enqueued).not.toContain(fresh);
    expect(enqueued, "a live claim is not stolen").not.toContain(live);
    expect(enqueued, "a terminal row is never reopened").not.toContain(terminal);
    expect(result.reenqueued).toBeGreaterThanOrEqual(2);
    expect(await readState(terminal)).toBe("READY");
    // The expired lease is taken over by the claim; the live one is not.
    expect(await writer.claimPagePreviewForRender(expired)).toMatchObject({ claimed: true });
    expect(await writer.claimPagePreviewForRender(live)).toEqual({ claimed: false, reason: "not_queued" });

    // A failed enqueue leaves the row QUEUED for the next tick.
    await processor.reconcileStrandedRedactionPagePreviews({
      olderThanMs: 5 * 60_000,
      batchSize: 500,
      enqueue: async () => ({ enqueued: false }),
    });
    expect(await readState(stranded)).toBe("QUEUED");
    provenCase("redaction.recon.preview.recovers_stranded_once");
  });
});
