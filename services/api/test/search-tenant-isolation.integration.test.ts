/**
 * SEARCH IS WORKSPACE-SCOPED, AND THAT IS PROVEN AGAINST A REAL DATABASE.
 * (live PostgreSQL 16)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * An audit of the "Ask in plain language" card raised two concerns: that
 * displayed result names might not match real Evidence names, and that results
 * might not be properly scoped. The card is withdrawn, but the concern was
 * about SEARCH — so the canonical search path is revalidated here rather than
 * assumed to be fine because a different surface was the one complained about.
 *
 * FRONTEND FILTERING DOES NOT COUNT AS ISOLATION, so every assertion below
 * goes through the real `GET /v1/search` route against a real database, with
 * two real workspaces and real memberships. A caller from Workspace A searches
 * for a term that exists ONLY in Workspace B and must receive nothing.
 *
 * The second half is about NAMES: a result must carry the canonical current
 * title of the record it points at — not a fixture label, not a stale copy
 * taken at index time and never refreshed.
 */

import { randomUUID } from "node:crypto";
import { SEARCH_PROJECTION_VERSION } from "@proovra/shared";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Search tenant isolation + display names (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let indexing: typeof import("../src/services/search/evidence-indexing.service.js");

  let A: { teamId: string; ownerToken: string; ownerUserId: string };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  /** A token nothing else in the database can contain. */
  const MARK = randomUUID().replace(/-/g, "").slice(0, 12);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    indexing = await import(
      "../src/services/search/evidence-indexing.service.js"
    );
    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  const seededDocIds: string[] = [];

  beforeEach(async () => {
    if (seededDocIds.length > 0) {
      await prisma.evidenceSearchDocument.deleteMany({
        where: { sourceId: { in: seededDocIds } },
      });
      seededDocIds.length = 0;
    }
  });

  // =========================================================================
  // Helpers — the REAL route, the REAL indexer
  // =========================================================================

  /** Put one document into the canonical index for a workspace. */
  async function index(input: {
    teamId: string;
    documentType: string;
    title: string;
    text: string;
    reviewerRestricted?: boolean;
  }): Promise<string> {
    const sourceId = randomUUID();
    seededDocIds.push(sourceId);
    const res = await indexing.upsertSearchDocumentProjection({
      teamId: input.teamId,
      documentType: input.documentType as never,
      sourceId,
      title: input.title,
      subtitle: null,
      summary: null,
      searchableText: input.text,
      searchableMetadata: null,
      searchableTags: [],
      visibilityScope: null,
      governanceScope: null,
      reviewState: null,
      workflowState: null,
      exportState: null,
      retentionState: null,
      legalHoldState: null,
      contributorScoped: false,
      reviewerRestricted: input.reviewerRestricted ?? false,
      evidenceId: input.documentType === "EVIDENCE" ? sourceId : null,
      workflowInstanceId: null,
      workflowStepInstanceId: null,
      caseId: input.documentType === "CASE" ? sourceId : null,
      claimRef: null,
      matterRef: null,
      sourceUpdatedAtUtc: new Date(),
      projectionVersion: SEARCH_PROJECTION_VERSION,
    });
    expect(res.ok, `indexing ${input.title} failed`).toBe(true);
    return sourceId;
  }

  async function search(
    token: string,
    teamId: string,
    q: string,
  ): Promise<
    Array<{
      title: string;
      documentType: string;
      evidenceId: string | null;
      caseId: string | null;
    }>
  > {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${teamId}&q=${encodeURIComponent(q)}&limit=50`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `search returned ${res.statusCode}`).toBe(200);
    const body = res.json() as {
      rows?: Array<{
        title: string;
        documentType: string;
        evidenceId: string | null;
        caseId: string | null;
      }>;
    };
    return body.rows ?? [];
  }

  // =========================================================================
  // 1. THE NEGATIVE TEST — the one that actually proves isolation
  // =========================================================================

  it("1. a Workspace-A caller never receives Workspace-B rows, for any document class", async () => {
    // The SAME unique term in both workspaces, so the only thing separating
    // the two result sets is the tenancy predicate.
    const classes = ["EVIDENCE", "CASE", "REPORT"] as const;
    // Each class is identified by whatever a row of that class can be
    // recognised by: EVIDENCE and CASE carry a pointer, REPORT carries only
    // its title, so the title is made unique per class.
    const inB: string[] = [];
    for (const documentType of classes) {
      const id = await index({
        teamId: B.teamId,
        documentType,
        title: `B ${documentType} ${MARK}`,
        text: `secret ${MARK} belonging to workspace B`,
      });
      inB.push(documentType === "REPORT" ? `B ${documentType} ${MARK}` : id);
    }
    // One row in A carrying the same term, so a zero result cannot be mistaken
    // for "the query matched nothing anywhere".
    const inA = await index({
      teamId: A.teamId,
      documentType: "EVIDENCE",
      title: `A EVIDENCE ${MARK}`,
      text: `visible ${MARK} belonging to workspace A`,
    });

    const rowsA = await search(A.ownerToken, A.teamId, MARK);
    const idsA = rowsA.map((r) => r.evidenceId ?? r.caseId ?? r.title);

    // The query DOES work — A sees its own row.
    expect(idsA).toContain(inA);
    // …and none of B's, in any class.
    for (const id of inB) {
      expect(idsA, `workspace B row ${id} leaked into A`).not.toContain(id);
    }
    expect(rowsA.every((r) => !r.title.startsWith("B "))).toBe(true);

    // And the mirror: B sees its three and not A's.
    const rowsB = await search(B.ownerToken, B.teamId, MARK);
    const idsB = rowsB.map((r) => r.evidenceId ?? r.caseId ?? r.title);
    for (const id of inB) expect(idsB).toContain(id);
    expect(idsB, "workspace A row leaked into B").not.toContain(inA);
  });

  it("2. asking for another workspace's id is refused, not served", async () => {
    // The isolation above must not depend on the CALLER passing their own
    // teamId. A caller who names a workspace they do not belong to gets no
    // data — and an anti-enumeration answer rather than a 403 that confirms
    // the workspace exists.
    await index({
      teamId: B.teamId,
      documentType: "EVIDENCE",
      title: `B EVIDENCE ${MARK}-x`,
      text: `secret ${MARK}-x`,
    });
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${B.teamId}&q=${MARK}-x&limit=50`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect([403, 404]).toContain(res.statusCode);
    const body = JSON.stringify(res.json() ?? {});
    expect(body).not.toContain(`${MARK}-x`);
  });

  it("3. an unauthenticated caller receives nothing", async () => {
    await index({
      teamId: A.teamId,
      documentType: "EVIDENCE",
      title: `A EVIDENCE ${MARK}-anon`,
      text: `secret ${MARK}-anon`,
    });
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/search?teamId=${A.teamId}&q=${MARK}-anon`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // 2. DISPLAY NAMES — a result names the thing it points at
  // =========================================================================

  it("4. a result carries the canonical title, not a stale one", async () => {
    const title = `Canonical evidence name ${MARK}`;
    const sourceId = await index({
      teamId: A.teamId,
      documentType: "EVIDENCE",
      title,
      text: `body ${MARK}`,
    });

    const rows = await search(A.ownerToken, A.teamId, MARK);
    const row = rows.find((r) => r.evidenceId === sourceId);
    expect(row, "the seeded row was not returned").toBeTruthy();
    // EXACTLY the title the record carries — not a truncation, not a
    // synthesised "Evidence <id>" label, not a placeholder.
    expect(row!.title).toBe(title);
    expect(row!.title).not.toMatch(/^Untitled/);
    expect(row!.title).not.toMatch(/^Evidence [0-9a-f]{8}/);

    // RENAMING THE RECORD RENAMES THE RESULT. This is the half that catches a
    // stale index: the row must follow the source, not a copy of it taken once.
    const renamed = `Renamed evidence ${MARK}`;
    await indexing.upsertSearchDocumentProjection({
      teamId: A.teamId,
      documentType: "EVIDENCE" as never,
      sourceId,
      title: renamed,
      subtitle: null,
      summary: null,
      searchableText: `body ${MARK}`,
      searchableMetadata: null,
      searchableTags: [],
      visibilityScope: null,
      governanceScope: null,
      reviewState: null,
      workflowState: null,
      exportState: null,
      retentionState: null,
      legalHoldState: null,
      contributorScoped: false,
      reviewerRestricted: false,
      evidenceId: sourceId,
      workflowInstanceId: null,
      workflowStepInstanceId: null,
      caseId: null,
      claimRef: null,
      matterRef: null,
      sourceUpdatedAtUtc: new Date(),
      projectionVersion: SEARCH_PROJECTION_VERSION,
    });

    const after = await search(A.ownerToken, A.teamId, MARK);
    const updated = after.find((r) => r.evidenceId === sourceId);
    expect(updated!.title).toBe(renamed);
    expect(updated!.title).not.toBe(title);
  });

  // =========================================================================
  // 3. THE VISIBILITY GATE the withdrawn card bypassed
  // =========================================================================

  it("5. the canonical search applies the reviewer-restriction gate", async () => {
    // This is the gate `runStateQuery` on the NL route skipped entirely — the
    // scoping half of the audit. It is asserted HERE so the canonical path is
    // known to hold it, whatever happens to that route.
    const restricted = await index({
      teamId: A.teamId,
      documentType: "EVIDENCE",
      title: `Restricted ${MARK}-r`,
      text: `restricted body ${MARK}-r`,
      reviewerRestricted: true,
    });
    const open = await index({
      teamId: A.teamId,
      documentType: "EVIDENCE",
      title: `Open ${MARK}-r`,
      text: `open body ${MARK}-r`,
    });

    // The owner is reviewer-capable and sees both.
    const asOwner = await search(A.ownerToken, A.teamId, `${MARK}-r`);
    const ownerIds = asOwner.map((r) => r.evidenceId);
    expect(ownerIds).toContain(open);
    expect(ownerIds).toContain(restricted);

    // A VIEWER is not, and must see only the open one.
    const viewerToken = harness.fixtures.teamA.viewerToken;
    if (viewerToken) {
      const asViewer = await search(viewerToken, A.teamId, `${MARK}-r`);
      const viewerIds = asViewer.map((r) => r.evidenceId);
      expect(viewerIds).toContain(open);
      expect(
        viewerIds,
        "a reviewer-restricted row reached a non-reviewer",
      ).not.toContain(restricted);
    }
  });
});
