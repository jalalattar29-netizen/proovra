/**
 * EVIDENCE HEALTH — THE COHORTS, AND WHY THEY OVERLAP.
 *
 * ===========================================================================
 * THE ARITHMETIC THIS EXISTS TO STOP
 * ===========================================================================
 * The control plane reported "34 TSA failures" and "16 signed without report"
 * as two figures side by side, and every reader added them. They are not
 * disjoint: a record whose timestamp failed AND which has no report is in both,
 * and it is ONE record needing attention, not two.
 *
 * Worse, the two populations need OPPOSITE handling. A missing report can be
 * regenerated. A missing timestamp cannot — see `NON_RETRYABLE_REASON` below —
 * so a single "retry all affected" control over the union would have been a
 * control that quietly did nothing for most of what it claimed to fix.
 *
 * So the cohorts are named, disjoint where they claim to be disjoint, and the
 * union is measured rather than derived from a sum:
 *
 *   TSA_FAILED_ONLY        timestamp failed, report present
 *   SIGNED_NO_REPORT_ONLY  no report, timestamp fine
 *   BOTH                   the intersection — counted ONCE
 *   ALL_AFFECTED           the union, measured with OR, not added
 *
 * and cut a second way, by what an operator can DO:
 *
 *   RETRYABLE              a safe remediation authority exists
 *   MANUAL_REVIEW          it does not, and the record needs a human
 *
 * `arithmetic` re-derives the union from the three disjoint parts and reports
 * whether it agrees with the measured one. A projection that cannot check its
 * own sum is a projection that will eventually be wrong quietly.
 *
 * ===========================================================================
 * RETRYABILITY IS READ, NOT DECIDED HERE
 * ===========================================================================
 * Whether a condition can be retried is already settled by
 * `services/operations/remediation-registry.ts`, which the Operations Center
 * and the incident detail both consume. This module reads that authority and
 * does not add a second opinion: a cohort page that decided retryability for
 * itself would eventually offer a retry the incident surface refuses, or refuse
 * one it offers.
 */

import type { Prisma } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import type { PrismaClient } from "@prisma/client";
import { entryForIncident } from "../operations/remediation-registry.js";

// ---------------------------------------------------------------------------
// Predicates. Every cohort is a Prisma `where`, and the SAME `where` backs both
// the count and the drill-down list — two places computing "TSA failure" is how
// a tile and the page behind it drift apart.
// ---------------------------------------------------------------------------

/** Live evidence only. A soft-deleted record is not an operational problem. */
const LIVE: Prisma.EvidenceWhereInput = { deletedAt: null };

const TSA_FAILED: Prisma.EvidenceWhereInput = { tsaStatus: "FAILED" };
const SIGNED_NO_REPORT: Prisma.EvidenceWhereInput = {
  status: "SIGNED",
  latestReportVersion: null,
};

/**
 * THE COMPLEMENT OF `TSA_FAILED`, INCLUDING THE RECORDS THAT NEVER TRIED.
 *
 * `NOT: TSA_FAILED` compiles to `NOT (tsa_status = 'FAILED')`, and `tsaStatus`
 * is NULLABLE — a record whose timestamp was never attempted holds NULL there.
 * In SQL's three-valued logic `NULL = 'FAILED'` is NULL and `NOT NULL` is NULL,
 * which is not TRUE, so every one of those records was silently dropped from
 * the cohort.
 *
 * They were dropped from a cohort they belong in, and only from that one.
 * `ALL_AFFECTED` uses OR and counted them, so the union exceeded the sum of the
 * three disjoint parts and the projection's own `arithmetic.agrees` went false
 * — which is precisely what that self-check exists to catch, and it did:
 *
 *   tsa_failed_only 102 + signed_no_report_only 1 + both 1  =  104
 *   all_affected                                            =  195
 *   signed, no report, timestamp never attempted            =   91
 *
 * A record signed with no report is a real operational problem whether or not
 * anybody has asked a timestamp authority about it yet, and it is REGENERABLE,
 * so it also belongs in `RETRYABLE`. The `IS NULL` arm is written explicitly
 * rather than relying on a field-level `not` to decide how it treats NULL.
 */
const TSA_NOT_FAILED: Prisma.EvidenceWhereInput = {
  OR: [{ tsaStatus: null }, { tsaStatus: { not: "FAILED" } }],
};

export const EVIDENCE_HEALTH_COHORTS = {
  TSA_FAILED_ONLY: {
    label: "Timestamp failed only",
    description:
      "The RFC3161 timestamp could not be obtained. A report exists.",
    where: { ...LIVE, ...TSA_FAILED, NOT: SIGNED_NO_REPORT },
  },
  SIGNED_NO_REPORT_ONLY: {
    label: "Signed without a report only",
    description:
      "The record is signed and no report has been generated. The timestamp is fine.",
    where: { ...LIVE, ...SIGNED_NO_REPORT, ...TSA_NOT_FAILED },
  },
  BOTH: {
    label: "Both conditions",
    description:
      "The timestamp failed AND no report exists. ONE record, counted once.",
    where: { ...LIVE, ...TSA_FAILED, ...SIGNED_NO_REPORT },
  },
  ALL_AFFECTED: {
    label: "All affected",
    description:
      "The union, measured with OR. Never the sum of the two totals — that double-counts the intersection.",
    where: { ...LIVE, OR: [TSA_FAILED, SIGNED_NO_REPORT] },
  },
  RETRYABLE: {
    label: "Retryable",
    description:
      "A safe remediation authority exists. Today that is the report/package pipeline.",
    // A missing report is regenerable; a failed timestamp is not. The
    // predicate follows the registry, and `retryabilityContract()` below is
    // asserted against it so the two cannot drift.
    //
    // Same NULL-safe complement as `SIGNED_NO_REPORT_ONLY`: a record whose
    // timestamp was never attempted still has a report to regenerate, and
    // `RETRYABLE` and `MANUAL_REVIEW` must partition the union as well.
    where: { ...LIVE, ...SIGNED_NO_REPORT, ...TSA_NOT_FAILED },
  },
  MANUAL_REVIEW: {
    label: "Manual review",
    description:
      "No safe remediation authority exists. A human decides what happens next.",
    where: { ...LIVE, ...TSA_FAILED },
  },
} as const satisfies Record<
  string,
  { label: string; description: string; where: Prisma.EvidenceWhereInput }
>;

export type EvidenceHealthCohort = keyof typeof EVIDENCE_HEALTH_COHORTS;

export function isEvidenceHealthCohort(v: string): v is EvidenceHealthCohort {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_HEALTH_COHORTS, v);
}

// ---------------------------------------------------------------------------
// Retryability, read from the remediation registry.
// ---------------------------------------------------------------------------

/**
 * What the registry says about each integrity class, projected for a record.
 *
 * `entryForIncident` keys on an incident's category and fingerprint. A record
 * in the TSA cohort corresponds to an `evidence_integrity.tsa_failed`
 * condition, so the fingerprint prefix is what identifies the class — the same
 * mapping `integrityClassOf` performs, reached through the public entry point
 * rather than re-implemented.
 */
export type RetryabilityContract = {
  cohort: EvidenceHealthCohort;
  retryable: boolean;
  /** Present when `retryable` is false. Never invented here. */
  reason: string | null;
  /** The action an operator takes. Never a control they cannot use. */
  operatorAction: string;
  runbookSlug: string | null;
};

export function retryabilityContract(
  cohort: EvidenceHealthCohort,
): RetryabilityContract {
  const tsa = entryForIncident({
    category: "EVIDENCE_INTEGRITY",
    fingerprint: "tsa_failure:x",
  });
  const report = entryForIncident({
    category: "REPORT",
    fingerprint: "report_generation_failed:x",
  });

  const tsaRetryable = tsa?.disposition === "DIRECT_REMEDIATION";
  const reportRetryable = report?.disposition === "DIRECT_REMEDIATION";

  switch (cohort) {
    case "TSA_FAILED_ONLY":
    case "MANUAL_REVIEW":
      return {
        cohort,
        retryable: tsaRetryable,
        reason: tsaRetryable ? null : (tsa?.unsafeReason ?? null),
        operatorAction:
          tsa?.guidance ??
          "Open the record and decide whether the missing proof matters for this matter.",
        // docs/runbooks/tsa-timestamp-failure.md. The slug must name a
        // runbook that EXISTS: most `runbookSlug` values in this codebase are
        // condition labels with no document behind them, and a tile that links
        // one sends an operator to a 404 mid-incident.
        runbookSlug: "tsa-timestamp-failure",
      };
    case "SIGNED_NO_REPORT_ONLY":
    case "RETRYABLE":
      return {
        cohort,
        retryable: reportRetryable,
        reason: reportRetryable ? null : (report?.unsafeReason ?? null),
        operatorAction:
          report?.action?.label ?? "Regenerate report & verification package",
        runbookSlug: "failed-report-generation",
      };
    case "BOTH":
      return {
        cohort,
        // PARTIAL, and the word matters. The report half is retryable and the
        // timestamp half is not, so a control labelled "retry" over this cohort
        // fixes half of each record and leaves the other half — which is the
        // shape of misleading control this split exists to prevent.
        retryable: false,
        reason:
          "Partially retryable. The report can be regenerated; the timestamp cannot. " +
          (tsa?.unsafeReason ?? ""),
        operatorAction:
          "Regenerate the report, then review the record: its timestamp will remain absent.",
        runbookSlug: "tsa-timestamp-failure",
      };
    case "ALL_AFFECTED":
      return {
        cohort,
        retryable: false,
        reason:
          "A mixed population. Filter to a single cohort before acting — the two halves need opposite handling.",
        operatorAction: "Filter to Retryable or Manual review.",
        runbookSlug: null,
      };
  }
}

// ---------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------

export type CohortCount = {
  cohort: EvidenceHealthCohort;
  label: string;
  description: string;
  /** `null` when the count could not be read. NEVER 0. */
  count: number | null;
  retryable: boolean;
  reason: string | null;
  operatorAction: string;
  runbookSlug: string | null;
  /** The drill-down that lists exactly these records. */
  drillDown: string;
};

export type EvidenceHealthCohortProjection = {
  generatedAtUtc: string;
  cohorts: CohortCount[];
  /**
   * The self-check. `tsaOnly + reportOnly + both` must equal the measured
   * union; when it does not, something changed one predicate and not the other
   * and the page says so rather than rendering a total nobody can reconcile.
   */
  arithmetic: {
    disjointSum: number | null;
    measuredUnion: number | null;
    agrees: boolean | null;
  };
  /** Named when a count could not be read, so a null is never read as zero. */
  unavailableCohorts: EvidenceHealthCohort[];
};

export async function buildEvidenceHealthCohorts(
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceHealthCohortProjection> {
  const keys = Object.keys(EVIDENCE_HEALTH_COHORTS) as EvidenceHealthCohort[];

  const counted = await Promise.all(
    keys.map(async (cohort) => {
      try {
        const count = await client.evidence.count({
          where: EVIDENCE_HEALTH_COHORTS[cohort].where,
        });
        return { cohort, count };
      } catch {
        // A failed read is `null`, and the cohort is NAMED below. A zero here
        // would read as "nothing affected", which is the opposite of "we could
        // not tell".
        return { cohort, count: null as number | null };
      }
    }),
  );

  const byCohort = new Map(counted.map((c) => [c.cohort, c.count]));
  const cohorts: CohortCount[] = keys.map((cohort) => {
    const def = EVIDENCE_HEALTH_COHORTS[cohort];
    const contract = retryabilityContract(cohort);
    return {
      cohort,
      label: def.label,
      description: def.description,
      count: byCohort.get(cohort) ?? null,
      retryable: contract.retryable,
      reason: contract.reason,
      operatorAction: contract.operatorAction,
      runbookSlug: contract.runbookSlug,
      drillDown: `/admin/evidence-ops/records?cohort=${cohort}`,
    };
  });

  const tsaOnly = byCohort.get("TSA_FAILED_ONLY");
  const reportOnly = byCohort.get("SIGNED_NO_REPORT_ONLY");
  const both = byCohort.get("BOTH");
  const union = byCohort.get("ALL_AFFECTED");

  const disjointSum =
    tsaOnly === null || reportOnly === null || both === null
      ? null
      : (tsaOnly ?? 0) + (reportOnly ?? 0) + (both ?? 0);

  return {
    generatedAtUtc: new Date().toISOString(),
    cohorts,
    arithmetic: {
      disjointSum,
      measuredUnion: union ?? null,
      agrees:
        disjointSum === null || union === null || union === undefined
          ? null
          : disjointSum === union,
    },
    unavailableCohorts: counted
      .filter((c) => c.count === null)
      .map((c) => c.cohort),
  };
}
