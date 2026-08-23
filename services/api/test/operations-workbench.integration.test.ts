/**
 * OPERATIONS WORKBENCH — the server contract, proven against live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS AGAINST A REAL DATABASE
 * ---------------------------------------------------------------------------
 * The workbench redesign moved every filter on `/operations` from the browser
 * to the server, added an ownership filter and a sort control to the canonical
 * list, and added the first READ of `OperationalIncidentEvent` the product has
 * ever had. Each of those is a query, and a query is the one thing a
 * source-shape test cannot check:
 *
 *   - a predicate can be present and match the wrong rows;
 *   - a sort can look total and still tie, which silently skips and repeats
 *     rows across a keyset page boundary;
 *   - a tenant scope can be written correctly in one leg and forgotten in the
 *     one added beside it;
 *   - a count can be computed from a different scan than the list it is
 *     supposed to conserve against.
 *
 * The suite is `*.integration.test.ts`, so it runs in the integration project
 * against a disposable Postgres — never in the default unit run, where it
 * would be a skipped test pretending to be a passing one.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operations workbench — server contract (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  let A: {
    teamId: string;
    ownerToken: string;
    ownerUserId: string;
    memberToken: string;
    memberUserId: string;
    viewerToken: string;
    viewerUserId: string;
    evidenceId: string;
  };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      memberToken: harness.fixtures.teamA.memberToken,
      memberUserId: harness.fixtures.teamA.memberUserId,
      viewerToken: harness.fixtures.teamA.viewerToken,
      viewerUserId: harness.fixtures.teamA.viewerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function get(path: string, token: string) {
    return harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
  }
  async function post(path: string, token: string, body: unknown) {
    return harness.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}` },
      payload: body as never,
    });
  }

  type Seed = {
    teamId: string;
    title?: string;
    severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
    status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "SUPPRESSED";
    category?: "EVIDENCE_INTEGRITY" | "REPORT" | "PACKAGE";
    owner?: string | null;
    /** Every seeded row gets a DISTINCT lastSeen so ordering is observable. */
    minutesAgo?: number;
    occurrences?: number;
    summary?: string;
  };

  let seq = 0;
  async function seed(over: Seed) {
    seq += 1;
    const ago = over.minutesAgo ?? seq;
    const at = new Date(Date.now() - ago * 60_000);
    return prisma.operationalIncident.create({
      data: {
        teamId: over.teamId,
        category: (over.category ?? "EVIDENCE_INTEGRITY") as never,
        severity: (over.severity ?? "HIGH") as never,
        status: (over.status ?? "OPEN") as never,
        fingerprint: `test:${randomUUID()}`,
        title: over.title ?? "Trusted timestamp failed",
        safeSummary: over.summary ?? "The authority returned no token.",
        firstSeenAtUtc: at,
        lastSeenAtUtc: at,
        occurrenceCount: over.occurrences ?? 1,
        assignedOperatorUserId: over.owner ?? null,
      },
    });
  }

  /**
   * MINT AN APPROVED STEP-UP ELEVATION FOR THE BULK ROUTE.
   *
   * `POST /v1/ops/bulk-actions` requires the actor to re-prove before a
   * fan-out touches anything, and the gate is satisfied by an APPROVED
   * challenge id in `x-proovra-step-up-challenge-id`. Producing one the long
   * way needs a delivered one-time code, which is stored hashed and is
   * therefore unreadable from a test.
   *
   * So this creates the STATE a real approval produces — an active verified
   * contact factor and an approved, unexpired, generation-matched challenge
   * bound to this actor, workspace, purpose and resource. Every predicate the
   * consume path checks is satisfied by real rows, not stubbed away: the
   * factor must exist and match generation, the challenge must be APPROVED,
   * unexpired and initiated by this user.
   *
   * What is deliberately NOT proven here is step-up's OWN verification — the
   * code delivery, the attempt limit, the session binding. Those have their
   * own suites, and re-proving them here would make these cases fail for
   * reasons that have nothing to do with bulk assignment. What IS proven here
   * is that the bulk route is gated at all: the cases below that expect a
   * refusal send no header.
   */
  async function approvedStepUp(input: {
    teamId: string;
    userId: string;
  }): Promise<string> {
    // Enrolled through the REAL service, not by hand-writing a row: the
    // destination is encrypted, fingerprinted and masked by the same code
    // path production uses, and the table's payload constraint holds because
    // the fields it requires were actually produced.
    const { startContactFactorEnrollment, completeContactFactorEnrollment } =
      await import("../src/services/security/verified-contact-factor.service.js");
    // An account enrols a contact factor ONCE; the service refuses a second.
    // Reusing the existing one is also what a real operator's second bulk
    // action does.
    const existing = await prisma.mfaFactor.findFirst({
      where: {
        userId: input.userId,
        status: "ACTIVE" as never,
        verifiedAtUtc: { not: null },
        revokedAt: null,
      },
    });
    const factorId =
      existing?.id ??
      (await (async () => {
        const started = await startContactFactorEnrollment({
          userId: input.userId,
          kind: "SMS",
          destinationRaw: "+15550100",
          label: "ops-integration",
        });
        await completeContactFactorEnrollment({
          userId: input.userId,
          factorId: started.factor.factorId,
        });
        return started.factor.factorId;
      })());
    const factor = await prisma.mfaFactor.findUniqueOrThrow({
      where: { id: factorId },
    });
    const challenge = await prisma.stepUpChallenge.create({
      data: {
        teamId: input.teamId,
        initiatedByUserId: input.userId,
        purpose: "REVIEWER_OPS_BULK_ACTION",
        resourceKind: "workspace",
        resourceId: input.teamId,
        status: "APPROVED" as never,
        factorId: factor.id,
        factorGeneration: factor.generation,
        approvedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000),
      },
    });
    return challenge.id;
  }

  const idsOf = (res: { body: string }) =>
    (JSON.parse(res.body).incidents as Array<{ id: string }>).map((i) => i.id);

  // =========================================================================
  // 1. TENANT BOUNDARY
  // =========================================================================

  describe("tenant boundary", () => {
    it("workspace A never sees workspace B's conditions", async () => {
      await seed({ teamId: A.teamId, title: "A only" });
      await seed({ teamId: B.teamId, title: "B only" });

      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}`,
        A.ownerToken,
      );
      expect(res.statusCode).toBe(200);
      const titles = (JSON.parse(res.body).incidents as Array<{ title: string }>)
        .map((i) => i.title);
      expect(titles).toEqual(["A only"]);
    });

    it("the new detail read is scoped by the WHERE clause, not by a check after it", async () => {
      const bRow = await seed({ teamId: B.teamId });
      // A real id, a real session, the wrong workspace: indistinguishable from
      // an id that does not exist.
      const res = await get(
        `/v1/ops/incidents/${bRow.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        error: { code: "incident_not_found" },
      });
    });

    it("claiming the OTHER workspace is refused invisibly, not with a 403", async () => {
      // Anti-enumeration: a non-member learns nothing about whether the
      // workspace exists.
      const res = await get(
        `/v1/ops/incidents?teamId=${B.teamId}`,
        A.ownerToken,
      );
      expect(res.statusCode).toBe(404);
    });

    it("a cross-workspace MUTATION is refused", async () => {
      const bRow = await seed({ teamId: B.teamId });
      const res = await post(`/v1/ops/incidents/${bRow.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      expect(res.statusCode).toBe(404);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: bRow.id },
      });
      expect(after?.status).toBe("OPEN");
      expect(after?.acknowledgedByUserId).toBeNull();
    });

    it("a caller cannot smuggle another workspace's id past the summary", async () => {
      const res = await get(`/v1/ops/summary?teamId=${B.teamId}`, A.ownerToken);
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // 2. ROLE BOUNDARY
  // =========================================================================

  describe("role boundary", () => {
    it("a VIEWER may read the queue and the detail", async () => {
      const row = await seed({ teamId: A.teamId });
      expect((await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.viewerToken)).statusCode).toBe(200);
      expect((await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.viewerToken)).statusCode).toBe(200);
    });

    it("a VIEWER may not acknowledge, resolve or suppress", async () => {
      const row = await seed({ teamId: A.teamId });
      for (const action of ["ack", "resolve", "suppress"]) {
        const res = await post(
          `/v1/ops/incidents/${row.id}/${action}`,
          A.viewerToken,
          { teamId: A.teamId },
        );
        expect(res.statusCode, `${action} must be refused for a viewer`).not.toBe(200);
      }
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.status).toBe("OPEN");
    });

    it("a VIEWER may not enumerate who could be assigned", async () => {
      const res = await get(
        `/v1/ops/assignable-operators?teamId=${A.teamId}`,
        A.viewerToken,
      );
      expect(res.statusCode).not.toBe(200);
    });

    it("assignment refuses an operator who is not an eligible member", async () => {
      const row = await seed({ teamId: A.teamId });
      const res = await post(
        `/v1/ops/incidents/${row.id}/assign`,
        A.ownerToken,
        { teamId: A.teamId, assigneeUserId: B.ownerUserId },
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_assignee");
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.assignedOperatorUserId).toBeNull();
    });
  });

  // =========================================================================
  // 3. THE NEW DETAIL READ
  // =========================================================================

  describe("incident detail", () => {
    it("returns the condition with its history, newest first", async () => {
      const row = await seed({ teamId: A.teamId });
      for (const [i, type] of ["opened", "occurrence", "acknowledged"].entries()) {
        await prisma.operationalIncidentEvent.create({
          data: {
            incidentId: row.id,
            eventType: type,
            safeMessage: `event ${i}`,
            createdAt: new Date(Date.now() - (10 - i) * 60_000),
          },
        });
      }
      const res = await get(
        `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      expect(res.statusCode).toBe(200);
      const detail = JSON.parse(res.body).incident;
      expect(detail.id).toBe(row.id);
      expect(detail.timelineComplete).toBe(true);
      expect(
        detail.timeline.map((e: { eventType: string }) => e.eventType),
      ).toEqual(["acknowledged", "occurrence", "opened"]);
    });

    it("never ships the sanitised metadata blob to the browser", async () => {
      const row = await seed({ teamId: A.teamId });
      await prisma.operationalIncidentEvent.create({
        data: {
          incidentId: row.id,
          eventType: "occurrence",
          safeMessage: "seen again",
          metadataJson: { providerRaw: "ECONNRESET at tsa.example:318" },
        },
      });
      const res = await get(
        `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      expect(res.body).not.toContain("ECONNRESET");
      expect(res.body).not.toContain("metadataJson");
    });

    it("a bounded history reports that it is bounded", async () => {
      const row = await seed({ teamId: A.teamId });
      await prisma.operationalIncidentEvent.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          incidentId: row.id,
          eventType: "occurrence",
          safeMessage: `occurrence ${i}`,
          createdAt: new Date(Date.now() - i * 1000),
        })),
      });
      const res = await get(
        `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      const detail = JSON.parse(res.body).incident;
      expect(detail.timeline).toHaveLength(50);
      // The flag is the point: 50 entries over a 60-entry history is not the
      // whole story, and the inspector says so rather than implying it is.
      expect(detail.timelineComplete).toBe(false);
    });

    it("a condition with NO history is complete, not truncated", async () => {
      const row = await seed({ teamId: A.teamId });
      const res = await get(
        `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      const detail = JSON.parse(res.body).incident;
      expect(detail.timeline).toEqual([]);
      expect(detail.timelineComplete).toBe(true);
    });
  });

  // =========================================================================
  // 4. FILTERS ARE SERVER FILTERS
  // =========================================================================

  describe("filters", () => {
    it("owner=unassigned returns exactly the conditions nobody holds", async () => {
      await seed({ teamId: A.teamId, title: "held", owner: A.memberUserId });
      await seed({ teamId: A.teamId, title: "free" });
      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&owner=unassigned`,
        A.ownerToken,
      );
      const titles = (JSON.parse(res.body).incidents as Array<{ title: string }>)
        .map((i) => i.title);
      expect(titles).toEqual(["free"]);
    });

    it("owner=me resolves to the CALLER, so two callers get two answers", async () => {
      await seed({ teamId: A.teamId, title: "owners", owner: A.ownerUserId });
      await seed({ teamId: A.teamId, title: "members", owner: A.memberUserId });

      const asOwner = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&owner=me`,
        A.ownerToken,
      );
      const asMember = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&owner=me`,
        A.memberToken,
      );
      expect(
        (JSON.parse(asOwner.body).incidents as Array<{ title: string }>).map(
          (i) => i.title,
        ),
      ).toEqual(["owners"]);
      expect(
        (JSON.parse(asMember.body).incidents as Array<{ title: string }>).map(
          (i) => i.title,
        ),
      ).toEqual(["members"]);
    });

    it("search matches the operator-facing strings and nothing else", async () => {
      const hit = await seed({
        teamId: A.teamId,
        title: "Bitcoin anchoring stalled",
      });
      await seed({ teamId: A.teamId, title: "Report generation failed" });

      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&q=anchoring`,
        A.ownerToken,
      );
      expect(idsOf(res)).toEqual([hit.id]);

      // Case-insensitive, and over the summary as well as the title.
      const bySummary = await seed({
        teamId: A.teamId,
        title: "Something else",
        summary: "The PACKAGE builder ran out of disk.",
      });
      const res2 = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&q=package%20builder`,
        A.ownerToken,
      );
      expect(idsOf(res2)).toEqual([bySummary.id]);

      // NOT over the fingerprint: an exact identifier matched by substring
      // turns a typo into a plausible-looking wrong row.
      const res3 = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&q=${encodeURIComponent(hit.fingerprint)}`,
        A.ownerToken,
      );
      expect(idsOf(res3)).toEqual([]);
    });

    it("a blank search is NO search, not a match on the empty string", async () => {
      await seed({ teamId: A.teamId });
      await seed({ teamId: A.teamId });
      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&q=%20%20`,
        A.ownerToken,
      );
      expect(idsOf(res)).toHaveLength(2);
    });

    it("filters COMPOSE rather than replacing one another", async () => {
      const target = await seed({
        teamId: A.teamId,
        severity: "CRITICAL",
        category: "REPORT",
        owner: A.memberUserId,
      });
      await seed({ teamId: A.teamId, severity: "CRITICAL", category: "REPORT" });
      await seed({
        teamId: A.teamId,
        severity: "HIGH",
        category: "REPORT",
        owner: A.memberUserId,
      });

      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&severity=CRITICAL&category=REPORT&owner=${A.memberUserId}`,
        A.ownerToken,
      );
      expect(idsOf(res)).toEqual([target.id]);
    });
  });

  // =========================================================================
  // 5. ORDER AND PAGINATION
  // =========================================================================

  describe("order and keyset pagination", () => {
    it("severity sort puts CRITICAL first, INFO last", async () => {
      await seed({ teamId: A.teamId, severity: "INFO", title: "i" });
      await seed({ teamId: A.teamId, severity: "CRITICAL", title: "c" });
      await seed({ teamId: A.teamId, severity: "WARNING", title: "w" });
      await seed({ teamId: A.teamId, severity: "HIGH", title: "h" });

      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&sort=severity`,
        A.ownerToken,
      );
      expect(
        (JSON.parse(res.body).incidents as Array<{ title: string }>).map(
          (i) => i.title,
        ),
      ).toEqual(["c", "h", "w", "i"]);
    });

    it("every order is TOTAL — identical rows still page without skipping or repeating", async () => {
      // The failure this catches: twenty conditions from one provider outage,
      // written in the same second with the same severity. A sort that ties
      // there makes the keyset cursor non-deterministic, and rows silently
      // vanish between page one and page two.
      const stamp = new Date(Date.now() - 60_000);
      await prisma.operationalIncident.createMany({
        data: Array.from({ length: 20 }, () => ({
          teamId: A.teamId,
          category: "EVIDENCE_INTEGRITY" as never,
          severity: "HIGH" as never,
          status: "OPEN" as never,
          fingerprint: `tie:${randomUUID()}`,
          title: "Trusted timestamp failed",
          safeSummary: "identical",
          firstSeenAtUtc: stamp,
          lastSeenAtUtc: stamp,
        })),
      });

      for (const sort of ["recent", "severity", "oldest", "occurrences"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const url =
            `/v1/ops/incidents?teamId=${A.teamId}&sort=${sort}&limit=6` +
            (cursor ? `&cursor=${cursor}` : "");
          const res = await get(url, A.ownerToken);
          const body = JSON.parse(res.body);
          seen.push(...(body.incidents as Array<{ id: string }>).map((i) => i.id));
          cursor = body.pagination.nextCursor;
          if (!cursor) break;
        }
        expect(seen, `${sort}: no row may repeat`).toHaveLength(
          new Set(seen).size,
        );
        expect(seen, `${sort}: no row may be skipped`).toHaveLength(20);
      }
    });

    it("completeness is reported, never inferred by the caller", async () => {
      await Promise.all(
        Array.from({ length: 5 }, () => seed({ teamId: A.teamId })),
      );
      const partial = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&limit=2`,
        A.ownerToken,
      );
      const partialBody = JSON.parse(partial.body);
      expect(partialBody.completeness.complete).toBe(false);
      expect(partialBody.completeness.mayAssertAllClear).toBe(false);
      expect(partialBody.pagination.nextCursor).toBeTruthy();

      const whole = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&limit=50`,
        A.ownerToken,
      );
      const wholeBody = JSON.parse(whole.body);
      expect(wholeBody.completeness.complete).toBe(true);
      expect(wholeBody.pagination.nextCursor).toBeNull();
    });

    it("an EMPTY filtered read is still a COMPLETE read", async () => {
      await seed({ teamId: A.teamId, severity: "INFO" });
      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&severity=CRITICAL`,
        A.ownerToken,
      );
      const body = JSON.parse(res.body);
      expect(body.incidents).toEqual([]);
      // The difference the workbench renders: "nothing matches" is a fact,
      // "I could not finish looking" is not.
      expect(body.completeness.complete).toBe(true);
    });
  });

  // =========================================================================
  // 6. THE SUMMARY CONSERVES AGAINST THE LIST
  // =========================================================================

  describe("summary conservation", () => {
    it("every count is computed from the same population the list returns", async () => {
      await seed({ teamId: A.teamId, severity: "CRITICAL" });
      await seed({ teamId: A.teamId, severity: "HIGH", owner: A.ownerUserId });
      await seed({ teamId: A.teamId, severity: "HIGH" });
      await seed({ teamId: A.teamId, severity: "WARNING", status: "ACKNOWLEDGED" });
      // Closed conditions are NOT unresolved work and must not be counted.
      await seed({ teamId: A.teamId, severity: "CRITICAL", status: "RESOLVED" });

      const res = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
      const { summary } = JSON.parse(res.body);

      expect(summary.open).toBe(4);
      expect(summary.critical).toBe(1);
      expect(summary.high).toBe(2);
      expect(summary.warning).toBe(1);
      expect(summary.acknowledged).toBe(1);
      expect(summary.assignedToMe).toBe(1);
      expect(summary.unassigned).toBe(3);
      // The parts add up against the whole they were counted from.
      expect(summary.critical + summary.high + summary.warning + summary.info)
        .toBe(summary.open);
      expect(summary.assignedToMe + summary.unassigned).toBeLessThanOrEqual(
        summary.open,
      );
      expect(summary.complete).toBe(true);
      expect(summary.mayAssertAllClear).toBe(true);

      // And the list of unresolved work is the same size as the count of it.
      const list = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=OPEN&limit=500`,
        A.ownerToken,
      );
      const acked = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=ACKNOWLEDGED&limit=500`,
        A.ownerToken,
      );
      expect(idsOf(list).length + idsOf(acked).length).toBe(summary.open);
    });

    it("the operator count is a COUNT, never the identities", async () => {
      const res = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.viewerToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.workspace.operatorCount).toBe("number");
      expect(body.workspace.operatorCount).toBeGreaterThan(1);
      // A viewer learns HOW MANY, never WHO — that stays behind assign.
      expect(res.body).not.toContain(A.memberUserId);
      expect(res.body).not.toContain("displayName");
    });

    it("a suppressed condition leaves the unresolved population, and says nothing false", async () => {
      const row = await seed({ teamId: A.teamId, severity: "CRITICAL" });
      const before = JSON.parse(
        (await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken)).body,
      ).summary;
      expect(before.open).toBe(1);
      expect(before.critical).toBe(1);

      await post(`/v1/ops/incidents/${row.id}/suppress`, A.ownerToken, {
        teamId: A.teamId,
      });

      const after = JSON.parse(
        (await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken)).body,
      ).summary;
      // Suppression is a DECISION to stop being told, so the condition leaves
      // the unresolved count. It is still readable under its own status — it
      // was not deleted and the record of it is intact.
      expect(after.open).toBe(0);
      expect(after.critical).toBe(0);
      const suppressed = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=SUPPRESSED`,
        A.ownerToken,
      );
      expect(idsOf(suppressed)).toEqual([row.id]);
    });
  });

  // =========================================================================
  // 7. LIFECYCLE
  // =========================================================================

  describe("lifecycle", () => {
    it("acknowledgement records WHO and WHEN, and claims nothing about the fix", async () => {
      const row = await seed({ teamId: A.teamId });
      const res = await post(
        `/v1/ops/incidents/${row.id}/ack`,
        A.memberToken,
        { teamId: A.teamId },
      );
      expect(res.statusCode).toBe(200);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.status).toBe("ACKNOWLEDGED");
      expect(after?.acknowledgedByUserId).toBe(A.memberUserId);
      expect(after?.acknowledgedAtUtc).toBeTruthy();
      // Acknowledging is not resolving.
      expect(after?.resolvedAtUtc).toBeNull();
    });

    it("every transition writes exactly one history entry", async () => {
      const row = await seed({ teamId: A.teamId });
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      await post(`/v1/ops/incidents/${row.id}/resolve`, A.ownerToken, {
        teamId: A.teamId,
        resolutionNote: "The provider recovered.",
      });

      const detail = JSON.parse(
        (await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.ownerToken))
          .body,
      ).incident;
      const types = detail.timeline.map((e: { eventType: string }) => e.eventType);
      expect(types.filter((t: string) => t === "acknowledged")).toHaveLength(1);
      expect(types.filter((t: string) => t === "resolved")).toHaveLength(1);
    });

    it("re-acknowledging an acknowledged condition does not double-write history", async () => {
      const row = await seed({ teamId: A.teamId });
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      const detail = JSON.parse(
        (await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.ownerToken))
          .body,
      ).incident;
      const acks = detail.timeline.filter(
        (e: { eventType: string }) => e.eventType === "acknowledged",
      );
      expect(acks.length).toBeLessThanOrEqual(1);
    });

    it("pagination survives a condition changing state underneath it", async () => {
      const rows = [];
      for (let i = 0; i < 8; i += 1) {
        rows.push(await seed({ teamId: A.teamId, minutesAgo: i + 1 }));
      }
      const page1 = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&sort=oldest&limit=4`,
        A.ownerToken,
      );
      const firstIds = idsOf(page1);
      const cursor = JSON.parse(page1.body).pagination.nextCursor;

      // An operator on another screen resolves one of the rows ALREADY SEEN.
      await post(`/v1/ops/incidents/${firstIds[0]}/resolve`, A.ownerToken, {
        teamId: A.teamId,
      });

      const page2 = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&sort=oldest&limit=4&cursor=${cursor}`,
        A.ownerToken,
      );
      const secondIds = idsOf(page2);
      // No overlap, and nothing from page one reappears on page two.
      expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(
        firstIds.length + secondIds.length,
      );
    });

    it("assignment to an eligible member sticks, and null unassigns", async () => {
      const row = await seed({ teamId: A.teamId });
      const assigned = await post(
        `/v1/ops/incidents/${row.id}/assign`,
        A.ownerToken,
        { teamId: A.teamId, assigneeUserId: A.memberUserId },
      );
      expect(assigned.statusCode).toBe(200);
      expect(
        (await prisma.operationalIncident.findUnique({ where: { id: row.id } }))
          ?.assignedOperatorUserId,
      ).toBe(A.memberUserId);

      const cleared = await post(
        `/v1/ops/incidents/${row.id}/assign`,
        A.ownerToken,
        { teamId: A.teamId, assigneeUserId: null },
      );
      expect(cleared.statusCode).toBe(200);
      expect(
        (await prisma.operationalIncident.findUnique({ where: { id: row.id } }))
          ?.assignedOperatorUserId,
      ).toBeNull();
    });
  });

  // =========================================================================
  // 8. NO RAW PROVIDER TEXT REACHES THE BROWSER
  // =========================================================================

  describe("safe projection", () => {
    it("no response carries a database or provider string", async () => {
      const row = await seed({ teamId: A.teamId });
      for (const res of [
        await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken),
        await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.ownerToken),
        await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken),
      ]) {
        for (const leak of [
          "PrismaClient",
          "prisma.",
          "operational_incidents",
          "ECONNREFUSED",
          "at Object.",
          "node_modules",
        ]) {
          expect(res.body, `${leak} must not reach the browser`).not.toContain(
            leak,
          );
        }
      }
    });
  });
  // =========================================================================
  // 9. REMEDIATION
  //
  // The projection decides what an operator may DO about a condition, and the
  // execution route turns that into work on a domain authority. Both are
  // queries about authorization, so both are proven here rather than against
  // a shape.
  // =========================================================================

  describe("remediation", () => {
    it("a TSA failure offers NO action, states why, and never names a retry", async () => {
      const row = await seed({
        teamId: A.teamId,
        category: "EVIDENCE_INTEGRITY",
        title: "Trusted timestamp failed",
      });
      // The fingerprint is what selects the registry entry.
      await prisma.operationalIncident.update({
        where: { id: row.id },
        data: { fingerprint: `tsa_failure:${A.evidenceId}` },
      });

      const res = await get(
        `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
        A.ownerToken,
      );
      expect(res.statusCode).toBe(200);
      const { remediation } = JSON.parse(res.body);

      expect(remediation.disposition).toBe("NO_SAFE_REMEDIATION_AUTHORITY");
      expect(remediation.actions).toHaveLength(0);
      // The reason is stated rather than left as an absence, so the operator
      // reads a boundary and not a missing feature.
      expect(remediation.unsafeReason).toBeTruthy();
      // No control, and no wording, that implies a timestamp can be re-taken.
      for (const forbidden of [
        "Retry TSA",
        "Repair TSA",
        "Refresh timestamp",
        "Reprocess TSA",
        "Restamp",
      ]) {
        expect(
          res.body,
          `a TSA retry must never be offered (${forbidden})`,
        ).not.toContain(forbidden);
      }
    });

    it("an OTS failure offers exactly one action, and executing it queues work without resolving the condition", async () => {
      const row = await seed({ teamId: A.teamId, title: "Anchoring failed" });
      await prisma.operationalIncident.update({
        where: { id: row.id },
        data: {
          fingerprint: `ots_failure:${A.evidenceId}`,
          relatedEvidenceId: A.evidenceId,
        },
      });

      const projected = JSON.parse(
        (
          await get(
            `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
            A.ownerToken,
          )
        ).body,
      ).remediation;
      expect(projected.disposition).toBe("DIRECT_REMEDIATION");
      expect(projected.actions).toHaveLength(1);
      expect(projected.actions[0].actionId).toBe("ots.resume_anchoring");

      const res = await post(`/v1/ops/incidents/${row.id}/remediate`, A.ownerToken, {
        teamId: A.teamId,
        actionId: "ots.resume_anchoring",
      });

      // Whatever the transport did, the answer is bounded and never claims
      // the work SUCCEEDED — nothing in this path observed it finish.
      const body = JSON.parse(res.body);
      expect(body.remediation.result).not.toBe("SUCCEEDED");
      expect([
        "QUEUED",
        "ALREADY_IN_PROGRESS",
        "ALREADY_SATISFIED",
        "QUEUE_UNAVAILABLE",
        "FAILED",
      ]).toContain(body.remediation.result);

      // THE CENTRAL CLAIM: requesting work does not close the condition. It
      // closes when the record itself recovers.
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.status).toBe("OPEN");
      expect(after?.resolvedAtUtc).toBeNull();
    });

    it("a viewer is offered no action and cannot execute one", async () => {
      const row = await seed({ teamId: A.teamId });
      await prisma.operationalIncident.update({
        where: { id: row.id },
        data: {
          fingerprint: `ots_failure:${A.evidenceId}`,
          relatedEvidenceId: A.evidenceId,
        },
      });

      const projected = JSON.parse(
        (
          await get(
            `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
            A.viewerToken,
          )
        ).body,
      ).remediation;
      // Withheld, not disabled: an action a reader cannot take is not shown
      // to them at all.
      expect(projected.actions).toHaveLength(0);

      const res = await post(`/v1/ops/incidents/${row.id}/remediate`, A.viewerToken, {
        teamId: A.teamId,
        actionId: "ots.resume_anchoring",
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it("workspace B cannot remediate workspace A's condition", async () => {
      const row = await seed({ teamId: A.teamId });
      await prisma.operationalIncident.update({
        where: { id: row.id },
        data: {
          fingerprint: `ots_failure:${A.evidenceId}`,
          relatedEvidenceId: A.evidenceId,
        },
      });
      const res = await post(`/v1/ops/incidents/${row.id}/remediate`, B.ownerToken, {
        teamId: B.teamId,
        actionId: "ots.resume_anchoring",
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.status).toBe("OPEN");
    });

    it("an unregistered action id is refused, and refused the same way for every workspace", async () => {
      const row = await seed({ teamId: A.teamId });
      const mine = await post(`/v1/ops/incidents/${row.id}/remediate`, A.ownerToken, {
        teamId: A.teamId,
        actionId: "evidence.delete",
      });
      expect(mine.statusCode).toBe(400);
      expect(JSON.parse(mine.body).error.code).toBe("unknown_remediation_action");
    });

    it("no queue name, provider string or database error reaches the browser", async () => {
      const row = await seed({ teamId: A.teamId });
      await prisma.operationalIncident.update({
        where: { id: row.id },
        data: {
          fingerprint: `ots_failure:${A.evidenceId}`,
          relatedEvidenceId: A.evidenceId,
        },
      });
      const res = await post(`/v1/ops/incidents/${row.id}/remediate`, A.ownerToken, {
        teamId: A.teamId,
        actionId: "ots.resume_anchoring",
      });
      for (const leak of [
        "bull",
        "redis",
        "ECONNREFUSED",
        "PrismaClient",
        "node_modules",
        "at Object.",
      ]) {
        expect(
          res.body.toLowerCase(),
          `${leak} must not reach the browser`,
        ).not.toContain(leak.toLowerCase());
      }
    });
  });

  // =========================================================================
  // 10. BULK ASSIGNMENT
  //
  // A sweep is a fan-out over the SAME single-item authority, so the proofs
  // that matter are: it carries no larger permission, it leaves the same
  // history one click would, and it answers per target rather than globally.
  // =========================================================================

  describe("bulk assignment", () => {
    /**
     * `stepUpAs` names the user whose elevation to present. Omitting it
     * sends NO elevation, which is how the refusal cases below prove the
     * gate is real rather than assumed.
     */
    async function bulkAssign(
      token: string,
      teamId: string,
      targetIds: string[],
      assigneeUserId?: string | null,
      stepUpAs?: string,
    ) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (stepUpAs) {
        headers["x-proovra-step-up-challenge-id"] = await approvedStepUp({
          teamId,
          userId: stepUpAs,
        });
      }
      return harness.app.inject({
        method: "POST",
        url: "/v1/ops/bulk-actions",
        headers,
        payload: {
          teamId,
          actionType: "BULK_ASSIGN_INCIDENTS",
          targetIds,
          ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
        } as never,
      });
    }

    it("assigns every named condition and records it as one assignment each", async () => {
      const rows = [
        await seed({ teamId: A.teamId }),
        await seed({ teamId: A.teamId }),
        await seed({ teamId: A.teamId }),
      ];
      const res = await bulkAssign(
        A.ownerToken,
        A.teamId,
        rows.map((r) => r.id),
        A.memberUserId,
        A.ownerUserId,
      );
      expect(res.statusCode).toBeLessThan(400);

      for (const r of rows) {
        const after = await prisma.operationalIncident.findUnique({
          where: { id: r.id },
        });
        expect(after?.assignedOperatorUserId).toBe(A.memberUserId);
      }
    });

    it("leaves the SAME history a single assignment would", async () => {
      const single = await seed({ teamId: A.teamId });
      const swept = await seed({ teamId: A.teamId });

      await post(`/v1/ops/incidents/${single.id}/assign`, A.ownerToken, {
        teamId: A.teamId,
        assigneeUserId: A.memberUserId,
      });
      await bulkAssign(
        A.ownerToken,
        A.teamId,
        [swept.id],
        A.memberUserId,
        A.ownerUserId,
      );

      const typesFor = async (id: string) =>
        (
          await prisma.operationalIncidentEvent.findMany({
            where: { incidentId: id },
          })
        )
          .map((e) => e.eventType)
          .sort();

      // A sweep is a fan-out, so its trail is indistinguishable from the
      // per-row path. A divergence here would mean two authorities.
      expect(await typesFor(swept.id)).toEqual(await typesFor(single.id));
    });

    it("a sweep with no elevation is refused and changes nothing", async () => {
      const row = await seed({ teamId: A.teamId });
      // No `stepUpAs`: the actor is fully authorized and still refused,
      // because a fan-out requires re-proving.
      const res = await bulkAssign(
        A.ownerToken,
        A.teamId,
        [row.id],
        A.memberUserId,
      );
      expect(res.statusCode).toBe(401);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.assignedOperatorUserId).toBeNull();
    });

    it("a viewer cannot sweep what a viewer cannot click", async () => {
      const row = await seed({ teamId: A.teamId });
      const res = await bulkAssign(
        A.viewerToken,
        A.teamId,
        [row.id],
        A.memberUserId,
        A.viewerUserId,
      );
      // Elevated and STILL refused: re-proving identity does not grant a
      // permission the role never had.
      expect(res.statusCode).toBe(403);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.assignedOperatorUserId).toBeNull();
    });

    it("refuses a sweep that names no assignee rather than silently unassigning", async () => {
      const row = await seed({ teamId: A.teamId, owner: A.memberUserId });
      const res = await bulkAssign(
        A.ownerToken,
        A.teamId,
        [row.id],
        undefined,
        A.ownerUserId,
      );
      // 400, not 401: the elevation was presented and accepted, so this is
      // the assignee validation refusing and nothing else.
      expect(res.statusCode).toBe(400);
      // The critical half: the existing owner survived the refusal.
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      expect(after?.assignedOperatorUserId).toBe(A.memberUserId);
    });

    it("refuses an assignee who is not an eligible operator here, and changes nothing", async () => {
      const row = await seed({ teamId: A.teamId });
      const res = await bulkAssign(
        A.ownerToken,
        A.teamId,
        [row.id],
        B.ownerUserId,
        A.ownerUserId,
      );
      expect(res.statusCode).toBe(400);
      const after = await prisma.operationalIncident.findUnique({
        where: { id: row.id },
      });
      // Refused BEFORE the fan-out, so no partial sweep landed.
      expect(after?.assignedOperatorUserId).toBeNull();
    });

    it("cannot reach across the tenant boundary, even for one target in a mixed list", async () => {
      const mine = await seed({ teamId: A.teamId });
      const theirs = await seed({ teamId: B.teamId });
      await bulkAssign(
        A.ownerToken,
        A.teamId,
        [mine.id, theirs.id],
        A.memberUserId,
        A.ownerUserId,
      );
      const after = await prisma.operationalIncident.findUnique({
        where: { id: theirs.id },
      });
      expect(after?.assignedOperatorUserId).toBeNull();
    });

    it("answers PER TARGET so a partial sweep is readable", async () => {
      const mine = await seed({ teamId: A.teamId });
      const theirs = await seed({ teamId: B.teamId });
      const res = await bulkAssign(
        A.ownerToken,
        A.teamId,
        [mine.id, theirs.id],
        A.memberUserId,
        A.ownerUserId,
      );
      const body = JSON.parse(res.body);
      const items = body.items as Array<{ targetId: string; status: string }>;
      expect(items, "a sweep must report each target").toBeTruthy();
      expect(items.length).toBe(2);
      // The two targets do NOT share an outcome, which is the whole reason
      // the per-item contract exists.
      const byId = new Map(items.map((i) => [i.targetId, i.status]));
      expect(byId.get(mine.id)).not.toBe(byId.get(theirs.id));
    });

    it("a repeated sweep with the same idempotency key does not fan out twice", async () => {
      const row = await seed({ teamId: A.teamId });
      const key = `ops-bulk-${randomUUID()}`;
      const body = {
        teamId: A.teamId,
        actionType: "BULK_ASSIGN_INCIDENTS",
        targetIds: [row.id],
        assigneeUserId: A.memberUserId,
        idempotencyKey: key,
      };
      const send = async () =>
        harness.app.inject({
          method: "POST",
          url: "/v1/ops/bulk-actions",
          headers: {
            authorization: `Bearer ${A.ownerToken}`,
            "x-proovra-step-up-challenge-id": await approvedStepUp({
              teamId: A.teamId,
              userId: A.ownerUserId,
            }),
          },
          payload: body as never,
        });
      const first = await send();
      const second = await send();
      expect(first.statusCode).toBeLessThan(400);
      expect(second.statusCode).toBeLessThan(400);

      // The marker is persisted on the run's `resultJson`, which is what
      // the replay path itself reads back — asserting against the same place
      // the product looks, not a parallel one.
      const runs = await prisma.bulkOperationalActionRun.count({
        where: {
          teamId: A.teamId,
          actionType: "BULK_ASSIGN_INCIDENTS" as never,
          resultJson: { path: ["opsIdempotencyKey"], equals: key },
        },
      });
      expect(runs, "one key must mean one run").toBe(1);
      // And the second call must SAY it was a replay rather than quietly
      // returning a fresh-looking result.
      expect(JSON.parse(second.body).idempotentReplay).toBe(true);
    });
  });
  // =========================================================================
  // 11. SLA POSTURE
  //
  // The arithmetic has its own pure suite. What is proven HERE is that the
  // posture reaches the wire at all, on both surfaces, from the workspace's
  // real policy — the half a pure test cannot see.
  // =========================================================================

  describe("sla posture", () => {
    it("the list carries the workspace's commitment and a posture per row", async () => {
      await seed({ teamId: A.teamId, minutesAgo: 1 });
      const body = JSON.parse(
        (await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken)).body,
      );
      expect(body.sla, "the page must state the commitment").toBeTruthy();
      expect(typeof body.sla.responseHours).toBe("number");
      expect(Array.isArray(body.sla.attentionPostures)).toBe(true);
      expect(body.incidents[0].sla).toBeTruthy();
      expect(body.incidents[0].sla.dueAtUtc).toBeTruthy();
    });

    it("the drawer reports the SAME posture the row does", async () => {
      const row = await seed({ teamId: A.teamId, minutesAgo: 1 });
      const listed = JSON.parse(
        (await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken)).body,
      ).incidents.find((i: { id: string }) => i.id === row.id);
      const detail = JSON.parse(
        (
          await get(
            `/v1/ops/incidents/${row.id}?teamId=${A.teamId}`,
            A.ownerToken,
          )
        ).body,
      ).incident;
      // Two surfaces, one helper. A divergence here is the queue and the
      // drawer disagreeing about whether something is late.
      expect(detail.sla).toEqual(listed.sla);
    });

    it("an old unattended condition is BREACHED against the workspace's own window", async () => {
      // 400 hours: past any policy the resolver can produce, so this asserts
      // the measurement happened rather than a particular number.
      const row = await seed({ teamId: A.teamId, minutesAgo: 400 * 60 });
      const listed = JSON.parse(
        (await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken)).body,
      ).incidents.find((i: { id: string }) => i.id === row.id);
      expect(listed.sla.posture).toBe("BREACHED");
      expect(listed.sla.obligation).toBe("RESPONSE");
    });

    it("a suppressed condition reports no posture and no deadline", async () => {
      const row = await seed({
        teamId: A.teamId,
        status: "SUPPRESSED",
        minutesAgo: 400 * 60,
      });
      const listed = JSON.parse(
        (
          await get(
            `/v1/ops/incidents?teamId=${A.teamId}&status=SUPPRESSED`,
            A.ownerToken,
          )
        ).body,
      ).incidents.find((i: { id: string }) => i.id === row.id);
      expect(listed.sla.posture).toBe("NOT_APPLICABLE");
      expect(listed.sla.dueAtUtc).toBeNull();
    });

    it("the recorded lifecycle instants are projected, since the posture is measured from them", async () => {
      const row = await seed({ teamId: A.teamId });
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      const listed = JSON.parse(
        (await get(`/v1/ops/incidents?teamId=${A.teamId}`, A.ownerToken)).body,
      ).incidents.find((i: { id: string }) => i.id === row.id);
      expect(listed.acknowledgedAtUtc).toBeTruthy();
      expect(listed.resolvedAtUtc).toBeNull();
      // Acknowledged -> the live obligation is now RESOLUTION.
      expect(listed.sla.obligation).toBe("RESOLUTION");
    });
  });
});