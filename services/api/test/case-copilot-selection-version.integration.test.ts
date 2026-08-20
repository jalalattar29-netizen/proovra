/**
 * THE CASE COPILOT'S CONCURRENCY GUARD — driven against live PostgreSQL 16.
 *
 * WHAT THIS FILE PROVED, AND WHY ITS SUBJECT WIDENED
 * ---------------------------------------------------------------------------
 * It began as proof that the CASE projection carried
 * `Evidence.verificationPackageVersion` and that both sides compared it as a
 * nullable value rather than through `?? 0`. Every Case Copilot run had been
 * answering "a selected record changed while you were choosing" when nothing
 * had changed: the projection never emitted the column, the client read
 * `undefined` through a cast and defaulted it to `0`, and the route compared
 * that fabricated 0 against a real 2.
 *
 * That contract was true and INSUFFICIENT. The fields a Copilot is actually
 * shown are fixed by the two context allowlists, and their union is fourteen —
 * of which exactly ONE moves the package version. Renaming a record,
 * correcting its MIME type, completing its integrity check, unlinking it from
 * the case, publishing a report, adding a part, archiving it or sending it to
 * trash all changed what the model would be told while the guard reported no
 * change whatsoever.
 *
 * So the subject widened from a package VERSION to an opaque analysis
 * REVISION, and these tests widened with it. The file keeps its path: the
 * coverage was superseded IN PLACE rather than deleted, because a deleted
 * behaviour test and lost coverage look identical from the outside.
 *
 * The MUTATION side — proving the revision actually moves when the product
 * changes a record — is in `evidence-analysis-revision.integration.test.ts`.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/**
 * The provider is the ONE external boundary substituted here. Everything the
 * test reasons about — the projection, the schema, the revision computation,
 * the eligibility gate, the budget reservation, the TOCTOU re-check — is
 * production code.
 */
const ADVISORY =
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";

let providerCalls = 0;

vi.mock("../src/services/ai/case-copilot-provider.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildCaseCopilotProvider: () => async () => {
      providerCalls += 1;
      return {
        caseSummary: "Two records describe the same scene.",
        timelineHighlights: [],
        missingEvidenceCategories: [],
        workflowGaps: [],
        conflictingMetadata: [],
        reviewerPreparation: [],
        disclosureChecklist: [],
        unresolvedQuestions: [],
        citations: [],
        advisoryBoundary: ADVISORY,
      };
    },
  };
});

describe("Case Copilot concurrency guard (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let workspace: typeof import("../src/services/cases/matter-workspace.service.js");
  let snapshots: typeof import("../src/services/ai/evidence-analysis-snapshot.service.js");

  let teamId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let organizationId: string | null;
  let caseId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    workspace = await import("../src/services/cases/matter-workspace.service.js");
    snapshots = await import("../src/services/ai/evidence-analysis-snapshot.service.js");

    teamId = harness.fixtures.teamA.teamId;
    ownerUserId = harness.fixtures.teamA.ownerUserId;
    ownerToken = harness.fixtures.teamA.ownerToken;
    caseId = harness.fixtures.teamA.caseId;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId;

    // CASE_COPILOT is default-DENY, which is correct — and means a run answers
    // 200 with `status: "policy_denied"` rather than failing. Enabling it is
    // the fixture, not a relaxation: every success assertion below checks the
    // RESULT status, so a denied policy could not masquerade as a run.
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId },
      create: { teamId, aiEnabled: true, caseCopilotEnabled: true },
      update: { aiEnabled: true, caseCopilotEnabled: true },
    });
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await prisma.caseEvidenceLink.deleteMany({ where: { caseId } });
    providerCalls = 0;
  });

  // =========================================================================
  // Helpers — production authorities only
  // =========================================================================

  async function makeEvidence(
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `revision-${randomUUID()}`,
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: "ACTIVE" as never,
        teamId,
        organizationId,
        ownerUserId,
        ...over,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function link(evidenceId: string): Promise<void> {
    await prisma.caseEvidenceLink.create({
      data: { caseId, evidenceId, teamId, linkedByUserId: ownerUserId },
    });
  }

  async function linked(over: Record<string, unknown> = {}): Promise<string> {
    const id = await makeEvidence(over);
    await link(id);
    return id;
  }

  /** The REAL list projection the Case page renders from. */
  async function projected(): Promise<
    Array<{
      id: string;
      analysisRevision: string;
      verificationPackageVersion: number | null;
      status: string;
    }>
  > {
    const envelope = await workspace.buildMatterWorkspace({
      caseId,
      userId: ownerUserId,
      role: "OWNER",
    });
    return (
      envelope as unknown as {
        sections: {
          evidence: {
            items: Array<{
              id: string;
              analysisRevision: string;
              verificationPackageVersion: number | null;
              status: string;
            }>;
          };
        };
      }
    ).sections.evidence.items;
  }

  /** The revision as the ROUTE would recompute it, for one record. */
  async function currentRevision(id: string): Promise<string | undefined> {
    const [snap] = await snapshots.loadEvidenceAnalysisSnapshots({
      ids: [id],
      teamId,
      scope: { scope: "case", scopeId: caseId },
    });
    return snap?.revision;
  }

  async function runCopilot(
    body: Record<string, unknown>,
    token = ownerToken,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/ai/case/${caseId}/copilot`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = res.json() as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: res.statusCode, body: parsed };
  }

  /** Run with each record's CURRENT revision — the healthy path. */
  async function runCurrent(
    ids: string[],
    over: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const revisions: Record<string, string> = {};
    for (const id of ids) {
      const r = await currentRevision(id);
      if (r) revisions[id] = r;
    }
    return runCopilot({
      selectedEvidenceIds: ids,
      selectedEvidenceRevisions: revisions,
      processingMode: "METADATA_ONLY",
      ...over,
    });
  }

  function resultStatus(res: { body: Record<string, unknown> }): string | undefined {
    return (res.body as { data?: { status?: string } }).data?.status;
  }

  function errorCode(res: { body: Record<string, unknown> }): string | undefined {
    return (res.body as { error?: { code?: string } }).error?.code;
  }

  /** Every AI usage row for this workspace — proof that nothing was spent. */
  async function ledgerCount(): Promise<number> {
    return prisma.aiUsageEvent.count({ where: { workspaceId: teamId } }).catch(() => 0);
  }

  // =========================================================================
  // PART 2 — THE CONCURRENCY MATRIX
  // =========================================================================

  describe("the route enforces the revision", () => {
    it("1. one eligible record with a current revision runs", async () => {
      const id = await linked();
      const res = await runCurrent([id]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(resultStatus(res)).toBe("ok");
    });

    it("2. two eligible PHOTO/VIDEO records run — the production selection", async () => {
      const a = await linked();
      const b = await linked({ type: "VIDEO" as never, verificationPackageVersion: 3 });
      const res = await runCurrent([a, b]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(resultStatus(res)).toBe("ok");
    });

    it("3. the maximum selection is accepted", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i += 1) ids.push(await linked());
      const res = await runCurrent(ids);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(resultStatus(res)).toBe("ok");
    });

    it("4. selection ORDER is irrelevant — the same operation, not two", async () => {
      const { buildCopilotIdempotencyKey } = await import("@proovra/shared");
      const a = await linked();
      const b = await linked();
      const revA = (await currentRevision(a))!;
      const revB = (await currentRevision(b))!;
      const revisions = { [a]: revA, [b]: revB };

      // Order-independent by construction: the ids are sorted and each
      // travels with its own revision.
      const forwardKey = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: [a, b],
        revisions,
        mode: "METADATA_ONLY",
      });
      const reverseKey = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: [b, a],
        revisions,
        mode: "METADATA_ONLY",
      });
      expect(reverseKey).toBe(forwardKey);

      const forward = await runCurrent([a, b]);
      expect(resultStatus(forward)).toBe("ok");

      // …and because it IS the same operation, the second submission is
      // de-duplicated rather than run and billed again. That is the guard
      // working, not a failure: clicking Run twice must not cost twice.
      const callsAfterFirst = providerCalls;
      const reverse = await runCurrent([b, a]);
      expect(reverse.status).toBe(429);
      expect(providerCalls).toBe(callsAfterFirst);
    });

    it("5/6. the same snapshot reuses an identity; changed metadata does not", async () => {
      const { buildCopilotIdempotencyKey } = await import("@proovra/shared");
      const id = await linked();
      const first = (await currentRevision(id))!;
      const keyA = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: [id],
        revisions: { [id]: first },
        mode: "METADATA_ONLY",
      });
      const keyRetry = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: [id],
        revisions: { [id]: first },
        mode: "METADATA_ONLY",
      });
      expect(keyRetry).toBe(keyA);

      await prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } });
      const second = (await currentRevision(id))!;
      expect(second).not.toBe(first);
      const keyB = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: caseId,
        selection: [id],
        revisions: { [id]: second },
        mode: "METADATA_ONLY",
      });
      // THE GUARANTEE: a persisted result keyed by `keyA` can never be returned
      // for the request the operator is now making.
      expect(keyB).not.toBe(keyA);
    });

    it("7. a genuinely stale revision is refused", async () => {
      const id = await linked();
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { title: "Changed.jpg" } });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("stale_evidence_revision");
    });

    it("8. a MISSING revision fails closed", async () => {
      const id = await linked();
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: {},
        processingMode: "METADATA_ONLY",
      });
      // Not "permitted because unstated". Not knowing is not agreement.
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("stale_evidence_revision");
    });

    it("9. a package version is not a revision, and zero is not a revision", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      for (const forged of ["2", "0", "", "null"]) {
        const res = await runCopilot({
          selectedEvidenceIds: [id],
          selectedEvidenceRevisions: { [id]: forged },
          processingMode: "METADATA_ONLY",
        });
        expect(res.status, `accepted ${JSON.stringify(forged)}`).toBe(409);
      }
    });

    it("10. a FORGED but well-formed revision is refused", async () => {
      const id = await linked();
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: `ear1_${"A".repeat(43)}` },
        processingMode: "METADATA_ONLY",
      });
      // Shape is not authority. The server recomputes from persisted state.
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("stale_evidence_revision");
    });

    it("10b. another record's CURRENT revision cannot be replayed onto this one", async () => {
      const a = await linked();
      const b = await linked();
      const revB = (await currentRevision(b))!;
      const res = await runCopilot({
        selectedEvidenceIds: [a],
        selectedEvidenceRevisions: { [a]: revB },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
    });

    it("11. a package version change alone is caught", async () => {
      const id = await linked({ verificationPackageVersion: 1 });
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({
        where: { id },
        data: { verificationPackageVersion: 2 },
      });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
    });

    /**
     * 12–15. THE CASES THE OLD AUTHORITY COULD NOT SEE.
     *
     * Every one of these leaves `verificationPackageVersion` untouched, so the
     * previous guard reported "no change" while the prompt the model would be
     * given had changed.
     */
    it("12. a TITLE change with no package version change is caught", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      const stale = (await currentRevision(id))!;
      const before = await prisma.evidence.findUniqueOrThrow({
        where: { id },
        select: { verificationPackageVersion: true },
      });
      await prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } });
      const after = await prisma.evidence.findUniqueOrThrow({
        where: { id },
        select: { verificationPackageVersion: true },
      });
      expect(after.verificationPackageVersion).toBe(before.verificationPackageVersion);

      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
    });

    it("13. a STATUS change with no package version change is caught", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { status: "SIGNED" as never } });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
    });

    it("14. a case UNLINK with no package version change is caught", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      const stale = (await currentRevision(id))!;
      await prisma.caseEvidenceLink.deleteMany({ where: { caseId, evidenceId: id } });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      // Refused as INELIGIBLE — no longer part of this case's population — which
      // is a more useful answer than "stale", and is checked first.
      expect([409, 422]).toContain(res.status);
      expect(providerCalls).toBe(0);
    });

    it("15. a REPORT becoming ready with no package version change is caught", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { latestReportVersion: 1 } });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
    });

    it("16/17. refreshing returns the NEW revision, and re-running succeeds", async () => {
      const id = await linked();
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } });

      const refused = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(refused.status).toBe(409);

      // REFRESH — through the same projection the page re-renders from.
      const item = (await projected()).find((i) => i.id === id);
      expect(item?.analysisRevision).toBeTruthy();
      expect(item!.analysisRevision).not.toBe(stale);

      const retry = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: item!.analysisRevision },
        processingMode: "METADATA_ONLY",
      });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(resultStatus(retry)).toBe("ok");
    });

    it("18/19. a mismatch spends NO budget and calls NO provider", async () => {
      const id = await linked();
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } });

      const before = await ledgerCount();
      providerCalls = 0;
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(409);
      expect(providerCalls).toBe(0);
      expect(await ledgerCount()).toBe(before);
    });

    it("20. a cross-workspace record is refused WITHOUT enumerating it", async () => {
      const teamB = await prisma.team.findUniqueOrThrow({
        where: { id: harness.fixtures.teamB.teamId },
        select: { organizationId: true },
      });
      const foreign = await prisma.evidence.create({
        data: {
          title: `foreign-${randomUUID()}`,
          type: "PHOTO",
          status: "REPORTED" as never,
          lifecycleState: "ACTIVE" as never,
          teamId: harness.fixtures.teamB.teamId,
          organizationId: teamB.organizationId,
          ownerUserId: harness.fixtures.teamB.ownerUserId,
        },
        select: { id: true },
      });
      const res = await runCopilot({
        selectedEvidenceIds: [foreign.id],
        selectedEvidenceRevisions: { [foreign.id]: `ear1_${"A".repeat(43)}` },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(403);
      // The response says nothing about whether the id exists.
      expect(JSON.stringify(res.body)).not.toContain(foreign.id);
      expect(errorCode(res)).toBe("unauthorized_or_missing_evidence");
    });

    it("21. a record in THIS workspace but not linked to THIS case is refused", async () => {
      const id = await makeEvidence();
      const res = await runCurrent([id]);
      expect(res.status).toBe(422);
      expect(errorCode(res)).toBe("evidence_not_analyzable");
      expect(providerCalls).toBe(0);
    });

    it("22. an AI-disabled workspace refuses without analyzing", async () => {
      const id = await linked();
      await prisma.workspaceAiPolicy.update({
        where: { teamId },
        data: { aiEnabled: false },
      });
      try {
        const res = await runCurrent([id]);
        expect(res.status).toBe(200);
        expect(resultStatus(res)).toBe("policy_denied");
        expect(providerCalls).toBe(0);
      } finally {
        await prisma.workspaceAiPolicy.update({
          where: { teamId },
          data: { aiEnabled: true, caseCopilotEnabled: true },
        });
      }
    });

    it("23. a missing CAPABILITY projection fails closed", async () => {
      const id = await linked();
      await prisma.workspaceAiPolicy.update({
        where: { teamId },
        data: { caseCopilotEnabled: false },
      });
      try {
        const res = await runCurrent([id]);
        expect(resultStatus(res)).toBe("policy_denied");
        expect(providerCalls).toBe(0);
      } finally {
        await prisma.workspaceAiPolicy.update({
          where: { teamId },
          data: { caseCopilotEnabled: true },
        });
      }
    });

    it("24. TOCTOU — a change after validation cannot reach the provider", async () => {
      // The frozen snapshot covers validation through the budget reservation.
      // This proves the remaining window is closed: the route re-reads and
      // recomputes immediately before the spend.
      const id = await linked();
      const current = (await currentRevision(id))!;

      // Commit a change DURING the request, from outside it.
      const inflight = runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: current },
        processingMode: "METADATA_ONLY",
      });
      await prisma.evidence.update({
        where: { id },
        data: { title: `raced-${randomUUID()}` },
      });
      const res = await inflight;

      // Either the route saw the change at validation (409) or the TOCTOU
      // re-check caught it before the spend (409). What must NEVER happen is a
      // successful run whose prompt was built from state that is no longer
      // true — and the drift check is what makes that unreachable.
      if (res.status === 200) {
        // The write landed after the re-check: the run is grounded in the exact
        // snapshot that was accepted, which is the guarantee. Prove the drift
        // detector itself is live rather than trivially passing.
        const drifted = await snapshots.findDriftedSnapshot({
          snapshots: [
            {
              row: { id } as never,
              revision: current,
              linkedToScope: true,
            },
          ],
          teamId,
          scope: { scope: "case", scopeId: caseId },
        });
        expect(drifted).toBe(id);
      } else {
        expect(res.status).toBe(409);
      }
    });

    it("25. the contract is identical in a PERSONAL workspace", async () => {
      const personal = harness.fixtures.personal;
      await prisma.workspaceAiPolicy.upsert({
        where: { teamId: personal.teamId },
        create: { teamId: personal.teamId, aiEnabled: true, caseCopilotEnabled: true },
        update: { aiEnabled: true, caseCopilotEnabled: true },
      });
      await prisma.evidence.update({
        where: { id: personal.evidenceId },
        data: { status: "REPORTED" as never, verificationPackageVersion: 5 },
      });
      await prisma.caseEvidenceLink.upsert({
        where: {
          caseId_evidenceId_role: {
            caseId: personal.caseId,
            evidenceId: personal.evidenceId,
            role: "SUPPORTING",
          },
        },
        create: {
          caseId: personal.caseId,
          evidenceId: personal.evidenceId,
          linkedByUserId: personal.userId,
        },
        update: {},
      });

      const [snap] = await snapshots.loadEvidenceAnalysisSnapshots({
        ids: [personal.evidenceId],
        teamId: personal.teamId,
        scope: { scope: "case", scopeId: personal.caseId },
      });
      expect(snap?.revision).toBeTruthy();

      const res = await harness.app.inject({
        method: "POST",
        url: `/v1/ai/case/${personal.caseId}/copilot`,
        headers: { authorization: `Bearer ${personal.token}` },
        payload: {
          selectedEvidenceIds: [personal.evidenceId],
          selectedEvidenceRevisions: { [personal.evidenceId]: snap!.revision },
          processingMode: "METADATA_ONLY",
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { data?: { status?: string } }).data?.status).toBe("ok");
    });

    it("26. a hard-deleted record cannot be analyzed", async () => {
      const id = await linked();
      const revision = (await currentRevision(id))!;
      await prisma.caseEvidenceLink.deleteMany({ where: { evidenceId: id } });
      await prisma.evidence.delete({ where: { id } });
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: revision },
        processingMode: "METADATA_ONLY",
      });
      expect(res.status).toBe(403);
      expect(providerCalls).toBe(0);
    });

    it("27. an INELIGIBLE record is refused before the revision is even consulted", async () => {
      // Order matters: "still uploading" is a more useful answer than "stale",
      // and it costs nothing to give.
      const id = await linked({ status: "UPLOADING" as never });
      const res = await runCurrent([id]);
      expect(res.status).toBe(422);
      expect(errorCode(res)).toBe("evidence_not_analyzable");
      expect(providerCalls).toBe(0);
    });

    it("28. a trashed record is refused rather than analyzed", async () => {
      const id = await linked();
      await prisma.evidence.update({ where: { id }, data: { deletedAt: new Date() } });
      const res = await runCurrent([id]);
      expect([409, 422]).toContain(res.status);
      expect(providerCalls).toBe(0);
    });

    it("29. provider, schema and policy failures stay distinct from staleness", async () => {
      // A stale selection is a 409 with its own code. A policy refusal is a 200
      // with a status. They are never reported as one another — which is what
      // "Invalid selection." did to a key-length problem.
      const id = await linked();
      const stale = (await currentRevision(id))!;
      await prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } });
      const staleRes = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: stale },
        processingMode: "METADATA_ONLY",
      });
      expect(staleRes.status).toBe(409);
      expect(errorCode(staleRes)).toBe("stale_evidence_revision");

      await prisma.workspaceAiPolicy.update({
        where: { teamId },
        data: { aiEnabled: false },
      });
      try {
        const policyRes = await runCurrent([id]);
        expect(policyRes.status).toBe(200);
        expect(resultStatus(policyRes)).toBe("policy_denied");
        expect(errorCode(policyRes)).toBeUndefined();
      } finally {
        await prisma.workspaceAiPolicy.update({
          where: { teamId },
          data: { aiEnabled: true, caseCopilotEnabled: true },
        });
      }
    });

    it("30. no refusal leaks a table, a column or a mechanism", async () => {
      const id = await linked();
      const res = await runCopilot({
        selectedEvidenceIds: [id],
        selectedEvidenceRevisions: { [id]: `ear1_${"A".repeat(43)}` },
        processingMode: "METADATA_ONLY",
      });
      const text = JSON.stringify(res.body);
      for (const leak of [
        "verification_package_version",
        "prisma",
        "SELECT",
        "case_evidence_links",
        "teamId",
        "sha256",
      ]) {
        expect(text, `refusal leaked ${leak}`).not.toContain(leak);
      }
    });
  });
});
