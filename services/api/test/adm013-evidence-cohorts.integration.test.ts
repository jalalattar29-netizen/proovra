/**
 * ADM-013 — EVIDENCE HEALTH COHORTS, AGAINST LIVE POSTGRESQL 16.
 *
 * =============================================================================
 * THE ARITHMETIC UNDER TEST
 * =============================================================================
 * The control plane reported "34 TSA failures" and "16 signed without report"
 * side by side, and every reader added them. They are not disjoint: a record
 * whose timestamp failed AND which has no report is in both, and it is ONE
 * record needing attention.
 *
 * A unit test over the predicates would prove the SQL is what somebody wrote.
 * This proves the numbers are what the database returns, by seeding a known
 * population where the right answer is arithmetic rather than opinion:
 *
 *   3 records — timestamp failed only
 *   4 records — signed without a report only
 *   2 records — both
 *
 *   TSA_FAILED_ONLY        3
 *   SIGNED_NO_REPORT_ONLY  4
 *   BOTH                   2
 *   ALL_AFFECTED           9   ← measured with OR, not 3+4+2 by construction
 *
 * and the naive sum an operator would have made from the old two figures is
 * (3+2) + (4+2) = 11, which is the number this projection exists to stop
 * anybody quoting.
 *
 * =============================================================================
 * AND THAT THE TWO HALVES ARE HANDLED DIFFERENTLY
 * =============================================================================
 * A missing report can be regenerated. A missing timestamp cannot — re-asking
 * the authority now would mint a token whose genTime is later than the evidence
 * it certifies. So a single "retry all affected" control would have quietly
 * done nothing for most of what it claimed to fix. The cohort projection reads
 * that disposition from `remediation-registry.ts` rather than deciding it, and
 * the cases below assert the two answers are actually opposite.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("EVIDENCE HEALTH COHORTS (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let buildEvidenceHealthCohorts: typeof import("../src/services/admin/evidence-health-cohorts.service.js")["buildEvidenceHealthCohorts"];
  let listAdminEvidenceRecords: typeof import("../src/services/admin/evidence-records.service.js")["listAdminEvidenceRecords"];

  let teamId: string;
  let organizationId: string;
  let ownerUserId: string;
  const seeded: string[] = [];

  /** The exact seeded population. Every assertion below is arithmetic over it. */
  const TSA_ONLY = 3;
  const REPORT_ONLY = 4;
  const BOTH = 2;

  async function seed(kind: "tsa" | "report" | "both"): Promise<string> {
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        teamId,
        organization: { connect: { id: organizationId } },
        type: "PHOTO",
        ownerUserId,
        uploadedByUserId: ownerUserId,
        status: "SIGNED",
        title: `cohort-${kind}`,
        // A failed timestamp, a missing report, or both. `latestReportVersion`
        // non-null is what makes a SIGNED record NOT "signed without a report".
        tsaStatus: kind === "report" ? "SUCCESS" : "FAILED",
        latestReportVersion: kind === "tsa" ? 1 : null,
      },
    });
    seeded.push(id);
    return id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ buildEvidenceHealthCohorts } = await import(
      "../src/services/admin/evidence-health-cohorts.service.js"
    ));
    ({ listAdminEvidenceRecords } = await import(
      "../src/services/admin/evidence-records.service.js"
    ));

    // `Team.organizationId` is non-nullable in the schema, so there is nothing
    // to filter for — every workspace already carries the organization that
    // Evidence must connect to.
    const team = await prisma.team.findFirst({
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    expect(team, "the harness seeded no workspace to attach evidence to").toBeTruthy();
    teamId = team!.id;
    organizationId = team!.organizationId;
    ownerUserId = team!.ownerUserId;

    // Any evidence the harness already seeded would make the arithmetic below
    // about an unknown population rather than a known one.
    await prisma.evidence.deleteMany({});

    for (let i = 0; i < TSA_ONLY; i += 1) await seed("tsa");
    for (let i = 0; i < REPORT_ONLY; i += 1) await seed("report");
    for (let i = 0; i < BOTH; i += 1) await seed("both");
  }, 300_000);

  afterAll(async () => {
    if (!harness) return;
    try {
      await prisma.evidence.deleteMany({ where: { id: { in: seeded } } });
    } catch {
      /* the harness drops the database anyway */
    }
    await harness.cleanup();
  }, 120_000);

  function count(
    p: Awaited<ReturnType<typeof buildEvidenceHealthCohorts>>,
    cohort: string,
  ): number | null {
    return p.cohorts.find((c) => c.cohort === cohort)?.count ?? null;
  }

  // ==========================================================================
  // The counts.
  // ==========================================================================

  it("counts each disjoint cohort exactly", async () => {
    const p = await buildEvidenceHealthCohorts();
    expect(count(p, "TSA_FAILED_ONLY")).toBe(TSA_ONLY);
    expect(count(p, "SIGNED_NO_REPORT_ONLY")).toBe(REPORT_ONLY);
    expect(count(p, "BOTH")).toBe(BOTH);
  });

  it("measures the union with OR, and it is not the sum of the two totals", async () => {
    const p = await buildEvidenceHealthCohorts();
    const union = count(p, "ALL_AFFECTED");

    expect(union).toBe(TSA_ONLY + REPORT_ONLY + BOTH);

    // The number the old page invited a reader to compute: (tsaTotal) +
    // (reportTotal), where each total already includes the intersection.
    const naiveSum = TSA_ONLY + BOTH + (REPORT_ONLY + BOTH);
    expect(naiveSum).toBe(11);
    expect(
      union,
      "the union equals the naive sum, so this fixture cannot distinguish the two — the seeded intersection must be non-zero",
    ).not.toBe(naiveSum);
  });

  it("checks its own arithmetic and says so", async () => {
    const p = await buildEvidenceHealthCohorts();
    expect(p.arithmetic.disjointSum).toBe(TSA_ONLY + REPORT_ONLY + BOTH);
    expect(p.arithmetic.measuredUnion).toBe(p.arithmetic.disjointSum);
    expect(
      p.arithmetic.agrees,
      "a projection that cannot check its own sum will eventually be wrong quietly",
    ).toBe(true);
  });

  it("names no unavailable cohort when every read succeeded", async () => {
    const p = await buildEvidenceHealthCohorts();
    expect(p.unavailableCohorts).toEqual([]);
    for (const c of p.cohorts) {
      expect(c.count, `${c.cohort} came back null on a healthy read`).not.toBeNull();
    }
  });

  // ==========================================================================
  // Retryability — the two halves are opposite, and read from the registry.
  // ==========================================================================

  it("the report cohort is retryable and the timestamp cohort is not", async () => {
    const p = await buildEvidenceHealthCohorts();
    const report = p.cohorts.find((c) => c.cohort === "SIGNED_NO_REPORT_ONLY")!;
    const tsa = p.cohorts.find((c) => c.cohort === "TSA_FAILED_ONLY")!;

    expect(report.retryable).toBe(true);
    expect(tsa.retryable).toBe(false);
    // And the refusal carries its reason, from the registry rather than from
    // this projection.
    expect(tsa.reason).toBeTruthy();
    expect(tsa.reason).toMatch(/genTime|timestamp/i);
  });

  it("the intersection is NOT presented as retryable", async () => {
    const p = await buildEvidenceHealthCohorts();
    const both = p.cohorts.find((c) => c.cohort === "BOTH")!;
    // A "retry" over this cohort fixes the report half and leaves the
    // timestamp half, which is the shape of misleading control the split
    // exists to prevent.
    expect(both.retryable).toBe(false);
    expect(both.reason).toMatch(/[Pp]artially retryable/);
  });

  it("every cohort carries an operator action and a drill-down", async () => {
    const p = await buildEvidenceHealthCohorts();
    for (const c of p.cohorts) {
      expect(c.operatorAction.length, `${c.cohort} has no action`).toBeGreaterThan(0);
      expect(c.drillDown).toContain(`cohort=${c.cohort}`);
    }
  });

  // ==========================================================================
  // Summary / detail parity.
  // ==========================================================================

  it("every cohort's drill-down returns exactly the records it counted", async () => {
    const p = await buildEvidenceHealthCohorts();
    for (const c of p.cohorts) {
      const list = await listAdminEvidenceRecords({
        cohort: c.cohort,
        page: 1,
        limit: 200,
      });
      expect(
        list.total,
        `${c.cohort}: the tile says ${c.count} and the list says ${list.total} — a card and the page behind it must not disagree`,
      ).toBe(c.count);
    }
  });

  it("a row in the union says which half it is in", async () => {
    const list = await listAdminEvidenceRecords({
      cohort: "ALL_AFFECTED",
      page: 1,
      limit: 200,
    });
    const byCohort = new Map<string, number>();
    for (const r of list.items) {
      expect(
        r.cohort,
        "a row in the union carries no cohort — the reader cannot tell whether 'retry' applies to it",
      ).toBeTruthy();
      byCohort.set(r.cohort!, (byCohort.get(r.cohort!) ?? 0) + 1);
    }
    expect(byCohort.get("TSA_FAILED_ONLY")).toBe(TSA_ONLY);
    expect(byCohort.get("SIGNED_NO_REPORT_ONLY")).toBe(REPORT_ONLY);
    expect(byCohort.get("BOTH")).toBe(BOTH);
  });

  it("every row carries age, last change, retryability, action and runbook", async () => {
    const list = await listAdminEvidenceRecords({
      cohort: "ALL_AFFECTED",
      page: 1,
      limit: 5,
    });
    expect(list.items.length).toBeGreaterThan(0);
    for (const r of list.items) {
      expect(typeof r.ageDays).toBe("number");
      expect(r.ageDays).toBeGreaterThanOrEqual(0);
      expect(r.lastChangeAtUtc).toBeTruthy();
      expect(typeof r.retryable).toBe("boolean");
      expect(r.operatorAction.length).toBeGreaterThan(0);
      // A non-retryable row must say why. "You cannot do this" with no reason
      // is the message an operator escalates about.
      if (!r.retryable) expect(r.notRetryableReason).toBeTruthy();
    }
  });

  it("a row's retryability follows its OWN cohort, not the filter", async () => {
    const list = await listAdminEvidenceRecords({
      cohort: "ALL_AFFECTED",
      page: 1,
      limit: 200,
    });
    for (const r of list.items) {
      if (r.cohort === "SIGNED_NO_REPORT_ONLY") expect(r.retryable).toBe(true);
      if (r.cohort === "TSA_FAILED_ONLY") expect(r.retryable).toBe(false);
      if (r.cohort === "BOTH") expect(r.retryable).toBe(false);
    }
  });

  it("no row exposes evidence content", async () => {
    const list = await listAdminEvidenceRecords({ cohort: "ALL_AFFECTED", page: 1, limit: 5 });
    const serialised = JSON.stringify(list.items);
    // Platform-operations visibility and evidence-content authorization are
    // different grants. Holding the first does not confer the second.
    for (const forbidden of [
      "storageKey",
      "storageBucket",
      "fileSha256",
      "signatureBase64",
      "internalNotes",
      "fingerprintCanonicalJson",
    ]) {
      expect(serialised, `the roster leaks ${forbidden}`).not.toContain(forbidden);
    }
  });
});
