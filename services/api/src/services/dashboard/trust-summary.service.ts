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

import { prisma } from "../../db.js";

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
  /** Evidence carrying an Ed25519 signature. */
  signed: number;
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
  const baseWhere = { teamId: input.teamId, deletedAt: null } as const;

  // GROUP BY on the real columns. Each call is a single aggregate query;
  // the numbers are direct counts, never derived.
  const [tsaGroups, otsGroups, verifyGroups, totalEvidence, signed, needingAttention] =
    await Promise.all([
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
    publicVerify,
    needingAttention,
  };
}
