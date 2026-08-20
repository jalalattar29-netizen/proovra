/**
 * The Search lifecycle policy, against real PostgreSQL and the real indexer.
 *
 * WHAT THE POLICY IS
 * ---------------------------------------------------------------------------
 * Trash and Archive stay SEARCHABLE and are TAGGED. A user has to be able to
 * find a record in order to restore it, and hiding a record they still own
 * makes the product look like it lost their data. Only the two terminal
 * lifecycle states — DESTROYED and PENDING_DESTRUCTION — and rows that are
 * physically gone leave the index, because governance decided those records no
 * longer exist and Search must stop answering for them.
 *
 * WHY THIS SUITE IS SEPARATE FROM THE UNIT ONE
 * ---------------------------------------------------------------------------
 * `services/worker/test/search-index-lifecycle-transitions.test.ts` proves the
 * two scan directions agree on ONE eligibility clause, cheaply, by evaluating
 * the real emitted SQL against an in-memory fixture. That is a good test of the
 * predicate and a poor test of the policy: its sweep is a re-implementation, so
 * it cannot observe transaction behaviour, the real upsert key, or what a
 * SEARCH actually returns afterwards.
 *
 * Everything here drives production code against a real database: the real
 * `indexEvidence`, the real `sweepIneligibleDocuments`, the real reconciler and
 * the real `GET /v1/search` route.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Search lifecycle transitions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let indexing: typeof import("../src/services/search/evidence-indexing.service.js");
  let workerRecon: typeof import("../../worker/src/search-index-reconciler.js");

  let A: { teamId: string; ownerUserId: string; ownerToken: string; organizationId: string | null };
  let B: { teamId: string; ownerUserId: string; ownerToken: string; organizationId: string | null };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);

    indexing = await import("../src/services/search/evidence-indexing.service.js");
    workerRecon = await import("../../worker/src/search-index-reconciler.js");

    const teamA = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    const teamB = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamB.teamId },
      select: { organizationId: true },
    });

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      organizationId: teamA.organizationId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      ownerToken: harness.fixtures.teamB.ownerToken,
      organizationId: teamB.organizationId,
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Create one evidence row and index it through the REAL indexer. */
  async function createIndexed(
    workspace: typeof A,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidence.create({
      data: {
        title: `lifecycle-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: workspace.teamId,
        organizationId: workspace.organizationId,
        ownerUserId: workspace.ownerUserId,
        lifecycleState: "ACTIVE",
        ...overrides,
      },
      select: { id: true },
    });
    const result = await indexing.indexEvidence({
      teamId: workspace.teamId,
      evidenceId: row.id,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return row.id;
  }

  async function documentFor(teamId: string, sourceId: string) {
    return prisma.evidenceSearchDocument.findFirst({
      where: { teamId, documentType: "EVIDENCE", sourceId },
    });
  }

  function tagsOf(doc: { searchableTagsJson: unknown } | null): string[] {
    const raw = doc?.searchableTagsJson;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }

  /** The REAL search route, as an authorized user of that workspace. */
  async function search(
    workspace: typeof A,
    q: string,
  ): Promise<Array<{ documentId: string; evidenceId: string | null }>> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${workspace.teamId}&q=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${workspace.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { rows: Array<{ documentId: string; evidenceId: string | null }> }).rows;
  }

  /** One real sweep tick, scoped to one workspace. */
  const sweep = (teamId: string, batch = 500) =>
    workerRecon.sweepIneligibleDocuments(batch, teamId);

  // =========================================================================
  // Create / update
  // =========================================================================

  it("CREATE — a new record becomes searchable", async () => {
    const marker = `create-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    const doc = await documentFor(A.teamId, id);
    expect(doc).not.toBeNull();
    expect(doc?.title).toContain(marker);

    const rows = await search(A, marker);
    expect(rows.map((r) => r.evidenceId)).toContain(id);
  });

  it("UPDATE — re-indexing refreshes the document in place, by the upsert key", async () => {
    const id = await createIndexed(A, { title: "before-rename" });
    const first = await documentFor(A.teamId, id);

    await prisma.evidence.update({
      where: { id },
      data: { title: "after-rename" },
    });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    const second = await documentFor(A.teamId, id);
    expect(second?.title).toBe("after-rename");
    // ONE document, not two: the upsert key is (team_id, document_type,
    // source_id), so an update can never fork a record into two search hits.
    expect(second?.id).toBe(first?.id);
    expect(
      await prisma.evidenceSearchDocument.count({
        where: { teamId: A.teamId, documentType: "EVIDENCE", sourceId: id },
      }),
    ).toBe(1);
  });

  // =========================================================================
  // Archive / Trash / restore — visible, and labelled
  // =========================================================================

  it("ARCHIVE — an archived record stays searchable and is tagged", async () => {
    const marker = `archive-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    await prisma.evidence.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    expect(tagsOf(await documentFor(A.teamId, id))).toContain("archived");
    expect((await search(A, marker)).map((r) => r.evidenceId)).toContain(id);
  });

  it("TRASH — a soft-deleted record stays searchable and is tagged in_trash", async () => {
    // A user has to be able to FIND a record in order to restore it. Removing
    // it from search is how a product looks like it lost somebody's data.
    const marker = `trash-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    await prisma.evidence.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    expect(tagsOf(await documentFor(A.teamId, id))).toContain("in_trash");
    expect((await search(A, marker)).map((r) => r.evidenceId)).toContain(id);
  });

  it("RESTORE — the tag clears and the document is not re-created", async () => {
    const marker = `restore-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    await prisma.evidence.update({ where: { id }, data: { deletedAt: new Date() } });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });
    const trashed = await documentFor(A.teamId, id);
    expect(tagsOf(trashed)).toContain("in_trash");

    await prisma.evidence.update({ where: { id }, data: { deletedAt: null } });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    const restored = await documentFor(A.teamId, id);
    expect(tagsOf(restored)).not.toContain("in_trash");
    // Restore is an UPDATE of the same document, not a re-index that leaves the
    // old row behind — the route that restores stays truthful about identity.
    expect(restored?.id).toBe(trashed?.id);
    expect((await search(A, marker)).map((r) => r.evidenceId)).toContain(id);
  });

  // =========================================================================
  // Permanent removal — governance decided these records are gone
  // =========================================================================

  it("DESTRUCTION — a DESTROYED record's document is swept away", async () => {
    const marker = `destroy-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "DESTROYED" },
    });

    expect(await sweep(A.teamId)).toBeGreaterThan(0);
    expect(await documentFor(A.teamId, id)).toBeNull();
    expect((await search(A, marker)).map((r) => r.evidenceId)).not.toContain(id);
  });

  it("PENDING_DESTRUCTION — the same, before the record is physically gone", async () => {
    const id = await createIndexed(A, { title: `pending-${randomUUID()}` });
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "PENDING_DESTRUCTION" },
    });

    await sweep(A.teamId);
    expect(await documentFor(A.teamId, id)).toBeNull();
  });

  it("HARD DELETE — a record with no source row leaves nothing discoverable", async () => {
    const marker = `hard-${randomUUID().slice(0, 8)}`;
    const id = await createIndexed(A, { title: `evidence ${marker}` });

    // Physically gone. The projection builder never runs for a row that does
    // not exist, so ONLY the sweep can remove this document.
    await prisma.evidenceSearchDocument.updateMany({
      where: { teamId: A.teamId, sourceId: id },
      data: { searchableText: `secret ${marker} ocr text` },
    });
    await prisma.evidence.delete({ where: { id } });

    await sweep(A.teamId);
    expect(await documentFor(A.teamId, id)).toBeNull();
    // Not merely absent from the title index — the extracted text is gone too.
    expect(
      await prisma.evidenceSearchDocument.count({
        where: { teamId: A.teamId, searchableText: { contains: marker } },
      }),
    ).toBe(0);
    expect(await search(A, marker)).toHaveLength(0);
  });

  // =========================================================================
  // Other transitions the document has to follow
  // =========================================================================

  it("VISIBILITY CHANGE — the governance snapshot follows the row", async () => {
    const id = await createIndexed(A, { title: `visibility-${randomUUID()}` });
    const before = await documentFor(A.teamId, id);
    expect(
      (before?.governanceScopeJson as { lifecycleState?: string } | null)
        ?.lifecycleState,
    ).toBe("ACTIVE");

    // A governance state the SNAPSHOT carries, so the change is observable
    // where the filters actually read it. The snapshot exists precisely so a
    // filter does not have to join back to the source on every query — which
    // means a snapshot that did not follow the row would answer from a stale
    // governance state, silently and for as long as the record survived.
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "ON_HOLD" },
    });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    const after = await documentFor(A.teamId, id);
    expect(
      (after?.governanceScopeJson as { lifecycleState?: string } | null)
        ?.lifecycleState,
    ).toBe("ON_HOLD");
    // …and the operator-facing badge moves with it.
    expect(tagsOf(after)).toContain("on_hold");
    // ON_HOLD is not a terminal state, so the record stays searchable.
    expect(after).not.toBeNull();
  });

  it("CASE REASSIGNMENT — the document's caseId follows the link", async () => {
    const id = await createIndexed(A, { title: `case-move-${randomUUID()}` });
    expect((await documentFor(A.teamId, id))?.caseId).toBeNull();

    await prisma.caseEvidenceLink.create({
      data: {
        evidenceId: id,
        caseId: harness.fixtures.teamA.caseId,
        teamId: A.teamId,
        linkedByUserId: A.ownerUserId,
      },
    });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    expect((await documentFor(A.teamId, id))?.caseId).toBe(
      harness.fixtures.teamA.caseId,
    );
  });

  // =========================================================================
  // Tenancy and repetition
  // =========================================================================

  it("CROSS-TENANT — a sweep for one workspace never touches another's index", async () => {
    const mine = await createIndexed(A, { title: `mine-${randomUUID()}` });
    const theirs = await createIndexed(B, { title: `theirs-${randomUUID()}` });

    // BOTH become ineligible. Only the named workspace may be swept.
    await prisma.evidence.updateMany({
      where: { id: { in: [mine, theirs] } },
      data: { lifecycleState: "DESTROYED" },
    });

    await sweep(A.teamId);

    expect(await documentFor(A.teamId, mine)).toBeNull();
    expect(await documentFor(B.teamId, theirs)).not.toBeNull();

    // …and the other workspace's own sweep still works.
    await sweep(B.teamId);
    expect(await documentFor(B.teamId, theirs)).toBeNull();
  });

  it("CROSS-TENANT — one workspace's search never returns another's records", async () => {
    const marker = `isolation-${randomUUID().slice(0, 8)}`;
    const theirs = await createIndexed(B, { title: `evidence ${marker}` });

    expect((await search(A, marker)).map((r) => r.evidenceId)).not.toContain(theirs);
    expect((await search(B, marker)).map((r) => r.evidenceId)).toContain(theirs);
  });

  it("DUPLICATE RETRY — sweeping twice is idempotent and is not an error", async () => {
    const id = await createIndexed(A, { title: `retry-${randomUUID()}` });
    await prisma.evidence.update({
      where: { id },
      data: { lifecycleState: "DESTROYED" },
    });

    const first = await sweep(A.teamId);
    expect(first).toBeGreaterThan(0);
    // A second pass over a clean index removes nothing and raises nothing.
    await expect(sweep(A.teamId)).resolves.toBe(0);
  });

  it("DUPLICATE RETRY — re-indexing the same record twice yields one document", async () => {
    const id = await createIndexed(A, { title: `idem-${randomUUID()}` });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });
    await indexing.indexEvidence({ teamId: A.teamId, evidenceId: id });

    expect(
      await prisma.evidenceSearchDocument.count({
        where: { teamId: A.teamId, documentType: "EVIDENCE", sourceId: id },
      }),
    ).toBe(1);
  });

  // =========================================================================
  // Ordering — the sweep runs FIRST
  // =========================================================================

  it("the ineligible sweep runs BEFORE drift reconciliation, within one run", async () => {
    // A destroyed record's document must be gone before the drift scan
    // measures what is outstanding. Otherwise one tick can re-enqueue work for
    // a row it is about to remove, and the readiness counts derived from the
    // same population disagree with themselves.
    const destroyed = await createIndexed(A, { title: `order-${randomUUID()}` });
    await prisma.evidence.update({
      where: { id: destroyed },
      data: { lifecycleState: "DESTROYED" },
    });

    const tick = await workerRecon.runSearchIndexReconciler({
      trigger: "test-order",
      // Old enough that the settle grace period cannot hide the row.
      gracePeriodMs: 60_000,
    });

    expect(tick.ok).toBe(true);
    // The document is gone, and it was removed by the run that also scanned
    // for drift — not by a later tick.
    expect(await documentFor(A.teamId, destroyed)).toBeNull();
    expect(tick.removed).toBeGreaterThan(0);
  });
});
