/**
 * EVID-011 — a comment's audience label decides who reads it (decided 2026-11-07).
 *
 * Case comments:  ALL_MEMBERS — every case reader; REVIEWERS — the case's
 * managers (its owner, workspace OWNER / ADMIN) and members assigned to the
 * case; INTERNAL — the case's managers. The author always reads their own.
 * Only ALL_MEMBERS comments are searchable, because search answers by case
 * read access alone.
 *
 * Before: the labels were stored and shown and changed nothing — every case
 * reader received every comment's text through the case workspace, and every
 * comment was indexed for search.
 *
 * Real route (GET /v1/cases/:id/matter-workspace) and the real indexers against
 * live PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("EVID-011 comment audiences (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let cases: typeof import("../src/services/cases/case-lifecycle.service.js");
  let indexing: typeof import("../src/services/search/artifact-indexing.service.js");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    cases = await import("../src/services/cases/case-lifecycle.service.js");
    indexing = await import("../src/services/search/artifact-indexing.service.js");
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  async function caseWithComments() {
    const row = await prisma.case.create({
      data: { teamId: A().teamId, name: `evid011-${Date.now().toString(36)}`, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    const ids: Record<string, string> = {};
    for (const visibility of ["INTERNAL", "REVIEWERS", "ALL_MEMBERS"] as const) {
      const c = await cases.addCaseComment({
        actorUserId: A().adminUserId,
        caseId: row.id,
        body: `note-${visibility}`,
        visibility,
      });
      ids[visibility] = c.id;
    }
    // The viewer's own restricted comment: an author always reads it.
    const own = await cases.addCaseComment({
      actorUserId: A().viewerUserId,
      caseId: row.id,
      body: "viewer-own-internal",
      visibility: "INTERNAL",
    });
    ids.OWN = own.id;
    return { caseId: row.id, ids };
  }

  async function bodiesFor(caseId: string, token: string): Promise<string[]> {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/cases/${caseId}/matter-workspace`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const env = res.json() as { sections: { notes: { caseComments: Array<{ body: string }> } } };
    return env.sections.notes.caseComments.map((c) => c.body).sort();
  }

  it("each reader gets exactly the comments its role and assignment admit", async () => {
    const { caseId } = await caseWithComments();
    // Managers (workspace OWNER) read everything.
    expect(await bodiesFor(caseId, A().ownerToken)).toEqual(
      ["note-ALL_MEMBERS", "note-INTERNAL", "note-REVIEWERS", "viewer-own-internal"].sort(),
    );
    // A member who is not assigned: ALL_MEMBERS only.
    expect(await bodiesFor(caseId, A().memberToken)).toEqual(["note-ALL_MEMBERS"]);
    // A viewer: ALL_MEMBERS, plus their own comment.
    expect(await bodiesFor(caseId, A().viewerToken)).toEqual(["note-ALL_MEMBERS", "viewer-own-internal"].sort());

    // Assigned to the case, the member reads REVIEWERS too — not INTERNAL.
    await prisma.caseAssignment.create({
      data: { teamId: A().teamId, caseId, assignedToUserId: A().memberUserId, assignedByUserId: A().ownerUserId, role: "INVESTIGATOR" } as never,
    });
    expect(await bodiesFor(caseId, A().memberToken)).toEqual(["note-ALL_MEMBERS", "note-REVIEWERS"].sort());
  });

  it("only an ALL_MEMBERS comment is searchable; a restricted one indexed before the rule is removed", async () => {
    const { ids } = await caseWithComments();
    // A NOTE document left by the old indexer for a restricted comment.
    await prisma.evidenceSearchDocument.create({
        data: {
          teamId: A().teamId,
          documentType: "NOTE",
          sourceId: ids.INTERNAL!,
          title: "note-INTERNAL",
          searchableText: "note-INTERNAL",
          sourceUpdatedAtUtc: new Date(),
        } as never,
    });
    expect(await prisma.evidenceSearchDocument.count({ where: { documentType: "NOTE", sourceId: ids.INTERNAL! } })).toBe(1);

    expect(await indexing.indexNote({ noteId: ids.INTERNAL! })).toMatchObject({ ok: false, reason: "note_restricted_audience" });
    expect(await indexing.indexNote({ noteId: ids.REVIEWERS! })).toMatchObject({ ok: false, reason: "note_restricted_audience" });
    expect(
      await prisma.evidenceSearchDocument.count({
        where: { documentType: "NOTE", sourceId: { in: [ids.INTERNAL!, ids.REVIEWERS!] } },
      }),
    ).toBe(0);

    expect((await indexing.indexNote({ noteId: ids.ALL_MEMBERS! })).ok).toBe(true);
    expect(await prisma.evidenceSearchDocument.count({ where: { documentType: "NOTE", sourceId: ids.ALL_MEMBERS! } })).toBe(1);
  });
});
