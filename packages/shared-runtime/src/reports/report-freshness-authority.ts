/**
 * THE ONE "IS A NEWER REPORT OWED?" AUTHORITY (2026-10-24).
 *
 * The API (the Evidence ID "Update available" card, the Reports page, mobile,
 * the regenerate route's FREE-plan gate and offer binding, recovery's Confirm
 * gate) and the worker (the updated report's supersession statement) used to
 * run their own copy of the reportable-custody query, so the two could drift.
 * Both now call this: one query over the custody chain, grouped by WHY each
 * fact is reportable, and the shared `deriveReportFreshness` rule.
 *
 * NEVER REPORTABLE: internal Review workflow activity (owner decision
 * 2026-10-24 — Review is not forensic custody; its historical rows are
 * excluded by type), views, downloads, access activity, report/package
 * issuance bookkeeping, Public Verify visits. The comparison horizon is the
 * report's own render-snapshot sequence (`custodyThroughSequence`), so the
 * custody events its own issuance appends are never "after" it.
 */
import type { PrismaClient } from "@prisma/client";
import {
  REPORTABLE_CUSTODY_EVENT_TYPES,
  deriveReportFreshness,
  reportableCustodyReasonOf,
  snapshotAnchoringAtIssue,
  type OtsState,
  type OtsVerificationKey,
  type ReportFreshness,
  type ReportableCustodyGroup,
  type ReportableCustodyReason,
} from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";

type Db = Pick<PrismaClient, "custodyEvent">;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The custody horizon of an issued report (its render snapshot). */
export type ReportCustodyHorizon = {
  custodyThroughSequence: number | null;
  generatedAtUtc: Date;
};

/**
 * Reportable custody facts recorded after a report's horizon, one group per
 * reason. A legacy report with no recorded sequence falls back to time.
 */
export async function loadReportableCustodyAfterReport(
  evidenceId: string,
  report: ReportCustodyHorizon,
  client: Db = getRegisteredPrisma(),
): Promise<ReportableCustodyGroup[]> {
  const rows = await client.custodyEvent.groupBy({
    by: ["eventType"],
    where: {
      evidenceId,
      eventType: { in: REPORTABLE_CUSTODY_EVENT_TYPES as never },
      ...(report.custodyThroughSequence != null
        ? { sequence: { gt: report.custodyThroughSequence } }
        : { atUtc: { gt: report.generatedAtUtc } }),
    },
    _count: { _all: true },
    _min: { atUtc: true },
    _max: { atUtc: true },
  });
  const byReason = new Map<ReportableCustodyReason, ReportableCustodyGroup>();
  for (const row of rows as Array<{ eventType: string; _count: { _all: number }; _min: { atUtc: Date | null }; _max: { atUtc: Date | null } }>) {
    const reason = reportableCustodyReasonOf(row.eventType);
    if (!reason) continue;
    const first = iso(row._min.atUtc);
    const latest = iso(row._max.atUtc);
    const g = byReason.get(reason) ?? { reason, count: 0, firstAtUtc: null, latestAtUtc: null };
    g.count += row._count._all;
    if (first && (!g.firstAtUtc || first < g.firstAtUtc)) g.firstAtUtc = first;
    if (latest && (!g.latestAtUtc || latest > g.latestAtUtc)) g.latestAtUtc = latest;
    byReason.set(reason, g);
  }
  return [...byReason.values()];
}

/** What a report row records that the comparison needs. */
export type IssuedReportFacts = ReportCustodyHorizon & {
  version: number;
  lastVerifiedAtUtcSnapshot: Date | null;
  anchorSnapshot?: unknown;
  trustDecisionSnapshot?: unknown;
};

/** The record's facts NOW (the caller resolved OTS with the one OTS authority). */
export type CurrentRecordFacts = {
  tsa: { status: string | null; validatedAtUtc: Date | null };
  ots: {
    state: OtsState;
    anchoredAtUtc: string | null;
    verification: OtsVerificationKey | null;
    verifiedAtUtc: string | null;
    /** The verified proof and block now, when known. */
    proofSha256?: string | null;
    blockHash?: string | null;
  };
  lastVerifiedAtUtc: Date | null;
};

/**
 * Is a newer report owed than `report`, and WHY. The same answer for every
 * caller: the Evidence ID card, the Reports page, mobile, report request
 * creation and the worker's supersession statement.
 */
export async function deriveReportFreshnessForRecord(
  evidenceId: string,
  report: IssuedReportFacts | null,
  now: CurrentRecordFacts,
  client: Db = getRegisteredPrisma(),
): Promise<ReportFreshness> {
  const groups = report ? await loadReportableCustodyAfterReport(evidenceId, report, client) : [];
  const atIssue = report ? snapshotAnchoringAtIssue((report.anchorSnapshot ?? null) as never, (report.trustDecisionSnapshot ?? null) as never) : null;
  const stated = (report?.anchorSnapshot && typeof report.anchorSnapshot === "object" ? report.anchorSnapshot : {}) as Record<string, unknown>;
  return deriveReportFreshness({
    reportVersion: report?.version ?? null,
    reportGeneratedAtUtc: iso(report?.generatedAtUtc),
    tsa: { status: now.tsa.status, validatedAtUtc: iso(now.tsa.validatedAtUtc) },
    ots: {
      state: now.ots.state,
      anchoredAtUtc: now.ots.anchoredAtUtc,
      reportState: atIssue?.otsState ?? null,
      // Only an independent chain VERIFIED after the report is a change worth
      // a new version; a recorded attestation is not.
      verification: now.ots.verification,
      reportVerification: atIssue?.otsVerification ?? null,
      verifiedAtUtc: now.ots.verifiedAtUtc,
      proofSha256: now.ots.proofSha256 ?? null,
      blockHash: now.ots.blockHash ?? null,
      reportProofSha256: typeof stated.otsProofSha256 === "string" ? stated.otsProofSha256 : null,
      reportBlockHash: typeof stated.otsChainBlockHash === "string" ? stated.otsChainBlockHash : null,
    },
    custodyAfterReport: { groups },
    integrity: {
      lastVerifiedAtUtc: iso(now.lastVerifiedAtUtc),
      reportLastVerifiedAtUtc: iso(report?.lastVerifiedAtUtcSnapshot ?? null),
    },
  });
}
