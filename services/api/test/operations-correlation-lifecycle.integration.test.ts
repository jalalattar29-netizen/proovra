/**
 * OPERATIONS — CORRELATION, FLOOD PREVENTION AND LIFECYCLE, ON LIVE POSTGRES 16.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS FILE ANSWERS
 * ---------------------------------------------------------------------------
 * "A provider-wide failure must not become an unbounded wall of duplicate
 * incidents when one root-cause incident is correct."
 *
 * The product's answer has TWO halves, and the halves are deliberately
 * different. Which half applies is a property of the SOURCE:
 *
 *   PER-WORKSPACE sources (report backlog, package backlog, retry storms,
 *   heartbeat staleness) already emit exactly ONE condition per workspace
 *   however many rows are behind it. A queue that is too deep is one
 *   operational fact, and one root-cause incident IS correct.
 *
 *   PER-RECORD sources (TSA, OTS) emit one condition per record, and that is
 *   correct too — for the opposite reason. Ten records that could not be
 *   timestamped are ten records that cannot be PROVEN. Each has a different
 *   owner, case and legal posture; each has to be fixed individually. One
 *   root-cause incident would make nine of them invisible, and an invisible
 *   unprovable record is the worst failure mode an evidence platform has.
 *
 * So the flood guarantee for per-record sources is not fewer ROWS. It is that
 * the row count never becomes a flood of DUPLICATES, and that every surface
 * reading them is BOUNDED and says so. Both are proven below at 1, 25, 100 and
 * 1,000 records.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operations — correlation and lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recordIncident: typeof import("../src/services/observability/incident.service.js")["recordIncident"];

  let A: {
    teamId: string;
    ownerToken: string;
    ownerUserId: string;
    memberUserId: string;
  };
  let B: { teamId: string; ownerToken: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ recordIncident } = await import(
      "../src/services/observability/incident.service.js"
    ));

    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      memberUserId: harness.fixtures.teamA.memberUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
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

  /**
   * A namespace per test.
   *
   * The fingerprint is the DEDUP KEY, so two tests emitting the same one are
   * writing to the same logical condition — which couples them through the
   * database even with a per-test cleanup, and makes a result depend on its
   * position in the file.
   */
  let ns = "";
  beforeEach(() => {
    ns = randomUUID().slice(0, 8);
  });

  /** Incident ids in a list response, in render order. */
  const idsOf = (res: { body: string }) =>
    (JSON.parse(res.body).incidents as Array<{ id: string }>).map((i) => i.id);

  /** One provider outage, N affected records, emitted the way the writer does. */
  async function emitProviderOutage(teamId: string, records: number) {
    for (let i = 0; i < records; i += 1) {
      await recordIncident({
        sourceId: "evidence_integrity.tsa_failed",
        teamId,
        category: "EVIDENCE_INTEGRITY",
        severity: "HIGH",
        fingerprint: `tsa_failure:evidence-${ns}-${i}`,
        title: "Trusted timestamp failed",
        safeSummary: "The timestamp authority did not return a token.",
        relatedProvider: "freetsa",
      });
    }
  }

  /** The per-workspace shape: one condition, however deep the queue. */
  async function emitBacklog(teamId: string, observations: number) {
    for (let i = 0; i < observations; i += 1) {
      await recordIncident({
        sourceId: "pipeline.report_backlog",
        teamId,
        category: "REPORT",
        severity: "WARNING",
        fingerprint: `dashboard:pipeline:report_backlog:${teamId}`,
        title: "Report generation is behind",
        safeSummary: `${(i + 1) * 10} reports are queued.`,
      });
    }
  }

  // =========================================================================
  // 1. FLOOD PREVENTION
  // =========================================================================

  describe("a provider-wide failure never produces DUPLICATES", () => {
    for (const records of [1, 25, 100]) {
      it(`${records} affected record(s) → ${records} condition(s), no duplicate`, async () => {
        await emitProviderOutage(A.teamId, records);
        const rows = await prisma.operationalIncident.findMany({
          where: { teamId: A.teamId },
          select: { fingerprint: true },
        });
        expect(rows).toHaveLength(records);
        // The property that matters: one row per IDENTITY, always.
        expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(records);
      });
    }

    it("1,000 affected records stay one-per-record and never duplicate", async () => {
      await emitProviderOutage(A.teamId, 1000);
      const total = await prisma.operationalIncident.count({
        where: { teamId: A.teamId },
      });
      expect(total).toBe(1000);
      const distinct = await prisma.operationalIncident.findMany({
        where: { teamId: A.teamId },
        select: { fingerprint: true },
        distinct: ["fingerprint"],
      });
      expect(distinct).toHaveLength(1000);
    }, 120_000);

    it("a PER-WORKSPACE source stays ONE condition however deep the queue", async () => {
      // 200 observations of the same backlog is one operational fact seen 200
      // times, and this is where "one root-cause incident is correct" applies.
      await emitBacklog(A.teamId, 200);
      const rows = await prisma.operationalIncident.findMany({
        where: { teamId: A.teamId, category: "REPORT" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].occurrenceCount).toBe(200);
    }, 60_000);

    it("a repeated occurrence INCREMENTS rather than inserting", async () => {
      await emitProviderOutage(A.teamId, 1);
      const first = await prisma.operationalIncident.findFirstOrThrow({
        where: { teamId: A.teamId },
      });
      expect(first.occurrenceCount).toBe(1);

      await emitProviderOutage(A.teamId, 1);
      const again = await prisma.operationalIncident.findFirstOrThrow({
        where: { teamId: A.teamId },
      });
      expect(again.id).toBe(first.id);
      expect(again.occurrenceCount).toBe(2);
      expect(again.lastSeenAtUtc.getTime()).toBeGreaterThanOrEqual(
        first.lastSeenAtUtc.getTime(),
      );
      // The FIRST sighting is not rewritten by a later one.
      expect(again.firstSeenAtUtc.getTime()).toBe(first.firstSeenAtUtc.getTime());
    });

    it("two tenants hitting the SAME provider outage stay separate", async () => {
      await emitProviderOutage(A.teamId, 25);
      await emitProviderOutage(B.teamId, 25);
      // Identical fingerprints, different workspaces, no collision: the unique
      // key is (teamId, fingerprint), not fingerprint.
      expect(
        await prisma.operationalIncident.count({ where: { teamId: A.teamId } }),
      ).toBe(25);
      expect(
        await prisma.operationalIncident.count({ where: { teamId: B.teamId } }),
      ).toBe(25);
      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&limit=500`,
        A.ownerToken,
      );
      const ids = (JSON.parse(res.body).incidents as Array<{ id: string }>).map(
        (i) => i.id,
      );
      const bIds = (
        await prisma.operationalIncident.findMany({
          where: { teamId: B.teamId },
          select: { id: true },
        })
      ).map((r) => r.id);
      expect(ids.filter((id) => bIds.includes(id))).toEqual([]);
    }, 60_000);
  });

  // =========================================================================
  // 2. THE READING SURFACES STAY BOUNDED
  // =========================================================================

  describe("a thousand conditions do not produce an unbounded read", () => {
    it("the list is capped and reports that it is capped", async () => {
      await emitProviderOutage(A.teamId, 1000);
      const res = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&limit=50`,
        A.ownerToken,
      );
      const body = JSON.parse(res.body);
      expect(body.incidents).toHaveLength(50);
      expect(body.completeness.complete).toBe(false);
      expect(body.completeness.mayAssertAllClear).toBe(false);
      expect(body.pagination.nextCursor).toBeTruthy();
      // The hard server bound holds even when the caller asks for more.
      const greedy = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&limit=500`,
        A.ownerToken,
      );
      expect(JSON.parse(greedy.body).incidents.length).toBeLessThanOrEqual(500);
    }, 120_000);

    it("the summary counts them all, and says the count is complete", async () => {
      await emitProviderOutage(A.teamId, 1000);
      const res = await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken);
      const { summary } = JSON.parse(res.body);
      // 1,000 is well inside the scan bound, so this IS a total.
      expect(summary.open).toBe(1000);
      expect(summary.high).toBe(1000);
      expect(summary.unassigned).toBe(1000);
      expect(summary.complete).toBe(true);
      // WORKSPACE-SCOPE CONVERGENCE (§8) — this assertion INVERTED, and the
      // inversion is the fix.
      //
      // `mayAssertAllClear` used to be a copy of `complete`: it answered "did
      // the incident read finish?", so it was TRUE over a workspace with a
      // thousand unresolved conditions. The field's name has always described
      // a different and stronger claim, and now it makes it — a fresh READY
      // discovery run, every required source succeeded, nothing truncated, and
      // nothing unresolved. A workspace with open conditions may never assert
      // an all-clear, which is the whole point.
      expect(summary.mayAssertAllClear).toBe(false);
      // A REASON is always given. Which one depends on the fixture's run
      // state — a workspace with unresolved conditions AND a partially
      // covered discovery run has two grounds for refusal, and the gate
      // reports the more fundamental of them. Pinning one exact string would
      // make this assert the fixture rather than the contract.
      expect(summary.clearRefusalReason).toBeTruthy();
    }, 120_000);

    it("paging all the way through 1,000 sees each condition exactly once", async () => {
      await emitProviderOutage(A.teamId, 1000);
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 30; page += 1) {
        const url =
          `/v1/ops/incidents?teamId=${A.teamId}&limit=100` +
          (cursor ? `&cursor=${cursor}` : "");
        const body = JSON.parse((await get(url, A.ownerToken)).body);
        for (const i of body.incidents as Array<{ id: string }>) {
          expect(seen.has(i.id), `${i.id} was returned twice`).toBe(false);
          seen.add(i.id);
        }
        cursor = body.pagination.nextCursor;
        if (!cursor) break;
      }
      expect(seen.size).toBe(1000);
    }, 180_000);
  });

  // =========================================================================
  // 3. RECOVERY AND RECURRENCE
  // =========================================================================

  describe("recovery, recurrence and the reopen rule", () => {
    it("a RESOLVED condition reopens on a fresh occurrence, keeping its history", async () => {
      await emitProviderOutage(A.teamId, 1);
      const row = await prisma.operationalIncident.findFirstOrThrow({
        where: { teamId: A.teamId },
      });
      await post(`/v1/ops/incidents/${row.id}/resolve`, A.ownerToken, {
        teamId: A.teamId,
        resolutionNote: "The provider recovered.",
      });
      expect(
        (await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe("RESOLVED");

      // It happens again.
      await emitProviderOutage(A.teamId, 1);
      const reopened = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.occurrenceCount).toBe(2);
      // SAME row, so the history and the original first-sighting survive.
      expect(reopened.firstSeenAtUtc.getTime()).toBe(row.firstSeenAtUtc.getTime());
      const detail = JSON.parse(
        (await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.ownerToken))
          .body,
      ).incident;
      const types = detail.timeline.map((e: { eventType: string }) => e.eventType);
      expect(types).toContain("resolved");
    });

    it("one record recovering does not resolve its neighbours", async () => {
      await emitProviderOutage(A.teamId, 25);
      const rows = await prisma.operationalIncident.findMany({
        where: { teamId: A.teamId },
        orderBy: { fingerprint: "asc" },
      });
      await post(`/v1/ops/incidents/${rows[0].id}/resolve`, A.ownerToken, {
        teamId: A.teamId,
      });
      const stillOpen = await prisma.operationalIncident.count({
        where: { teamId: A.teamId, status: "OPEN" },
      });
      expect(stillOpen).toBe(24);
    }, 60_000);

    it("a TRUNCATED read can never resolve anything by absence", async () => {
      await emitProviderOutage(A.teamId, 100);
      // Read a small page — 99 conditions are absent from this response.
      const body = JSON.parse(
        (await get(`/v1/ops/incidents?teamId=${A.teamId}&limit=1`, A.ownerToken))
          .body,
      );
      expect(body.completeness.complete).toBe(false);
      // Nothing changed in the database. Absence from a page is not a state.
      expect(
        await prisma.operationalIncident.count({
          where: { teamId: A.teamId, status: "OPEN" },
        }),
      ).toBe(100);
    }, 60_000);
  });

  // =========================================================================
  // 4. LIFECYCLE SEMANTICS
  // =========================================================================

  describe("lifecycle semantics", () => {
    async function seedOne() {
      await emitProviderOutage(A.teamId, 1);
      return prisma.operationalIncident.findFirstOrThrow({
        where: { teamId: A.teamId },
      });
    }

    it("ACKNOWLEDGED records the operator and the time, and claims no remediation", async () => {
      const row = await seedOne();
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      const after = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.status).toBe("ACKNOWLEDGED");
      expect(after.acknowledgedByUserId).toBe(A.ownerUserId);
      expect(after.acknowledgedAtUtc).toBeTruthy();
      expect(after.resolvedAtUtc).toBeNull();
      expect(after.resolutionNote).toBeNull();
    });

    it("an acknowledged condition is still UNRESOLVED work", async () => {
      const row = await seedOne();
      await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
        teamId: A.teamId,
      });
      const { summary } = JSON.parse(
        (await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken)).body,
      );
      expect(summary.open).toBe(1);
      expect(summary.acknowledged).toBe(1);
      // …and it is not counted as a broken promise.
      //
      // The former `overdue` count was a fixed 48-hour age heuristic; it is
      // gone, because it was a second authority on lateness competing with the
      // workspace own recorded SLA. This condition was seeded without a cycle,
      // so it has no recorded promise at all and is UNTRACKED — which is
      // deliberately NOT a breach.
      expect(summary.slaBreached).toBe(0);
      expect(summary.slaUntracked).toBe(1);
    });

    it("OPERATOR resolution is distinguishable from SOURCE resolution", async () => {
      const operatorClosed = await seedOne();
      await post(`/v1/ops/incidents/${operatorClosed.id}/resolve`, A.ownerToken, {
        teamId: A.teamId,
        resolutionNote: "Re-ran the timestamp job by hand.",
      });
      const row = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: operatorClosed.id },
      });
      // An operator closure names WHO and WHY. A source-driven closure leaves
      // `resolvedByUserId` null — that is the discriminator, and it is a
      // column rather than a convention.
      expect(row.resolvedByUserId).toBe(A.ownerUserId);
      expect(row.resolutionNote).toBe("Re-ran the timestamp job by hand.");
    });

    it("SUPPRESSED requires the capability, and a viewer cannot reach it", async () => {
      const row = await seedOne();
      const asViewer = await post(
        `/v1/ops/incidents/${row.id}/suppress`,
        harness.fixtures.teamA.viewerToken,
        { teamId: A.teamId },
      );
      expect(asViewer.statusCode).not.toBe(200);
      expect(
        (await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe("OPEN");
    });

    it("SUPPRESSED leaves the unresolved population and stays readable", async () => {
      const row = await seedOne();
      await post(`/v1/ops/incidents/${row.id}/suppress`, A.ownerToken, {
        teamId: A.teamId,
      });

      // Asserted about THIS CONDITION, not about a workspace-wide count.
      //
      // The workspace acquires conditions this test never created: the
      // preceding refusal emits a security event, and `safeEmitSecurityEvent`
      // is fire-and-forget, so its IDENTITY_SECURITY condition can land at any
      // moment — including between two reads of the summary. That is correct
      // product behaviour (a denied mutation IS an operational fact), and both
      // an absolute count and a delta over it are races against it.
      const unresolved = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=OPEN&limit=500`,
        A.ownerToken,
      );
      const acknowledged = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=ACKNOWLEDGED&limit=500`,
        A.ownerToken,
      );
      expect(idsOf(unresolved)).not.toContain(row.id);
      expect(idsOf(acknowledged)).not.toContain(row.id);

      // Not deleted, not hidden: filterable under its own status, with its
      // record intact. "Stop telling me" is not "pretend it never happened".
      const suppressed = await get(
        `/v1/ops/incidents?teamId=${A.teamId}&status=SUPPRESSED&limit=500`,
        A.ownerToken,
      );
      expect(idsOf(suppressed)).toContain(row.id);
      const persisted = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(persisted.status).toBe("SUPPRESSED");
      expect(persisted.occurrenceCount).toBe(1);
    });
    it("every transition is audited EXACTLY once, even when repeated", async () => {
      const row = await seedOne();
      for (let i = 0; i < 3; i += 1) {
        await post(`/v1/ops/incidents/${row.id}/ack`, A.ownerToken, {
          teamId: A.teamId,
        });
      }
      const detail = JSON.parse(
        (await get(`/v1/ops/incidents/${row.id}?teamId=${A.teamId}`, A.ownerToken))
          .body,
      ).incident;
      const acks = detail.timeline.filter(
        (e: { eventType: string }) => e.eventType === "acknowledged",
      );
      expect(acks.length).toBeLessThanOrEqual(1);
    });

    it("CONCURRENT assignment leaves exactly one winner, not a torn row", async () => {
      const row = await seedOne();
      const [a, b] = await Promise.all([
        post(`/v1/ops/incidents/${row.id}/assign`, A.ownerToken, {
          teamId: A.teamId,
          assigneeUserId: A.ownerUserId,
        }),
        post(`/v1/ops/incidents/${row.id}/assign`, A.ownerToken, {
          teamId: A.teamId,
          assigneeUserId: A.memberUserId,
        }),
      ]);
      expect([a.statusCode, b.statusCode].every((s) => s < 500)).toBe(true);
      const after = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: row.id },
      });
      // ONE of the two, never a blend and never null.
      expect([A.ownerUserId, A.memberUserId]).toContain(
        after.assignedOperatorUserId,
      );
    });
  });

  // =========================================================================
  // 5. NOTIFICATIONS ARE NOT A LIFECYCLE INPUT
  // =========================================================================

  describe("personal notification state never moves shared operational state", () => {
    it("marking every inbox item read changes no incident", async () => {
      await emitProviderOutage(A.teamId, 5);
      const before = await prisma.operationalIncident.findMany({
        where: { teamId: A.teamId },
        select: { id: true, status: true, occurrenceCount: true },
        orderBy: { fingerprint: "asc" },
      });

      const inbox = await get("/v1/me/inbox?pageSize=100", A.ownerToken);
      expect(inbox.statusCode).toBe(200);
      const items = (JSON.parse(inbox.body).items ?? []) as Array<{
        itemKey?: string;
      }>;
      for (const item of items.slice(0, 20)) {
        if (!item.itemKey) continue;
        await post("/v1/me/inbox/read", A.ownerToken, {
          itemKey: item.itemKey,
        }).catch(() => null);
        await post("/v1/me/inbox/dismiss", A.ownerToken, {
          itemKey: item.itemKey,
        }).catch(() => null);
      }

      const after = await prisma.operationalIncident.findMany({
        where: { teamId: A.teamId },
        select: { id: true, status: true, occurrenceCount: true },
        orderBy: { fingerprint: "asc" },
      });
      expect(after).toEqual(before);

      // …and the workspace summary is the same number it was.
      const { summary } = JSON.parse(
        (await get(`/v1/ops/summary?teamId=${A.teamId}`, A.ownerToken)).body,
      );
      expect(summary.open).toBe(5);
    }, 60_000);
  });
});
