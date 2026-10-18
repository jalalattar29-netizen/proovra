/**
 * Phase IA-home-v2 — Workspace trust summary.
 *
 * The Home dashboard's "Trust State" card must show REAL integrity
 * totals, not pipeline approximations or marketing copy. The canonical
 * source of truth for per-evidence trust state is the `Evidence` table
 * itself:
 *
 *   - `tsaStatus`          (RFC 3161 trusted timestamp state)
 *   - the OpenTimestamps proof (resolveRecordOtsAnchoring — the one OTS state)
 *   - `signatureBase64`    (Ed25519 signature present ⇒ signed)
 *   - verification pages     (disclosure policy and access state)
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
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import {
  OTS_ANCHORING_RECORD_SELECT,
  presentedTsaStatus,
  resolveRecordOtsAnchoring,
  TSA_RECORDED_NOT_VALIDATED,
  type OtsAnchoringRecord,
  type OtsState,
} from "@proovra/shared";
// COMMERCIAL CLOSURE (2026-09-08) — the ONE narrowing that keeps a commercial
// product decision out of the operational "stuck" counters.
import { outputEntitledEvidenceWhere } from "../billing/evidence-output-eligibility.service.js";

import { primaryPublishedPackageWhere } from "@proovra/shared-runtime/reports";
export type TrustSummary = {
  /** Total non-deleted evidence in the workspace. */
  totalEvidence: number;
  tsa: {
    /** STAMPED and VALIDATED (ET-TSA-01) — a working trusted timestamp. */
    stamped: number;
    /** STAMPED before token validation existed: a token is kept, never validated. */
    recordedNotValidated: number;
    pending: number;
    failed: number;
    /** No TSA attempted / unavailable. */
    none: number;
  };
  /**
   * (2026-10-13) Counts per OTS state, each row resolved from its stored proof
   * bytes (resolveRecordOtsAnchoring): anchored = ANCHORED, pending = PENDING,
   * failed = FAILED, unavailable = UNAVAILABLE, notRequested = NOT_REQUESTED.
   */
  ots: {
    anchored: number;
    pending: number;
    failed: number;
    unavailable: number;
    notRequested: number;
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
  /**
   * (2026-10-18) The records' canonical verification pages: what each page
   * discloses (its disclosure policy), and pages whose access is withdrawn or
   * suspended. Every finalized record has a page; nothing is "unpublished".
   */
  verificationPages: {
    contentPreview: number;
    verificationOnly: number;
    unavailable: number;
  };
  /**
   * Evidence whose overall integrity verdict needs a human:
   * verificationStatus IN ('REVIEW_REQUIRED','FAILED').
   */
  needingAttention: number;
  /**
   * CLOSURE PASS (2026-08-22) — INTAKE, from the intake domain's own rows.
   *
   * Home rendered these two counts from the caller's /v1/me/inbox feed, which
   * made a workspace fact move when one person archived a notification, and
   * capped it at the feed's per-category take so a busy workspace
   * under-reported. `EvidenceRequest` is the authority the intake domain
   * already owns; these are the same predicates the notification aggregator
   * uses, counted here without a cap and without a recipient.
   */
  intake: {
    /** RESPONSE_RECEIVED | UNDER_REVIEW with no reviewer claimed. */
    submissionsAwaitingReview: number;
    /** PARTIALLY_FULFILLED | NEEDS_MORE_INFO — the submission is incomplete. */
    submissionsNeedingMoreInfo: number;
  };
};

/** Map a raw Evidence.tsaStatus string to a coarse bucket. */
function tsaBucket(
  raw: string | null,
): "stamped" | "recordedNotValidated" | "pending" | "failed" | "none" {
  const v = (raw ?? "").toUpperCase();
  if (v === TSA_RECORDED_NOT_VALIDATED) return "recordedNotValidated";
  if (v === "OK" || v === "STAMPED" || v === "GRANTED") return "stamped";
  if (v === "PENDING" || v === "QUEUED") return "pending";
  if (v === "FAILED" || v === "REJECTED" || v === "ERROR") return "failed";
  return "none";
}

export type OtsBucket = "anchored" | "pending" | "failed" | "unavailable" | "notRequested";

const OTS_BUCKET: Readonly<Record<OtsState, OtsBucket>> = {
  ANCHORED: "anchored",
  PENDING: "pending",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
  NOT_REQUESTED: "notRequested",
};

/**
 * (2026-10-13) The OTS bucket is the ONE state (resolveRecordOtsAnchoring):
 * ANCHORED only when the stored proof executes from the record's digest to a
 * valid Bitcoin block attestation — never from a status string, a txid or a
 * timestamp.
 */
export function otsBucket(row: OtsAnchoringRecord): OtsBucket {
  return OTS_BUCKET[resolveRecordOtsAnchoring(row).state];
}

/** Rows per page when resolving the stored proofs of a workspace. */
const OTS_SUMMARY_PAGE = 500;

/**
 * Counts per OTS state. Rows without proof bytes resolve from their stored
 * status alone, so they are grouped in one aggregate; rows WITH proof bytes are
 * resolved one by one (the proof decides), paged by id.
 */
async function countOtsStates(baseWhere: Prisma.EvidenceWhereInput): Promise<TrustSummary["ots"]> {
  const ots: TrustSummary["ots"] = { anchored: 0, pending: 0, failed: 0, unavailable: 0, notRequested: 0 };
  const withoutProof = await prisma.evidence.groupBy({
    by: ["otsStatus"],
    where: { AND: [baseWhere, { otsProofBase64: null }] },
    _count: { _all: true },
  });
  for (const g of withoutProof) {
    ots[otsBucket({ otsStatus: g.otsStatus, otsProofBase64: null })] += g._count._all;
  }
  let cursor: string | null = null;
  for (;;) {
    const page: Array<OtsAnchoringRecord & { id: string }> = await prisma.evidence.findMany({
      where: { AND: [baseWhere, { otsProofBase64: { not: null } }] },
      select: { id: true, ...OTS_ANCHORING_RECORD_SELECT },
      orderBy: { id: "asc" },
      take: OTS_SUMMARY_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of page) ots[otsBucket(row)] += 1;
    if (page.length < OTS_SUMMARY_PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  return ots;
}

export async function buildTrustSummary(input: {
  teamId: string;
}): Promise<TrustSummary> {
  // Phase HOME-DATA-OWNERSHIP — for personal workspaces the filter
  // also matches the owner's legacy `team_id NULL` rows (pre-backfill
  // databases). Strict teamId filter for real team workspaces.
  const scopeWhere = await workspaceEvidenceWhere(input.teamId, prisma);
  const baseWhere: Prisma.EvidenceWhereInput = {
    AND: [scopeWhere, { deletedAt: null }],
  };

  /*
   * COMMERCIAL CLOSURE (2026-09-08) — the entitlement narrowing for the two
   * STUCK counters below, resolved once. `null` on a plan that includes the
   * outputs, which is the common case and adds nothing to the query.
   *
   * Applied ONLY to the two operational-backlog counts. `endToEndReady` above
   * is a DELIVERABLE-chain measure, not a fault measure, and narrowing it here
   * would change a headline KPI's population as a side effect of a fault-count
   * fix — a different decision, on a different surface, that deserves to be
   * made on purpose.
   */
  const outputEntitledWhere = await outputEntitledEvidenceWhere({
    teamId: input.teamId,
  });

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
    ots,
    verifyGroups,
    totalEvidence,
    signed,
    needingAttention,
    endToEndReady,
    signedWithoutReport,
    reportedWithoutPackage,
    submissionsAwaitingReview,
    submissionsNeedingMoreInfo,
  ] = await Promise.all([
      // ET-TSA-01: grouped by status AND whether the token was validated.
      prisma.evidence.groupBy({
        by: ["tsaStatus", "tsaValidatedAtUtc"],
        where: baseWhere,
        _count: { _all: true },
      }),
      // (2026-10-13) Each row's OTS state, resolved from its stored proof.
      countOtsStates(baseWhere),
      prisma.evidence.groupBy({
        by: ["verificationDisclosureMode", "verificationAccessState"],
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
          verificationPackages: { some: primaryPublishedPackageWhere() },
          verificationAccessState: "AVAILABLE",
        },
      }),
      /*
       * Stuck-SIGNED — an OPERATIONAL issue surfaced on Home.
       *
       * COMMERCIAL CLOSURE (2026-09-08) — narrowed to records the product was
       * ever going to produce a report for. "Stuck" means the pipeline owes
       * something and has not delivered it; on a plan that does not include
       * reports nothing is ever enqueued, so every finalized record counted as
       * stuck, permanently, and Home told those customers their pipeline was
       * broken. `outputEntitledWhere` is null on a plan that DOES include them,
       * which is the common case and adds nothing to the query.
       */
      prisma.evidence.count({
        where: {
          // Composed under AND, never spread: the narrowing is a general
          // where (ET-COM-04) and a spread key could overwrite baseWhere's.
          AND: [baseWhere, ...(outputEntitledWhere ? [outputEntitledWhere] : [])],
          status: "SIGNED" as never,
          reports: { none: {} },
        },
      }),
      // Stuck-REPORTED — package builder never produced a row. Same narrowing,
      // same reason.
      prisma.evidence.count({
        where: {
          // Composed under AND, never spread: the narrowing is a general
          // where (ET-COM-04) and a spread key could overwrite baseWhere's.
          AND: [baseWhere, ...(outputEntitledWhere ? [outputEntitledWhere] : [])],
          status: "REPORTED" as never,
          verificationPackages: { none: primaryPublishedPackageWhere() },
        },
      }),
      // INTAKE — the same predicates the notification aggregator emits
      // `intake_submission_pending_review` and
      // `intake_required_items_missing` from, counted over the WORKSPACE
      // rather than over one recipient's capped feed slice.
      prisma.evidenceRequest.count({
        where: {
          teamId: input.teamId,
          status: { in: ["RESPONSE_RECEIVED", "UNDER_REVIEW"] },
          assignedReviewerUserId: null,
        },
      }),
      prisma.evidenceRequest.count({
        where: {
          teamId: input.teamId,
          status: { in: ["PARTIALLY_FULFILLED", "NEEDS_MORE_INFO"] },
        },
      }),
    ]);

  const tsa = { stamped: 0, recordedNotValidated: 0, pending: 0, failed: 0, none: 0 };
  for (const g of tsaGroups) {
    const bucket = tsaBucket(presentedTsaStatus(g));
    tsa[bucket] += g._count._all;
  }

  const verificationPages = { contentPreview: 0, verificationOnly: 0, unavailable: 0 };
  for (const g of verifyGroups) {
    if (g.verificationAccessState !== "AVAILABLE") verificationPages.unavailable += g._count._all;
    else if (g.verificationDisclosureMode === "CONTENT_PREVIEW") verificationPages.contentPreview += g._count._all;
    else verificationPages.verificationOnly += g._count._all;
  }

  return {
    totalEvidence,
    tsa,
    ots,
    signed,
    endToEndReady,
    signedWithoutReport,
    reportedWithoutPackage,
    verificationPages,
    needingAttention,
    intake: { submissionsAwaitingReview, submissionsNeedingMoreInfo },
  };
}
