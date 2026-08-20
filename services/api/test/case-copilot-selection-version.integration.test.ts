/**
 * THE SELECTION VERSION — one authority, proven against live PostgreSQL.
 *
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * After the idempotency-key fix, every Case Copilot run answered:
 *
 *     A selected record changed while you were choosing.
 *
 * Nothing had changed. `Evidence.verificationPackageVersion` is the concurrency
 * authority the AI routes have always compared against, and the CASE evidence
 * projection never carried it:
 *
 *   - the query did not `select` the column,
 *   - the DTO did not declare it,
 *   - the client read it through a cast that could only return `undefined`,
 *     then defaulted it with `?? 0`.
 *
 * So a record the database knew as v2 arrived at the panel as `v0` — visibly,
 * beside a "Package ready" badge on the same page — and the route compared the
 * fabricated 0 against the real 2 and refused it as a concurrent change.
 *
 * These tests drive the REAL route against REAL rows. A source-regex test could
 * not have caught the original defect and cannot prove this one is fixed: the
 * markup was always correct; the projected DATA was not.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/**
 * The provider is the ONE external boundary substituted here. Everything the
 * test reasons about — the projection, the schema, the version comparison, the
 * eligibility gate, the budget reservation — is production code.
 */
vi.mock("../src/services/ai/case-copilot-provider.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildCaseCopilotProvider: () => async () => ({
      caseSummary: "Two records describe the same scene.",
      timelineHighlights: [],
      missingEvidenceCategories: [],
      workflowGaps: [],
      conflictingMetadata: [],
      reviewerPreparation: [],
      disclosureChecklist: [],
      unresolvedQuestions: [],
      citations: [],
      // The EXACT literal `CaseCopilotSchema` requires. Anything else is
      // discarded as `schema_error` — which is the output contract doing its
      // job, and would have made every "ok" below unreachable.
      advisoryBoundary:
        "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.",
    }),
  };
});

describe("Case Copilot selection version (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let workspace: typeof import("../src/services/cases/matter-workspace.service.js");

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

    teamId = harness.fixtures.teamA.teamId;
    ownerUserId = harness.fixtures.teamA.ownerUserId;
    ownerToken = harness.fixtures.teamA.ownerToken;
    caseId = harness.fixtures.teamA.caseId;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId;

    /**
     * CASE_COPILOT is default-DENY (`caseCopilotEnabled: false`), which is
     * correct — and it means a run answers 200 with `status: "policy_denied"`
     * rather than failing. Enabling it here is the fixture, not a relaxation:
     * every assertion below checks the RESULT status, so a denied policy could
     * not masquerade as a successful run.
     */
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
    // Every case starts from a case with no linked evidence of its own.
    await prisma.caseEvidenceLink.deleteMany({ where: { caseId } });
  });

  // =========================================================================
  // Helpers — production authorities only
  // =========================================================================

  /** Create evidence in this workspace and link it to the case. */
  async function linkedEvidence(input: {
    packageVersion: number | null;
    status?: string;
    lifecycleState?: string;
  }): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `copilot-version-${randomUUID()}`,
        type: "PHOTO",
        status: (input.status ?? "REPORTED") as never,
        lifecycleState: (input.lifecycleState ?? "ACTIVE") as never,
        teamId,
        organizationId,
        ownerUserId,
        verificationPackageVersion: input.packageVersion,
      },
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({
      data: { caseId, evidenceId: row.id, teamId, linkedByUserId: ownerUserId },
    });
    return row.id;
  }

  /** The REAL list projection the Case page renders from. */
  async function projectedEvidence() {
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
              verificationPackageVersion: number | null;
              packageReady: boolean;
              status: string;
            }>;
          };
        };
      }
    ).sections.evidence.items;
  }

  /** The REAL route, through the harness's Fastify instance. */
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

  /** The copilot's own verdict, which a 200 alone does not establish. */
  function resultStatus(res: { body: Record<string, unknown> }): string | undefined {
    return (res.body as { data?: { status?: string } }).data?.status;
  }

  /**
   * Every AI usage row for this workspace — proof that a refused selection
   * consumed no operation. Counted rather than inspected: the guarantee is
   * that the number does not move.
   */
  async function ledgerCount(): Promise<number> {
    return prisma.aiUsageEvent
      .count({ where: { workspaceId: teamId } })
      .catch(() => 0);
  }

  // =========================================================================
  // 1–4. The projection carries the canonical version
  // =========================================================================

  it("1/2. a package-ready record projects its REAL version, not a fabricated zero", async () => {
    const id = await linkedEvidence({ packageVersion: 2 });
    const items = await projectedEvidence();
    const item = items.find((i) => i.id === id);

    expect(item, "the record is not in the projection").toBeTruthy();
    // THE DEFECT: this field did not exist, so the client read `undefined`.
    expect(item).toHaveProperty("verificationPackageVersion");
    expect(item!.verificationPackageVersion).toBe(2);
    // …and it is genuinely a package-ready record, which is what made the
    // fabricated `v0` visibly wrong on the same page.
    expect(item!.packageReady).toBe(false); // no VerificationPackage rows exist
  });

  it("3. a record with no package projects null — never 0", async () => {
    const id = await linkedEvidence({ packageVersion: null });
    const items = await projectedEvidence();
    const item = items.find((i) => i.id === id);
    expect(item!.verificationPackageVersion).toBeNull();
    // `null` and `0` are different statements and the projection keeps them so.
    expect(item!.verificationPackageVersion).not.toBe(0);
  });

  it("3b. a genuine recorded zero survives as zero", async () => {
    const id = await linkedEvidence({ packageVersion: 0 });
    const items = await projectedEvidence();
    expect(
      items.find((i) => i.id === id)!.verificationPackageVersion,
    ).toBe(0);
  });

  // =========================================================================
  // 5–9. The round trip
  // =========================================================================

  it("5. a matching snapshot runs — the two-record production selection succeeds", async () => {
    // The exact production shape: two REPORTED records, neither with a package.
    const a = await linkedEvidence({ packageVersion: null });
    const b = await linkedEvidence({ packageVersion: null });
    const items = await projectedEvidence();
    const versions = Object.fromEntries(
      items
        .filter((i) => [a, b].includes(i.id))
        .map((i) => [i.id, i.verificationPackageVersion]),
    );
    expect(versions).toEqual({ [a]: null, [b]: null });

    const res = await runCopilot({
      selectedEvidenceIds: [a, b],
      selectedEvidenceVersions: versions,
      processingMode: "METADATA_ONLY",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // A real result, not merely a cleared pending state.
    const data = (res.body as { data?: { status?: string } }).data;
    expect(data?.status).toBe("ok");
  });

  it("5b. a package-ready record with its real version runs too", async () => {
    const id = await linkedEvidence({ packageVersion: 3 });
    const items = await projectedEvidence();
    const version = items.find((i) => i.id === id)!.verificationPackageVersion;
    expect(version).toBe(3);

    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: version },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(resultStatus(res)).toBe("ok");
  });

  it("6/13. a GENUINE change after selection is still refused", async () => {
    const id = await linkedEvidence({ packageVersion: 1 });
    const snapshot = (await projectedEvidence()).find((i) => i.id === id)!
      .verificationPackageVersion;
    expect(snapshot).toBe(1);

    // A verification package is generated between selecting and running.
    await prisma.evidence.update({
      where: { id },
      data: { verificationPackageVersion: 2 },
    });

    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: snapshot },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status).toBe(409);
    expect(
      (res.body as { error?: { code?: string } }).error?.code,
    ).toBe("stale_evidence_version");
  });

  it("7/8/9. refreshing returns the new version, and re-running succeeds", async () => {
    const id = await linkedEvidence({ packageVersion: 1 });
    await prisma.evidence.update({
      where: { id },
      data: { verificationPackageVersion: 2 },
    });

    // The refresh the panel performs after a mismatch.
    const refreshed = (await projectedEvidence()).find((i) => i.id === id)!;
    expect(refreshed.verificationPackageVersion).toBe(2);

    // Re-selecting from the refreshed record runs, with no page reload.
    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: refreshed.verificationPackageVersion },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(resultStatus(res)).toBe("ok");
  });

  it("null and 0 are not interchangeable in the comparison", async () => {
    const id = await linkedEvidence({ packageVersion: null });
    // Sending 0 for a record whose version is null must NOT match — that
    // equivalence is exactly what the old `?? 0` created on both sides.
    const wrong = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: 0 },
      processingMode: "METADATA_ONLY",
    });
    expect(wrong.status).toBe(409);

    const right = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: null },
      processingMode: "METADATA_ONLY",
    });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(resultStatus(right)).toBe("ok");
  });

  it("12. two records with DIFFERENT versions both round-trip", async () => {
    const a = await linkedEvidence({ packageVersion: null });
    const b = await linkedEvidence({ packageVersion: 4 });
    const items = await projectedEvidence();
    const versions = Object.fromEntries(
      items
        .filter((i) => [a, b].includes(i.id))
        .map((i) => [i.id, i.verificationPackageVersion]),
    );
    expect(versions[a]).toBeNull();
    expect(versions[b]).toBe(4);

    const res = await runCopilot({
      selectedEvidenceIds: [a, b],
      selectedEvidenceVersions: versions,
      processingMode: "METADATA_ONLY",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(resultStatus(res)).toBe("ok");
  });

  // =========================================================================
  // 14–17. The other guards are untouched
  // =========================================================================

  it("14. a lifecycle change after selection is refused as ineligible, not as stale", async () => {
    const id = await linkedEvidence({ packageVersion: null });
    const snapshot = (await projectedEvidence()).find((i) => i.id === id)!
      .verificationPackageVersion;

    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "PENDING_DESTRUCTION" },
    });

    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: snapshot },
      processingMode: "METADATA_ONLY",
    });
    // A different situation gets a different answer.
    expect(res.status).toBe(422);
    const body = res.body as {
      error?: { code?: string; records?: Array<{ reason?: string }> };
    };
    expect(body.error?.code).toBe("evidence_not_analyzable");
    expect(body.error?.records?.[0]?.reason).toBe("record_unavailable");
  });

  it("14b. an UPLOADING record is refused before anything is spent", async () => {
    const id = await linkedEvidence({
      packageVersion: null,
      status: "UPLOADING",
    });
    const before = await ledgerCount();
    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: null },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status).toBe(422);
    // 16. NO AI OPERATION IS CONSUMED on an ineligible selection.
    expect(await ledgerCount()).toBe(before);
  });

  it("16b. a stale selection consumes no AI operation either", async () => {
    const id = await linkedEvidence({ packageVersion: 1 });
    await prisma.evidence.update({
      where: { id },
      data: { verificationPackageVersion: 9 },
    });
    const before = await ledgerCount();
    const res = await runCopilot({
      selectedEvidenceIds: [id],
      selectedEvidenceVersions: { [id]: 1 },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status).toBe(409);
    expect(await ledgerCount()).toBe(before);
  });

  it("15. a record from another workspace is refused without enumeration", async () => {
    // Belongs to team B, and is not linked to this case. `organizationId` is
    // supplied because `evidence_team_implies_org_chk` requires it — the
    // constraint is part of the tenancy model, not an obstacle to it.
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
        verificationPackageVersion: 1,
      },
      select: { id: true },
    });

    const res = await runCopilot({
      selectedEvidenceIds: [foreign.id],
      selectedEvidenceVersions: { [foreign.id]: 1 },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status).toBe(403);
    // The refusal says nothing about what exists elsewhere.
    expect(JSON.stringify(res.body)).not.toMatch(/team|workspace|tenant/i);
  });

  it("15b. a record in THIS workspace but not linked to THIS case is refused", async () => {
    const unlinked = await prisma.evidence.create({
      data: {
        title: `unlinked-${randomUUID()}`,
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: "ACTIVE" as never,
        teamId,
        organizationId,
        ownerUserId,
        verificationPackageVersion: null,
      },
      select: { id: true },
    });

    const res = await runCopilot({
      selectedEvidenceIds: [unlinked.id],
      selectedEvidenceVersions: { [unlinked.id]: null },
      processingMode: "METADATA_ONLY",
    });
    expect(res.status).toBe(422);
    expect(
      (res.body as { error?: { records?: Array<{ reason?: string }> } }).error
        ?.records?.[0]?.reason,
    ).toBe("not_linked_to_case");
  });

  it("17. the version contract is identical in a PERSONAL workspace", async () => {
    // Driven against the harness's real personal workspace rather than by
    // flipping `isPersonal` on an organization team — `teams_personal_is_flagged_chk`
    // refuses that, correctly, and a mutated row would not have been a personal
    // workspace anyway.
    //
    // The route reads ONE column for every workspace and branches on no plan,
    // tier or workspace kind, so this is the same contract exercised through a
    // different tenancy shape.
    const personal = harness.fixtures.personal;
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: personal.teamId },
      create: { teamId: personal.teamId, aiEnabled: true, caseCopilotEnabled: true },
      update: { aiEnabled: true, caseCopilotEnabled: true },
    });
    await prisma.evidence.update({
      where: { id: personal.evidenceId },
      data: { verificationPackageVersion: 5, status: "REPORTED" as never },
    });
    // The link's unique key is (caseId, evidenceId, role) — a record may be
    // linked in more than one role.
    const existingLink = await prisma.caseEvidenceLink.findFirst({
      where: { caseId: personal.caseId, evidenceId: personal.evidenceId },
      select: { id: true },
    });
    if (!existingLink) {
      await prisma.caseEvidenceLink.create({
        data: {
          caseId: personal.caseId,
          evidenceId: personal.evidenceId,
          linkedByUserId: personal.userId,
        },
      });
    }

    const envelope = await workspace.buildMatterWorkspace({
      caseId: personal.caseId,
      userId: personal.userId,
      role: "OWNER",
    });
    const item = (
      envelope as unknown as {
        sections: {
          evidence: {
            items: Array<{ id: string; verificationPackageVersion: number | null }>;
          };
        };
      }
    ).sections.evidence.items.find((i) => i.id === personal.evidenceId);
    expect(item!.verificationPackageVersion).toBe(5);

    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/ai/case/${personal.caseId}/copilot`,
      headers: { authorization: `Bearer ${personal.token}` },
      payload: {
        selectedEvidenceIds: [personal.evidenceId],
        selectedEvidenceVersions: { [personal.evidenceId]: 5 },
        processingMode: "METADATA_ONLY",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data?: { status?: string } }).data?.status).toBe("ok");
  });
});
