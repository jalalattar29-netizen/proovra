/**
 * Phase IA-home-v2 — Workspace trust summary.
 *
 * The Home dashboard's "Trust State" card must show REAL integrity
 * totals, not pipeline approximations or marketing copy. The canonical
 * source of truth for per-evidence trust state is the `Evidence` table
 * itself:
 *
 *   - `tsaStatus`          (RFC 3161 trusted timestamp state)
 *   - `otsStatus`          (OpenTimestamps anchor state)
 *   - `signatureBase64`    (Ed25519 signature present ⇒ signed)
 *   - `publicVerifyState`  (public verification page state)
 *   - `verificationStatus` (overall integrity verdict)
 *
 * This service aggregates those columns by GROUP BY for a single
 * workspace. It NEVER fabricates a count — every number is a direct
 * `COUNT(*)` over the real column. Soft-deleted evidence is excluded.
 *
 * Read-only. Never mutates. Never emits an audit event.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../../db.js";
import { workspaceEvidenceWhere } from "../workspace-personal-scope.service.js";

export type TrustSummary = {
  /** Total non-deleted evidence in the workspace. */
  totalEvidence: number;
  tsa: {
    /** tsaStatus IN ('OK','STAMPED') — a working trusted timestamp. */
    stamped: number;
    pending: number;
    failed: number;
    /** No TSA attempted / unavailable. */
    none: number;
  };
  ots: {
    /** otsStatus IN ('ANCHORED','VERIFIED') — anchored on-chain. */
    anchored: number;
    pending: number;
    failed: number;
    none: number;
  };
  /**
   * Evidence carrying an Ed25519 signature. NOTE: this is NOT a
   * "ready" or "deliverable-complete" signal — signing happens BEFORE
   * the report worker runs. Use `endToEndReady` for headline readiness.
   * Kept on the response for the Trust State card (where it correctly
   * counts "signed records").
   */
  signed: number;
  /**
   * Phase HOME-TRUTH-FIX — operationally-truthful headline count.
   *
   * Predicate: `status = REPORTED` AND at least one Report row exists
   * AND at least one VerificationPackage row exists AND public
   * verification is not SUSPENDED.
   *
   * This is the predicate the Home "End-to-end ready" KPI uses. Unlike
   * `signed`, it cannot show green when the report worker has stalled.
   * It does NOT require TSA/OTS success — those are presented as
   * separate trust signals so the headline number stays focused on the
   * deliverable chain.
   */
  endToEndReady: number;
  /**
   * Count of evidence with `status = SIGNED` and no Report row. These
   * are records the user successfully finalised but for which the
   * report worker has not produced a deliverable. Surfaces as
   * Operational Issues on Home.
   */
  signedWithoutReport: number;
  /**
   * Count of evidence with `status = REPORTED` and no
   * VerificationPackage row. These are records whose report generated
   * but whose package builder did not.
   */
  reportedWithoutPackage: number;
  publicVerify: {
    published: number;
    unpublished: number;
    suspended: number;
  };
  /**
   * Evidence whose overall integrity verdict needs a human:
   * verificationStatus IN ('REVIEW_REQUIRED','FAILED').
   */
  needingAttention: number;
};

/** Map a raw Evidence.tsaStatus string to a coarse bucket. */
function tsaBucket(raw: string | null): "stamped" | "pending" | "failed" | "none" {
  const v = (raw ?? "").toUpperCase();
  if (v === "OK" || v === "STAMPED" || v === "GRANTED") return "stamped";
  if (v === "PENDING" || v === "QUEUED") return "pending";
  if (v === "FAILED" || v === "REJECTED" || v === "ERROR") return "failed";
  return "none";
}

function otsBucket(raw: string | null): "anchored" | "pending" | "failed" | "none" {
  const v = (raw ?? "").toUpperCase();
  if (v === "ANCHORED" || v === "VERIFIED" || v === "OK") return "anchored";
  if (v === "PENDING" || v === "UPGRADING" || v === "QUEUED") return "pending";
  if (v === "FAILED" || v === "ERRORED" || v === "ERROR") return "failed";
  return "none";
}

export async function buildTrustSummary(input: {
  teamId: string;
}): Promise<TrustSummary> {
  // Phase HOME-DATA-OWNERSHIP — for personal workspaces the filter
  // also matches the owner's legacy `team_id NULL` rows (pre-backfill
  // databases). Strict teamId filter for real team workspaces.
  const scopeWhere = await workspaceEvidenceWhere(input.teamId);
  const baseWhere: Prisma.EvidenceWhereInput = {
    AND: [scopeWhere, { deletedAt: null }],
  };

  // GROUP BY on the real columns. Each call is a single aggregate query;
  // the numbers are direct counts, never derived.
  //
  // Phase HOME-TRUTH-FIX — three new counts added at the bottom
  // (endToEndReady / signedWithoutReport / reportedWithoutPackage).
  // These give the Home headline KPI a predicate that cannot show
  // green when the report worker has stalled — the exact failure mode
  // (puppeteer __name) that previously left Trust Ready at 100%.
  const [
    tsaGroups,
    otsGroups,
    verifyGroups,
    totalEvidence,
    signed,
    needingAttention,
    endToEndReady,
    signedWithoutReport,
    reportedWithoutPackage,
  ] = await Promise.all([
      prisma.evidence.groupBy({
        by: ["tsaStatus"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.evidence.groupBy({
        by: ["otsStatus"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.evidence.groupBy({
        by: ["publicVerifyState"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.evidence.count({ where: baseWhere }),
      prisma.evidence.count({
        where: { ...baseWhere, signatureBase64: { not: null } },
      }),
      prisma.evidence.count({
        where: {
          ...baseWhere,
          verificationStatus: { in: ["REVIEW_REQUIRED", "FAILED"] as never },
        },
      }),
      // End-to-end ready — every link in the deliverable chain must
      // exist. status REPORTED + Report row + Package row + verify
      // not actively suspended. TSA/OTS deliberately NOT required:
      // those are presented as separate trust signals (see the
      // dedicated Trust State rows) so the headline number stays
      // about the deliverable chain.
      prisma.evidence.count({
        where: {
          ...baseWhere,
          status: "REPORTED" as never,
          reports: { some: {} },
          verificationPackages: { some: {} },
          NOT: { publicVerifyState: "SUSPENDED" as never },
        },
      }),
      // Stuck-SIGNED — operational issue surfaced on Home.
      prisma.evidence.count({
        where: {
          ...baseWhere,
          status: "SIGNED" as never,
          reports: { none: {} },
        },
      }),
      // Stuck-REPORTED — package builder never produced a row.
      prisma.evidence.count({
        where: {
          ...baseWhere,
          status: "REPORTED" as never,
          verificationPackages: { none: {} },
        },
      }),
    ]);

  const tsa = { stamped: 0, pending: 0, failed: 0, none: 0 };
  for (const g of tsaGroups) {
    tsa[tsaBucket(g.tsaStatus)] += g._count._all;
  }

  const ots = { anchored: 0, pending: 0, failed: 0, none: 0 };
  for (const g of otsGroups) {
    ots[otsBucket(g.otsStatus)] += g._count._all;
  }

  const publicVerify = { published: 0, unpublished: 0, suspended: 0 };
  for (const g of verifyGroups) {
    const v = String(g.publicVerifyState ?? "").toUpperCase();
    if (v === "PUBLISHED") publicVerify.published += g._count._all;
    else if (v === "SUSPENDED") publicVerify.suspended += g._count._all;
    else publicVerify.unpublished += g._count._all;
  }

  return {
    totalEvidence,
    tsa,
    ots,
    signed,
    endToEndReady,
    signedWithoutReport,
    reportedWithoutPackage,
    publicVerify,
    needingAttention,
  };
}
