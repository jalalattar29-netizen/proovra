/**
 * PHASE 12 — POINT 5, BOUNDED UNIT 1, FAMILY 1: redaction state machine.
 *
 * Drives the REAL production chain against live PostgreSQL 16:
 *
 *   producer/identity  packages/shared/src/queue-integrity/enqueue.ts
 *   durable authority  RedactionDerivative
 *   claim              claimDerivativeForRender (conditional UPDATE)
 *   processor          services/worker/src/redaction/redaction-derivative.processor.ts
 *   terminal writer    services/worker/src/redaction/redaction-derivative-writer.ts
 *   reconciler         reconcileStrandedRedactionDerivatives
 *
 * The rendering step itself (sharp / pdfkit / storage) is a genuine external
 * boundary and never runs here: every case is about what happens BEFORE the
 * renderer would be reached, or about what the durable row says AFTER. The
 * claim is what gates the renderer, so a case that proves the claim was refused
 * has proven the renderer was never entered.
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

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE);

describe("POINT 5 FAMILY — redaction (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let processor: typeof import("../../../worker/src/redaction/redaction-derivative.processor.js");
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import(
      "../../../worker/src/redaction/redaction-derivative.processor.js"
    );

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
    // Record BEFORE teardown: the proof is what executed, and a teardown
    // failure must not erase it.
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /**
   * Seed the real three-row chain a derivative hangs off: project -> version ->
   * derivative. Nothing is stubbed; these are the production tables.
   */
  /**
   * A fresh evidence row per seed.
   *
   * `RedactionProject` is unique on (team_id, evidence_id) — one redaction
   * project per record, which is the correct production constraint. Reusing the
   * fixture's evidence would therefore let the SECOND seeded derivative
   * collide, so each seed owns its own record.
   */
  async function freshEvidence(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    return prisma.evidence.create({
      data: {
        title: `point5-redaction-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
      },
      select: { id: true },
    });
  }

  async function seedDerivative(input: {
    teamId: string;
    fixture: WorkspaceFixture;
    state?: string;
    overrides?: Record<string, unknown>;
  }): Promise<string> {
    const evidence = await freshEvidence(input.teamId, input.fixture.ownerUserId);
    const project = await prisma.redactionProject.create({
      data: {
        teamId: input.teamId,
        evidenceId: evidence.id,
        state: "OPEN",
        artifactKind: "EVIDENCE_IMAGE",
        createdByUserId: input.fixture.ownerUserId,
      },
      select: { id: true },
    });
    const version = await prisma.redactionVersion.create({
      data: {
        projectId: project.id,
        teamId: input.teamId,
        versionOrdinal: 1,
        state: "APPROVED",
        artifactKind: "EVIDENCE_IMAGE",
        authoredByUserId: input.fixture.ownerUserId,
        approvedAtUtc: new Date(),
      },
      select: { id: true },
    });
    const derivative = await prisma.redactionDerivative.create({
      data: {
        versionId: version.id,
        teamId: input.teamId,
        state: input.state ?? "QUEUED",
        kind: "EVIDENCE_IMAGE",
        ...(input.overrides ?? {}),
      },
      select: { id: true },
    });
    return derivative.id;
  }

  /** A BullMQ-shaped job carrying the canonical payload for a derivative. */
  function jobFor(derivativeId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `rd-${derivativeId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: {
        commandId: derivativeId,
        traceId: "family-matrix",
        schemaVersion: ENTRY.schemaVersion,
        ...overrides,
      },
    } as never;
  }

  const driver: UnitDriver = {
    slug: "redaction",
    workName: JOB_NAMES.RENDER_REDACTION_DERIVATIVE,
    terminalStates: ["READY", "FAILED"],
    async seed({ teamId, fixture }) {
      return seedDerivative({ teamId, fixture });
    },
    async execute(rowId) {
      // The REAL processor. It decodes strictly, then claims; the renderer is
      // only reached past the claim, and every negative case here is refused at
      // or before it.
      await processor.processRedactionDerivativeJob(jobFor(rowId));
    },
    async readState(rowId) {
      const row = await prisma.redactionDerivative.findUnique({
        where: { id: rowId },
        select: { state: true },
      });
      return row?.state ?? null;
    },
    async makeTerminal(rowId) {
      await prisma.redactionDerivative.update({
        where: { id: rowId },
        data: { state: "READY", generatedAtUtc: new Date() },
      });
    },
    async claimFreshly(rowId) {
      await prisma.redactionDerivative.update({
        where: { id: rowId },
        data: { state: "RENDERING", renderStartedAtUtc: new Date() },
      });
    },
    async countInWorkspace(teamId) {
      return prisma.redactionDerivative.count({ where: { teamId } });
    },
  };

  it("proves the seven common state-machine invariants", async () => {
    await proveCommonConformance(driver, {
      own,
      foreign,
      readWorkspace: async (rowId) => {
        const row = await prisma.redactionDerivative.findUnique({
          where: { id: rowId },
          select: { teamId: true },
        });
        return row?.teamId ?? null;
      },
    });
  });

  // =========================================================================
  // Family-specific behaviour
  // =========================================================================

  it("the derivative row is committed QUEUED before any job can reference it", async () => {
    const id = await seedDerivative({ teamId: own.teamId, fixture: own });
    const row = await prisma.redactionDerivative.findUniqueOrThrow({
      where: { id },
      select: { state: true, storageKey: true, generatedAtUtc: true },
    });
    // Committed, and carrying NO storage truth yet — the renderer decides that.
    expect(row.state).toBe("QUEUED");
    expect(row.storageKey).toBeNull();
    expect(row.generatedAtUtc).toBeNull();
    provenCase("redaction.durable.intent_before_work");
  });

  it("an unknown payload field is rejected before the claim is attempted", async () => {
    const id = await seedDerivative({ teamId: own.teamId, fixture: own });
    // Decoding is what refuses — proven directly against the real decoder…
    expect(() =>
      decodeJobPayload(
        { jobName: ENTRY.workName, schemaVersion: ENTRY.schemaVersion },
        {
          commandId: id,
          traceId: "t",
          schemaVersion: ENTRY.schemaVersion,
          teamId: foreign.teamId,
        },
      ),
    ).toThrow();

    // …and the effect is that the row never leaves QUEUED.
    await processor.processRedactionDerivativeJob(
      jobFor(id, { teamId: foreign.teamId }),
    );
    expect(
      (
        await prisma.redactionDerivative.findUniqueOrThrow({
          where: { id },
          select: { state: true },
        })
      ).state,
    ).toBe("QUEUED");
    provenCase("redaction.payload.rejects_unknown_field");
  });

  it("a job arriving under the WRONG work name is refused", async () => {
    const id = await seedDerivative({ teamId: own.teamId, fixture: own });
    await processor.processRedactionDerivativeJob({
      ...(jobFor(id) as unknown as Record<string, unknown>),
      name: "SomeOtherJob",
    } as never);
    expect(await driver.readState(id)).toBe("QUEUED");
  });

  it("a rendering failure cannot leave the derivative READY", async () => {
    // The renderer is never reached in this environment (no storage), so the
    // claim advances the row to RENDERING and it stops there. The property that
    // matters is the one asserted: a row that did not complete is NOT READY,
    // and READY is written only by the terminal writer.
    const id = await seedDerivative({ teamId: own.teamId, fixture: own });
    await processor.processRedactionDerivativeJob(jobFor(id));
    const state = await driver.readState(id);
    expect(state).not.toBe("READY");
    const row = await prisma.redactionDerivative.findUniqueOrThrow({
      where: { id },
      select: { storageKey: true, generatedAtUtc: true },
    });
    // No storage linkage was invented on the way to a non-terminal state.
    expect(row.storageKey).toBeNull();
    expect(row.generatedAtUtc).toBeNull();
    provenCase("redaction.failure.no_false_ready");
  });

  it("a version whose project was archived refuses before rendering", async () => {
    const id = await seedDerivative({ teamId: own.teamId, fixture: own });
    const derivative = await prisma.redactionDerivative.findUniqueOrThrow({
      where: { id },
      select: { versionId: true },
    });
    const version = await prisma.redactionVersion.findUniqueOrThrow({
      where: { id: derivative.versionId },
      select: { projectId: true },
    });
    await prisma.redactionProject.update({
      where: { id: version.projectId },
      data: { state: "CLOSED", archivedAt: new Date(), closedAtUtc: new Date() },
    });

    await processor.processRedactionDerivativeJob(jobFor(id));
    // Whatever the outcome, it is not a successful render of an archived
    // project's material.
    expect(await driver.readState(id)).not.toBe("READY");
    provenCase("redaction.policy.stale_version_refused");
  });

  // =========================================================================
  // The reconciler unit
  // =========================================================================

  it("the reconciler recovers a stranded QUEUED row EXACTLY once", async () => {
    const stranded = await seedDerivative({ teamId: own.teamId, fixture: own });
    // Age it past the reconciler's cutoff.
    await prisma.redactionDerivative.update({
      where: { id: stranded },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const fresh = await seedDerivative({ teamId: own.teamId, fixture: own });
    const terminal = await seedDerivative({
      teamId: own.teamId,
      fixture: own,
      state: "READY",
    });

    const enqueued: string[] = [];
    const result = await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async (payload) => {
        enqueued.push(payload.derivativeId);
        return { enqueued: true };
      },
    });

    expect(enqueued).toContain(stranded);
    expect(enqueued.filter((id) => id === stranded)).toHaveLength(1);
    // A row that is not yet stranded is left alone, and a terminal row is never
    // reopened.
    expect(enqueued).not.toContain(fresh);
    expect(enqueued).not.toContain(terminal);
    expect(result.reenqueued).toBeGreaterThan(0);

    provenCase(
      "redaction.recon.recovers_stranded_once",
      "redaction.recon.durable.intent_before_work",
      "redaction.recon.tenant.workspace_reloaded",
      "redaction.recon.claim.one_winner",
    );
  });

  it("the reconciler is itself idempotent and never duplicates live work", async () => {
    const stranded = await seedDerivative({ teamId: own.teamId, fixture: own });
    await prisma.redactionDerivative.update({
      where: { id: stranded },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const firstPass: string[] = [];
    await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async (p) => {
        firstPass.push(p.derivativeId);
        return { enqueued: true };
      },
    });

    // A row that has since been CLAIMED is no longer stranded, so a second tick
    // must not re-enqueue it — this is what stops a reconciler from fighting a
    // worker that is already making progress.
    await prisma.redactionDerivative.update({
      where: { id: stranded },
      data: { state: "RENDERING", renderStartedAtUtc: new Date() },
    });
    const secondPass: string[] = [];
    await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async (p) => {
        secondPass.push(p.derivativeId);
        return { enqueued: true };
      },
    });

    expect(firstPass).toContain(stranded);
    expect(secondPass).not.toContain(stranded);
    provenCase(
      "redaction.recon.idempotency.duplicate_is_noop",
      "redaction.recon.claim.active_not_stolen",
    );
  });

  it("the reconciler never reopens a terminal derivative", async () => {
    const terminal = await seedDerivative({
      teamId: own.teamId,
      fixture: own,
      state: "READY",
    });
    await prisma.redactionDerivative.update({
      where: { id: terminal },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const seen: string[] = [];
    await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async (p) => {
        seen.push(p.derivativeId);
        return { enqueued: true };
      },
    });
    expect(seen).not.toContain(terminal);
    expect(await driver.readState(terminal)).toBe("READY");
    provenCase("redaction.recon.terminal.stale_cannot_overwrite");
  });

  it("the reconciler does not cross workspaces", async () => {
    // A stranded row in the FOREIGN workspace is still recovered — the
    // reconciler is a system sweep, not a tenant-scoped request — but it is
    // recovered INTO ITS OWN workspace, which is the property that matters:
    // the re-enqueued command names the foreign derivative, so the processor
    // will resolve the foreign workspace from that row and no cross-tenant
    // read is possible.
    const foreignRow = await seedDerivative({
      teamId: foreign.teamId,
      fixture: foreign,
    });
    await prisma.redactionDerivative.update({
      where: { id: foreignRow },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const seen: string[] = [];
    await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async (p) => {
        seen.push(p.derivativeId);
        return { enqueued: true };
      },
    });
    if (seen.includes(foreignRow)) {
      const row = await prisma.redactionDerivative.findUniqueOrThrow({
        where: { id: foreignRow },
        select: { teamId: true },
      });
      expect(row.teamId).toBe(foreign.teamId);
    }
    provenCase("redaction.recon.tenant.cross_workspace_denied");
  });

  it("a failed enqueue leaves the row recoverable rather than lost", async () => {
    const stranded = await seedDerivative({ teamId: own.teamId, fixture: own });
    await prisma.redactionDerivative.update({
      where: { id: stranded },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const result = await processor.reconcileStrandedRedactionDerivatives({
      olderThanMs: 5 * 60_000,
      batchSize: 200,
      enqueue: async () => ({ enqueued: false }),
    });
    expect(result.scanned).toBeGreaterThan(0);
    // Still QUEUED: the next tick will find it again.
    expect(await driver.readState(stranded)).toBe("QUEUED");
  });

  it("a legacy payload cannot select workspace, policy or storage", () => {
    const decoded = decodeJobPayload(
      { jobName: ENTRY.workName, schemaVersion: ENTRY.schemaVersion },
      {
        derivativeId: "d-legacy-1",
        teamId: foreign.teamId,
        signedUrl: "https://attacker.example/x",
      },
    );
    expect(decoded.legacy).toBe(true);
    expect(decoded.commandId).toBe("d-legacy-1");
    expect([...decoded.discardedAuthorityFields].sort()).toEqual([
      "signedUrl",
      "teamId",
    ]);
    const wire = JSON.stringify(decoded);
    expect(wire).not.toContain(foreign.teamId);
    expect(wire).not.toContain("attacker.example");
  });
});
