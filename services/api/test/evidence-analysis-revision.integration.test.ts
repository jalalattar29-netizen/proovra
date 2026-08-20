/**
 * THE EVIDENCE ANALYSIS REVISION — mutations, against live PostgreSQL 16.
 *
 * Each mutation is driven through the REAL writer and the revision is then
 * recomputed from the database. A digest computed from a fixture proves only
 * that the digest works; these prove that the persisted state a route reads
 * actually changes when the product changes a record — and, just as
 * importantly, that it does NOT change when something irrelevant happens.
 *
 * WHY A DIGEST RATHER THAN A COLUMN. `Evidence.updatedAt` is a Prisma
 * `@updatedAt` timestamp on the evidence ROW. Linking or unlinking a case
 * writes `CaseEvidenceLink`, a different table, and never touches it — so a
 * record's relationship to a case can change completely while `updatedAt`
 * stands still. Cases 5 and 6 below are that failure, proven.
 *
 * The ROUTE side of the same contract — what happens when a revision matches,
 * does not match, is absent, is forged, or moves between validation and the
 * spend — lives in `case-copilot-selection-version.integration.test.ts`, where
 * it has always lived.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("evidence analysis revision — mutations (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let workspace: typeof import("../src/services/cases/matter-workspace.service.js");
  let snapshots: typeof import("../src/services/ai/evidence-analysis-snapshot.service.js");

  let teamId: string;
  let ownerUserId: string;
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

  // =========================================================================
  // PART 1 — THE MUTATION MATRIX
  //
  // Each mutation is applied to a persisted row and the revision is recomputed
  // from the database, never from a fixture.
  // =========================================================================

  describe("every mutation that can affect a Copilot moves the revision", () => {
    /**
     * `before !== after`, for a mutation applied to a real row.
     *
     * The returned pair is also checked for being well-formed revisions, so a
     * mutation that made the loader return nothing would fail as a missing
     * revision rather than passing as "they differ".
     */
    async function movesRevision(
      id: string,
      mutate: () => Promise<unknown>,
    ): Promise<{ before: string; after: string }> {
      const before = await currentRevision(id);
      expect(before, "no revision before the mutation").toBeTruthy();
      await mutate();
      const after = await currentRevision(id);
      expect(after, "no revision after the mutation").toBeTruthy();
      expect(after).not.toBe(before);
      return { before: before!, after: after! };
    }

    it("1. a title change", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { title: "Renamed.jpg" } }),
      );
    });

    it("2. an evidence KIND or MIME correction", async () => {
      const id = await linked({ mimeType: "image/jpeg" });
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { type: "VIDEO" as never } }),
      );
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { mimeType: "video/mp4" } }),
      );
    });

    it("3. a lifecycle/status change", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { status: "SIGNED" as never } }),
      );
    });

    it("4. a verification/integrity status change", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({
          where: { id },
          data: { verificationStatus: "RECORDED_INTEGRITY_VERIFIED" as never },
        }),
      );
    });

    it("5. a case link ADDED", async () => {
      // The link lives on a different table, so `Evidence.updatedAt` does not
      // move for this at all — which is precisely why a timestamp could not
      // have been the authority.
      const id = await makeEvidence();
      await link(id);
      const after = await currentRevision(id);
      expect(after).toBeTruthy();
      // Compare against the same record with the link removed again.
      await prisma.caseEvidenceLink.deleteMany({ where: { caseId, evidenceId: id } });
      const unlinked = await currentRevision(id);
      expect(unlinked).not.toBe(after);
    });

    it("6. a case link REMOVED", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.caseEvidenceLink.deleteMany({ where: { caseId, evidenceId: id } }),
      );
    });

    it("7/8. a report becoming ready, and its version changing", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { latestReportVersion: 1 } }),
      );
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { latestReportVersion: 2 } }),
      );
    });

    it("9/10. a package becoming ready, and its version changing", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({
          where: { id },
          data: { verificationPackageVersion: 1 },
        }),
      );
      await movesRevision(id, () =>
        prisma.evidence.update({
          where: { id },
          data: { verificationPackageVersion: 2 },
        }),
      );
    });

    it("11. an item/part count change", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidencePart.create({
          data: {
            evidenceId: id,
            partIndex: 0,
            // Storage coordinates are NOT NULL on this model. Supplying them
            // is the fixture obeying the schema, not working around it.
            storageBucket: "test-bucket",
            storageKey: `parts/${randomUUID()}.jpg`,
            originalFileName: `part-${randomUUID()}.jpg`,
          } as never,
        }),
      );
    });

    it("12/13. archive, then restore", async () => {
      const id = await linked();
      const archived = new Date();
      const { before } = await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { archivedAt: archived } }),
      );
      // Restoring returns it to EXACTLY the previous revision — the state is
      // the same state, so the digest is the same digest. That is what makes
      // this a revision rather than a counter.
      await prisma.evidence.update({ where: { id }, data: { archivedAt: null } });
      expect(await currentRevision(id)).toBe(before);
    });

    it("14/15. move to trash, then restore", async () => {
      const id = await linked();
      const deleted = new Date();
      const { before } = await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { deletedAt: deleted } }),
      );
      await prisma.evidence.update({ where: { id }, data: { deletedAt: null } });
      expect(await currentRevision(id)).toBe(before);
    });

    it("16. pending destruction", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({
          where: { id },
          data: { lifecycleState: "PENDING_DESTRUCTION" as never },
        }),
      );
    });

    it("17. permanent destruction — the record cannot even be snapshotted", async () => {
      const id = await linked();
      const before = await currentRevision(id);
      expect(before).toBeTruthy();
      await prisma.caseEvidenceLink.deleteMany({ where: { evidenceId: id } });
      await prisma.evidence.delete({ where: { id } });
      // Not "a different revision" — NO revision. A hard-deleted record cannot
      // remain selected, and a run naming it is refused before anything else.
      expect(await currentRevision(id)).toBeUndefined();
    });

    it("18. custody, capture method and timestamping signals", async () => {
      const id = await linked();
      await movesRevision(id, () =>
        prisma.evidence.update({
          where: { id },
          data: { captureMethod: "UPLOADED_FILE" as never },
        }),
      );
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { tsaStatus: "CONFIRMED" } }),
      );
      await movesRevision(id, () =>
        prisma.evidence.update({ where: { id }, data: { otsStatus: "PENDING" } }),
      );
    });

    it("19. an IRRELEVANT change leaves the revision alone", async () => {
      // A guard that invalidates on every write is a guard nobody can use. None
      // of these reaches a prompt or decides eligibility: `internalNotes` is in
      // no allowlist, and the access timestamps record that somebody LOOKED at
      // the record — invalidating a selection because it was viewed would
      // expire it while the operator was reading it.
      const id = await linked();
      const before = await currentRevision(id);
      await prisma.evidence.update({
        where: { id },
        data: {
          internalNotes: "an operator note that never reaches a prompt",
          lastAccessedAtUtc: new Date(),
          lastPublicVerifyViewAtUtc: new Date(),
        },
      });
      expect(await currentRevision(id)).toBe(before);
    });

    it("20. the same state always yields the same revision", async () => {
      const id = await linked({ verificationPackageVersion: 2 });
      const a = await currentRevision(id);
      const b = await currentRevision(id);
      expect(a).toBe(b);
      // …and the projection the CLIENT reads agrees with what the ROUTE
      // recomputes. A disagreement there is the original defect exactly.
      const item = (await projected()).find((i) => i.id === id);
      expect(item?.analysisRevision).toBe(a);
    });
  });

});
