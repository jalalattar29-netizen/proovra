/**
 * ATTENTION ARCHITECTURE — PHASE 8.3 (2026-08-22).
 * TENANT ISOLATION, PROVEN AGAINST LIVE POSTGRESQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS AGAINST A REAL DATABASE
 * ---------------------------------------------------------------------------
 * Phase 2.5 fixed two sources that had NO tenancy gate at all:
 *
 *   AccessReview                 scoped by "the caller is the subject"
 *   CollaborationTeamNotification scoped by "the caller is the addressee"
 *
 * Neither is a tenancy gate. Both answer "who is this ABOUT", not "may they
 * still see the workspace it belongs to" — so a REVOKED member kept receiving
 * a workspace's rows, content and deep links included, for as long as the
 * underlying record stayed open.
 *
 * A source-shape test can show the predicate is present. Only a live two-tenant
 * probe can show it WORKS: that tenant B's rows do not appear in tenant A's
 * response when the query actually runs. Frontend filtering is not security,
 * and neither is a regex.
 *
 * The suite is `*.integration.test.ts`, so it runs in the integration project
 * against a disposable Postgres — never in the default unit run, where it
 * would be a skipped test pretending to be a passing one.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Phase 8.3 — tenant isolation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  /** Two genuinely separate tenants. Nothing is shared between them. */
  let A: { teamId: string; ownerToken: string; ownerUserId: string };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

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
    await harness?.cleanup?.();
  });

  beforeEach(async () => {
    await prisma.operationalIncident
      .deleteMany({ where: { teamId: { in: [A.teamId, B.teamId] } } })
      .catch(() => null);
  });

  async function get(path: string, token: string) {
    const res = await harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  /** One shared operational condition in the given workspace. */
  async function openCondition(teamId: string, title: string) {
    return prisma.operationalIncident.create({
      data: {
        teamId,
        category: "EVIDENCE_INTEGRITY",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: `tsa_failure:${randomUUID()}`,
        title,
        safeSummary: "Integrity condition seeded for the isolation probe.",
      },
    });
  }

  // ==========================================================================
  // Operations list + summary
  // ==========================================================================

  it("the Operations LIST never returns another tenant's conditions", async () => {
    // IDENTIFIED BY FINGERPRINT, NOT BY TITLE.
    //
    // The title used to be a per-row fixture marker, and it stopped being one:
    // projection renders the condition's SOURCE label now — count-free and
    // identical for every row of a source — so both workspaces' rows read
    // "Trusted timestamping failed" and the isolation assertion compared two
    // copies of the same string.
    //
    // The fingerprint is the row's own durable identity and is unique by
    // construction, so this is a STRICTER probe than the one it replaces: a
    // leak of a differently-titled row would have been caught by both, and a
    // leak of an identically-titled one only by this.
    const aRow = await openCondition(A.teamId, "A-only condition");
    const bRow = await openCondition(B.teamId, "B-only condition");

    const a = await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken);
    expect(a.status).toBe(200);
    const fingerprints = (
      a.body.incidents as Array<{ fingerprint: string }>
    ).map((i) => i.fingerprint);
    expect(fingerprints).toContain(aRow.fingerprint);
    expect(fingerprints).not.toContain(bRow.fingerprint);
  });

  it("the Operations SUMMARY counts only the caller's workspace", async () => {
    await openCondition(A.teamId, "A-1");
    await openCondition(A.teamId, "A-2");
    await openCondition(B.teamId, "B-1");

    const a = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
    expect(a.status).toBe(200);
    const summary = a.body.summary as { open: number; complete: boolean };
    expect(summary.open).toBe(2);
    expect(summary.complete).toBe(true);
  });

  it("asking for ANOTHER tenant's workspace is refused, not answered", async () => {
    await openCondition(B.teamId, "B-only condition");

    // Anti-enumeration: a non-member is told the workspace does not exist
    // rather than that they lack permission on it.
    const cross = await get(`/v1/ops/incidents?teamId=${B.teamId}`, A.ownerToken);
    expect(cross.status).toBe(404);

    const crossSummary = await get(
      `/v1/ops/summary?teamId=${B.teamId}`,
      A.ownerToken,
    );
    expect(crossSummary.status).toBe(404);
  });

  it("a cross-tenant MUTATION is refused", async () => {
    const bCondition = await openCondition(B.teamId, "B-only condition");
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/ops/incidents/${bCondition.id}/ack`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { teamId: B.teamId },
    });
    expect(res.statusCode).toBe(404);

    // And the condition is untouched.
    const after = await prisma.operationalIncident.findUnique({
      where: { id: bCondition.id },
      select: { status: true, acknowledgedByUserId: true },
    });
    expect(after?.status).toBe("OPEN");
    expect(after?.acknowledgedByUserId).toBeNull();
  });

  // ==========================================================================
  // The two sources Phase 2.5 repaired
  // ==========================================================================

  it("AccessReview: subject-hood does NOT grant cross-tenant visibility", async () => {
    // THE Phase-2.5 defect, reproduced as its fixture: a review in tenant B
    // whose SUBJECT is tenant A's owner. Before the fix, the predicate was
    // `status + (subject OR initiator)` with no workspace scope, so this row
    // reached A's feed — complete with a deep link into B.
    // The fixture is created WITHOUT a catch: if it cannot be constructed the
    // suite must fail loudly rather than pass over a review that never
    // existed, which would make the assertion below vacuous.
    const review = await prisma.accessReview.create({
      data: {
        teamId: B.teamId,
        kind: "PERIODIC_MEMBER_REVIEW",
        status: "PENDING",
        subjectKind: "TEAM_MEMBER",
        subjectUserId: A.ownerUserId,
        initiatedByUserId: B.ownerUserId,
      },
    });
    expect(review.teamId).toBe(B.teamId);
    expect(review.subjectUserId).toBe(A.ownerUserId);

    const a = await get("/v1/me/inbox?pageSize=100", A.ownerToken);
    expect(a.status).toBe(200);
    const items = a.body.items as Array<{ itemKey: string }>;
    expect(
      items.some((i) => i.itemKey === `access_review_pending:${review.id}`),
      "tenant B's access review must not appear in tenant A's feed",
    ).toBe(false);
  });

  it("CollaborationTeamNotification: addressee-hood does NOT grant it either", async () => {
    // Same class: a notification in tenant B's workspace addressed to tenant
    // A's owner. `userId` says who it is for; it says nothing about whether
    // they may still see B.
    const note = await prisma.collaborationTeamNotification.create({
      data: {
        userId: A.ownerUserId,
        workspaceId: B.teamId,
        type: "DISCUSSION_REPLY",
        title: "Tenant B internal discussion",
      },
    });
    expect(note.workspaceId).toBe(B.teamId);
    expect(note.userId).toBe(A.ownerUserId);

    const a = await get("/v1/me/inbox?pageSize=100", A.ownerToken);
    const items = a.body.items as Array<{ itemKey: string; title: string }>;
    expect(
      items.some((i) => i.itemKey === `collaboration:${note.id}`),
      "tenant B's collaboration notification must not reach tenant A",
    ).toBe(false);
    expect(items.some((i) => i.title === "Tenant B internal discussion")).toBe(
      false,
    );
  });

  // ==========================================================================
  // The personal surfaces
  // ==========================================================================

  it("the notification feed and the bell agree, and neither leaks", async () => {
    await openCondition(B.teamId, "B-only condition");

    const feed = await get("/v1/me/inbox?pageSize=100", A.ownerToken);
    const bell = await get("/v1/me/inbox/summary", A.ownerToken);
    expect(feed.status).toBe(200);
    expect(bell.status).toBe(200);

    const items = feed.body.items as Array<{ context?: { teamId?: string } }>;
    for (const item of items) {
      if (item.context?.teamId) {
        expect(
          item.context.teamId,
          "no item may be scoped to a workspace the caller cannot access",
        ).not.toBe(B.teamId);
      }
    }
  });

  it("Home's workspace summary is per-workspace, and B's work is not in A's", async () => {
    await openCondition(A.teamId, "A-1");
    await openCondition(B.teamId, "B-1");
    await openCondition(B.teamId, "B-2");
    await openCondition(B.teamId, "B-3");

    const a = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
    const b = await get(`/v1/ops/summary?teamId=${B.teamId}`, B.ownerToken);
    expect((a.body.summary as { open: number }).open).toBe(1);
    expect((b.body.summary as { open: number }).open).toBe(3);
  });
});
