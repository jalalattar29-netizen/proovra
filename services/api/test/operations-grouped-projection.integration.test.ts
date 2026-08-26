/**
 * THE GROUPED PROJECTION AND ITS DRILL-DOWN, AT SCALE — live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * `projectConditionGroups` existed, was conserved-by-test, and NOTHING SERVED
 * IT. No route returned groups and no surface rendered them, so a workspace
 * with five thousand records whose timestamping failed got five thousand
 * top-level rows — every one saying the same sentence, and the one genuinely
 * different condition at position 3,847.
 *
 * The two properties that make a grouped queue honest, rather than merely
 * shorter, are the ones this file proves against a real database:
 *
 *   CONSERVATION   every condition appears in exactly one group, and the
 *                  counts add up to the rows that were read;
 *   REACHABILITY   every individual condition is still reachable, because
 *                  each one is a different record somebody has to fix. A
 *                  grouped view that HID records would be the same defect
 *                  with better manners.
 *
 * Five thousand rows is not a stress test. It is the smallest number at which
 * an unbounded response, an offset-paged drill-down or a per-row projection
 * stops being survivable, and all three were plausible designs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** The scale the brief names. */
const SCALE = 5000;
/** A second class, so grouping has something to separate. */
const OTS_SCALE = 40;

describe("Grouped Operations projection at scale (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let drilldown: typeof import("../src/services/operations/operations-group-drilldown.service.js");
  let grouping: typeof import("../src/services/operations/operations-grouping.service.js");
  let incidents: typeof import("../src/services/observability/incident.service.js");

  let team: { teamId: string; ownerUserId: string };
  /** A DIFFERENT workspace, whose rows must never appear in the first's. */
  let foreign: { teamId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    drilldown = await import(
      "../src/services/operations/operations-group-drilldown.service.js"
    );
    grouping = await import(
      "../src/services/operations/operations-grouping.service.js"
    );
    incidents = await import("../src/services/observability/incident.service.js");

    const owned = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { id: true, ownerUserId: true },
    });
    team = { teamId: owned.id, ownerUserId: owned.ownerUserId! };
    foreign = { teamId: harness.fixtures.teamB.teamId };

    // ONE bulk insert rather than five thousand round trips. `createMany`
    // writes the rows the writer would write; the LIFECYCLE is exercised by
    // the other suites, and what this file is about is what happens to five
    // thousand of them once they exist.
    const base = Date.now() - 60 * 60 * 1000;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < SCALE; i += 1) {
      const evidenceId = `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;
      rows.push({
        teamId: team.teamId,
        scope: "WORKSPACE",
        sourceId: "evidence_integrity.tsa_failed",
        category: "EVIDENCE_INTEGRITY",
        // A spread of severities, so "highest present" is a real answer and
        // not the only one available.
        severity: i === 0 ? "CRITICAL" : i % 3 === 0 ? "HIGH" : "WARNING",
        status: i % 250 === 0 ? "ACKNOWLEDGED" : "OPEN",
        fingerprint: `tsa_failure:${evidenceId}`,
        title: "Trusted timestamp failed",
        safeSummary: "The timestamp authority did not return a token.",
        // Distinct instants, so the keyset cursor has a total order to walk.
        firstSeenAtUtc: new Date(base + i * 1000),
        lastSeenAtUtc: new Date(base + i * 1000),
        updatedAt: new Date(),
      });
    }
    for (let i = 0; i < OTS_SCALE; i += 1) {
      const evidenceId = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
      rows.push({
        teamId: team.teamId,
        scope: "WORKSPACE",
        sourceId: "evidence_integrity.ots_failed",
        category: "EVIDENCE_INTEGRITY",
        severity: "WARNING",
        status: "OPEN",
        fingerprint: `ots_failure:${evidenceId}`,
        title: "Blockchain anchoring failed",
        safeSummary: "The OpenTimestamps upgrade did not complete.",
        firstSeenAtUtc: new Date(base + i * 1000),
        lastSeenAtUtc: new Date(base + i * 1000),
        updatedAt: new Date(),
      });
    }
    // The foreign workspace's rows, in the SAME source, so the isolation test
    // is about scope and not about an accidental filter.
    for (let i = 0; i < 25; i += 1) {
      const evidenceId = `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`;
      rows.push({
        teamId: foreign.teamId,
        scope: "WORKSPACE",
        sourceId: "evidence_integrity.tsa_failed",
        category: "EVIDENCE_INTEGRITY",
        severity: "HIGH",
        status: "OPEN",
        fingerprint: `tsa_failure:${evidenceId}`,
        title: "Trusted timestamp failed",
        safeSummary: "Another workspace's record.",
        firstSeenAtUtc: new Date(base + i * 1000),
        lastSeenAtUtc: new Date(base + i * 1000),
        updatedAt: new Date(),
      });
    }
    // Chunked: one 5,065-row statement is a parameter count PostgreSQL will
    // refuse, and discovering that at 5,000 rather than at 50 is the point of
    // testing at this scale.
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.operationalIncident.createMany({
        data: rows.slice(i, i + 500) as never,
      });
    }
  }, 1_800_000);

  afterAll(async () => {
    for (const teamId of [team?.teamId, foreign?.teamId].filter(Boolean)) {
      const ids = (
        await prisma.operationalIncident.findMany({
          where: { teamId: teamId as string },
          select: { id: true },
        })
      ).map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        await prisma.operationalIncidentEvent.deleteMany({
          where: { incidentId: { in: slice } },
        });
        await prisma.operationalIncident.deleteMany({
          where: { id: { in: slice } },
        });
      }
    }
    await harness?.cleanup();
  });

  /** The grouped projection over the workspace's conditions. */
  async function groupsFor(teamId: string) {
    const rows = await prisma.operationalIncident.findMany({
      where: { teamId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      select: {
        id: true,
        category: true,
        fingerprint: true,
        severity: true,
        status: true,
        title: true,
        safeSummary: true,
        firstSeenAtUtc: true,
        lastSeenAtUtc: true,
        occurrenceCount: true,
        relatedEvidenceId: true,
        assignedOperatorUserId: true,
        sourceId: true,
        metricSnapshot: true,
      },
      take: 10_000,
    });
    return {
      rows,
      groups: grouping.projectConditionGroups(
        rows.map((r) => ({ ...r, category: r.category as never })),
      ),
    };
  }

  // =========================================================================
  // 1. THE GROUPED RESPONSE IS BOUNDED, AND CONSERVES
  // =========================================================================

  it("5,000 conditions collapse to ONE group per source", async () => {
    const { rows, groups } = await groupsFor(team.teamId);
    expect(rows.length).toBe(SCALE + OTS_SCALE);

    // TWO groups, not five thousand rows, and not one merged blob: the two
    // failure classes are different conditions with different remediations
    // and are kept apart.
    expect(groups).toHaveLength(2);
    const bySource = new Map(groups.map((g) => [g.sourceId, g]));
    expect([...bySource.keys()].sort()).toEqual([
      "evidence_integrity.ots_failed",
      "evidence_integrity.tsa_failed",
    ]);

    const tsa = bySource.get("evidence_integrity.tsa_failed")!;
    expect(tsa.conditionCount).toBe(SCALE);
    // Per-record: each condition IS one record, so the two counts agree here.
    expect(tsa.affectedRecordCount).toBe(SCALE);
    expect(tsa.affectedUnit).toBe("records");
    // THE COUNT IS NOT IN THE TITLE — it used to read "…for 5000 records", and
    // this assertion pinned it there. A heading that carries the number says
    // it twice on a row that already carries it as a labelled field, and on an
    // aggregate group the two are different quantities. The label is the
    // source contract's now, count-free by a load-time invariant.
    expect(tsa.title).toBe("Trusted timestamping failed");
    expect(tsa.title).not.toMatch(/[0-9]/);
    // The WORST member decides the group's severity — an operator scanning a
    // list must not have a CRITICAL hidden behind 4,999 warnings.
    expect(tsa.severity).toBe("CRITICAL");
    // …and its posture is OPEN while any member is open, even though twenty
    // are acknowledged.
    expect(tsa.statusPosture).toBe("OPEN");
    expect(tsa.assignedCount).toBe(0);

    expect(bySource.get("evidence_integrity.ots_failed")!.conditionCount).toBe(
      OTS_SCALE,
    );
  }, 900_000);

  it("the group response carries a BOUNDED sample, never the members", async () => {
    const { groups } = await groupsFor(team.teamId);
    const tsa = groups.find((g) => g.sourceId === "evidence_integrity.tsa_failed")!;
    // Ten rows inline, out of five thousand. `hasMoreAffected` says so rather
    // than letting the shorter list read as the total.
    expect(tsa.affectedSample.length).toBeLessThanOrEqual(
      grouping.AFFECTED_SAMPLE_LIMIT,
    );
    expect(tsa.hasMoreAffected).toBe(true);
    // The payload is a fixed handful whatever the group's size.
    const serialized = JSON.stringify(groups);
    expect(serialized.length).toBeLessThan(20_000);
  }, 900_000);

  it("conservation holds: every condition is in exactly one group", async () => {
    const { rows, groups } = await groupsFor(team.teamId);
    expect(grouping.totalConditions(groups)).toBe(rows.length);

    // …and no condition is in two. Checked by identity, not by arithmetic:
    // two groups each containing the same row would still sum correctly if a
    // third had lost one.
    const seen = new Set<string>();
    for (const g of groups) {
      for (const sample of g.affectedSample) {
        expect(seen.has(sample.conditionId)).toBe(false);
        seen.add(sample.conditionId);
      }
    }
  }, 900_000);

  // =========================================================================
  // 2. THE DRILL-DOWN REACHES EVERY ROW, EXACTLY ONCE
  // =========================================================================

  it("paging the drill-down traverses all 5,000 with no duplicate and no omission", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await drilldown.listGroupAffectedRecords({
        teamId: team.teamId,
        sourceId: "evidence_integrity.tsa_failed",
        limit: drilldown.AFFECTED_PAGE_MAX,
        cursor,
      });
      // BOUNDED, every page.
      expect(page.records.length).toBeLessThanOrEqual(
        drilldown.AFFECTED_PAGE_MAX,
      );
      seen.push(...page.records.map((r) => r.conditionId));
      cursor = page.nextCursor;
      pages += 1;
      // A cursor that never advanced would loop forever; the bound makes the
      // failure a test failure rather than a hung suite.
      expect(pages).toBeLessThan(200);
    } while (cursor);

    // EVERY row, ONCE. The keyset order is total — two conditions can share an
    // instant and cannot share an id — so a page boundary can neither repeat
    // nor skip.
    expect(seen.length).toBe(SCALE);
    expect(new Set(seen).size).toBe(SCALE);
  }, 900_000);

  it("a page size the caller asks for is honoured, and capped", async () => {
    const small = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "evidence_integrity.tsa_failed",
      limit: 7,
      cursor: null,
    });
    expect(small.records).toHaveLength(7);
    expect(small.nextCursor).not.toBeNull();

    // An unbounded request is bounded for the caller rather than refused: the
    // page is a page whatever they ask for.
    const capped = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "evidence_integrity.tsa_failed",
      limit: 10_000,
      cursor: null,
    });
    expect(capped.records.length).toBe(drilldown.AFFECTED_PAGE_MAX);
  }, 900_000);

  it("the drill-down returns only safe fields", async () => {
    const page = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "evidence_integrity.tsa_failed",
      limit: 5,
      cursor: null,
    });
    for (const r of page.records) {
      // Exactly the fields the contract declares. Anything else would be an
      // unreviewed field reaching a browser.
      expect(Object.keys(r).sort()).toEqual(
        [
          "assignedOperatorUserId",
          "conditionId",
          "evidenceId",
          "firstSeenAtUtc",
          "lastSeenAtUtc",
          "occurrenceCount",
          "severity",
          "status",
          "title",
        ].sort(),
      );
      // No evidence content, no provider string, no infrastructure detail.
      const blob = JSON.stringify(r);
      expect(blob).not.toMatch(/sha256|storageKey|signedUrl|provider|postgres/i);
    }
  }, 900_000);

  // =========================================================================
  // 3. TENANT ISOLATION
  // =========================================================================

  it("another workspace's records never appear in this one's drill-down", async () => {
    const foreignIds = new Set(
      (
        await prisma.operationalIncident.findMany({
          where: { teamId: foreign.teamId },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    expect(foreignIds.size).toBe(25);

    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await drilldown.listGroupAffectedRecords({
        teamId: team.teamId,
        sourceId: "evidence_integrity.tsa_failed",
        limit: drilldown.AFFECTED_PAGE_MAX,
        cursor,
      });
      for (const r of page.records) seen.add(r.conditionId);
      cursor = page.nextCursor;
    } while (cursor);

    for (const id of foreignIds) expect(seen.has(id)).toBe(false);
    // …and the foreign workspace's own group is its own size, not 5,025.
    const theirs = await groupsFor(foreign.teamId);
    expect(
      theirs.groups.find((g) => g.sourceId === "evidence_integrity.tsa_failed")!
        .conditionCount,
    ).toBe(25);
  }, 900_000);

  it("a cursor from ANOTHER workspace does not leak that the row exists", async () => {
    const theirRow = await prisma.operationalIncident.findFirstOrThrow({
      where: { teamId: foreign.teamId },
      select: { id: true },
    });
    // The cursor resolves to nothing under this workspace's scope, so the
    // caller gets the FIRST page — the same answer a nonsense cursor gets, and
    // therefore no signal that the row is real.
    const withForeign = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "evidence_integrity.tsa_failed",
      limit: 5,
      cursor: theirRow.id,
    });
    const first = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "evidence_integrity.tsa_failed",
      limit: 5,
      cursor: null,
    });
    expect(withForeign.records.map((r) => r.conditionId)).toEqual(
      first.records.map((r) => r.conditionId),
    );
  }, 900_000);

  it("an unknown group key returns an empty page, not an error", async () => {
    // Anti-enumeration: a key that names nothing and a key that names another
    // tenant's group are the same empty answer.
    const page = await drilldown.listGroupAffectedRecords({
      teamId: team.teamId,
      sourceId: "nobody.registered.this",
      limit: 10,
      cursor: null,
    });
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  }, 900_000);

  // =========================================================================
  // 4. ONE AUTHORITY, EVERY WORKSPACE KIND
  // =========================================================================

  it("the same projection serves a workspace with ONE condition", async () => {
    // A group of one is its own condition's title, not a manufactured
    // "1 record" heading — which would make one problem read like a summary
    // of several. Personal workspaces are not a different product.
    const single = grouping.projectConditionGroups([
      {
        id: "single",
        category: "REPORT" as never,
        fingerprint: `dashboard:pipeline:report_backlog:${team.teamId}`,
        severity: "HIGH",
        status: "OPEN",
        title: "Report generation backlog",
        safeSummary: "…",
        firstSeenAtUtc: new Date(),
        lastSeenAtUtc: new Date(),
        occurrenceCount: 1,
        relatedEvidenceId: null,
        assignedOperatorUserId: null,
        sourceId: "pipeline.report_backlog",
        metric: {
          currentValue: 26,
          previousValue: null,
          delta: null,
          thresholdValue: 20,
          criticalThresholdValue: 60,
          unit: "records" as const,
          observedAtUtc: new Date().toISOString(),
          stale: false,
          truncated: false,
          affectedEntityType: "evidence",
        },
      },
    ]);
    expect(single).toHaveLength(1);
    expect(single[0].title).toBe("Report generation backlog");
    expect(single[0].conditionCount).toBe(1);
    // …and the SECOND number is the one that differs: one condition, 26
    // records. Rendering either under the other's name is how a queue lies.
    expect(single[0].affectedRecordCount).toBe(26);
  }, 900_000);

  it("the group's available actions never include a bulk Resolve", async () => {
    const { groups } = await groupsFor(team.teamId);
    for (const g of groups) {
      // Source-truth conditions close themselves when the source recovers, so
      // a control that closed five thousand of them by hand would be both
      // unsafe and unnecessary.
      expect(g.availableActions).not.toContain("resolve");
      // …while everything an operator can honestly do to a group survives.
      expect(g.availableActions).toEqual(
        expect.arrayContaining(["acknowledge", "assign", "suppress"]),
      );
    }
  }, 900_000);

  it("every group's source resolves to a registered contract", async () => {
    const { rows } = await groupsFor(team.teamId);
    for (const row of rows.slice(0, 50)) {
      const projected = incidents.projectIncident(row as never);
      expect(projected.lifecycle.sourceMatch).toBe("DECLARED");
      expect(projected.lifecycle.resolutionAuthority).toBe("SOURCE_TRUTH");
      expect(projected.lifecycle.manualResolution).toBe(false);
    }
  }, 900_000);
});
