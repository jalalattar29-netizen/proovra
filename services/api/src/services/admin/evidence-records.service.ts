import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { liveEvidenceWhere } from "@proovra/shared-runtime";

/**
 * PLATFORM ADMIN — EVIDENCE-HEALTH DRILL-DOWN (ADM-029).
 *
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * `buildEvidenceHealthSnapshot` produces a clean, canonical set of counts —
 * TSA failures, OTS failures, signed-but-no-report, reported-but-no-package,
 * hash mismatches, stalled uploads. Every one of them was a SCALAR. No endpoint
 * returned the affected ids and no page could render them, so an operator who
 * saw "TSA failures: 34" had no way to learn whose evidence had failed, in
 * which workspace, or when — short of querying the database by hand.
 *
 * A control-plane number that cannot name its records is not an operational
 * signal; it is a rumour.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN
 * ---------------------------------------------------------------------------
 * Evidence CONTENT. Not the file, not the storage key, not the bucket, not the
 * SHA-256, not `internalNotes`, not the fingerprint canonical JSON, not the
 * signature. The projection is: id, workspace, customer, owner email, type,
 * failure-relevant status columns, and timestamps.
 *
 * The title IS included, because an operator triaging a failure needs to
 * recognise the record and the title is already shown to platform admins by
 * `/v1/admin/search`. Everything that would let a reader RECONSTRUCT or VERIFY
 * the evidence is absent: platform-operations visibility and evidence-content
 * authorization are different grants, and a platform admin holding the first
 * does not thereby hold the second.
 */

/**
 * The failure signals an operator can drill into.
 *
 * Each key maps to EXACTLY the predicate `evidence-health.service.ts` counts
 * with, so a drill-down can never disagree with the tile that led to it. They
 * are declared together here for that reason — two places computing "TSA
 * failure" is how a count and its list drift apart.
 */
export const EVIDENCE_HEALTH_SIGNALS = {
  TSA_FAILED: {
    label: "Timestamp (TSA) failures",
    where: { tsaStatus: "FAILED" },
  },
  OTS_FAILED: {
    label: "OpenTimestamps anchoring failures",
    where: { otsStatus: "FAILED" },
  },
  HASH_MISMATCH: {
    label: "Hash mismatch",
    where: { status: "FAILED_HASH_MISMATCH" },
  },
  VERIFICATION_FAILED: {
    label: "Verification failed",
    where: { verificationStatus: "FAILED" },
  },
  SIGNED_NO_REPORT: {
    label: "Signed, no report",
    where: { status: "SIGNED", latestReportVersion: null },
  },
  REPORTED_NO_PACKAGE: {
    label: "Reported, no verification package",
    where: { status: "REPORTED", verificationPackageVersion: null },
  },
} as const satisfies Record<
  string,
  { label: string; where: Prisma.EvidenceWhereInput }
>;

export type EvidenceHealthSignal = keyof typeof EVIDENCE_HEALTH_SIGNALS;

export function isEvidenceHealthSignal(v: string): v is EvidenceHealthSignal {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_HEALTH_SIGNALS, v);
}

export type AdminEvidenceRecord = {
  id: string;
  title: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  tsaStatus: string | null;
  otsStatus: string | null;
  createdAt: string;
  workspace: {
    id: string;
    name: string;
    kind: string;
    lifecycle: "LIVE" | "CLOSED";
  } | null;
  customer: { id: string; name: string } | null;
  ownerEmail: string | null;
};

export type AdminEvidenceRecordsResult = {
  /** Null for a direct `evidenceId` lookup, which is not a signal query. */
  signal: EvidenceHealthSignal | null;
  label: string;
  items: AdminEvidenceRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export async function listAdminEvidenceRecords(
  input: {
    /**
     * The health signal to enumerate. Omitted ONLY when `evidenceId` names one
     * specific record — a direct lookup is not "a failure signal with a filter"
     * and pretending otherwise would force a caller to pick an arbitrary one.
     */
    signal?: EvidenceHealthSignal;
    page: number;
    limit: number;
    teamId?: string;
    organizationId?: string;
    /**
     * ADM-019 — resolve ONE record by id.
     *
     * Global search used to return an evidence / report / package hit and send
     * the operator to `/admin/evidence-ops`, a page of global counters, having
     * discarded the id entirely. The record they searched for was not on the
     * destination in any form. This is the parameter that makes the identity
     * survive the click.
     */
    evidenceId?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<AdminEvidenceRecordsResult> {
  const page = Math.max(1, input.page);
  const limit = Math.min(200, Math.max(1, input.limit));
  const signal = input.signal ? EVIDENCE_HEALTH_SIGNALS[input.signal] : null;

  const where: Prisma.EvidenceWhereInput = {
    ...liveEvidenceWhere(),
    ...((signal?.where as Prisma.EvidenceWhereInput | undefined) ?? {}),
    ...(input.evidenceId ? { id: input.evidenceId } : {}),
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  };

  const [total, rows] = await Promise.all([
    client.evidence.count({ where }),
    client.evidence.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      // Explicit allow-list. NO storageKey, NO storageBucket, NO fileSha256, NO
      // fingerprintCanonicalJson, NO signatureBase64, NO internalNotes.
      //
      // `Evidence` declares no `team` or `owner` relation — `teamId` and
      // `ownerUserId` are bare scalars — so the subject is resolved by two
      // batched lookups below rather than by an include that does not exist.
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        verificationStatus: true,
        tsaStatus: true,
        otsStatus: true,
        createdAt: true,
        teamId: true,
        ownerUserId: true,
      },
    }),
  ]);

  // ---- Resolve the subject for the page, in two batched queries -----------
  const teamIds = Array.from(
    new Set(rows.map((r) => r.teamId).filter((v): v is string => !!v)),
  );
  const ownerIds = Array.from(
    new Set(rows.map((r) => r.ownerUserId).filter((v): v is string => !!v)),
  );

  const [teams, owners] = await Promise.all([
    teamIds.length
      ? client.team.findMany({
          where: { id: { in: teamIds } },
          select: {
            id: true,
            name: true,
            workspaceKind: true,
            closedAtUtc: true,
            organization: { select: { id: true, name: true, kind: true } },
          },
        })
      : Promise.resolve([]),
    ownerIds.length
      ? client.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t] as const));
  const emailByUser = new Map(owners.map((u) => [u.id, u.email ?? null] as const));

  return {
    signal: input.signal ?? null,
    label: signal?.label ?? "Specific record",
    items: rows.map((r) => {
      const team = r.teamId ? teamById.get(r.teamId) : undefined;
      return {
        id: r.id,
        title: r.title ?? null,
        type: String(r.type),
        status: String(r.status),
        verificationStatus: r.verificationStatus
          ? String(r.verificationStatus)
          : null,
        tsaStatus: r.tsaStatus ?? null,
        otsStatus: r.otsStatus ?? null,
        createdAt: r.createdAt.toISOString(),
        workspace: team
          ? {
              id: team.id,
              name: team.name,
              kind: String(team.workspaceKind),
              lifecycle: team.closedAtUtc
                ? ("CLOSED" as const)
                : ("LIVE" as const),
            }
          : null,
        // Only a CUSTOMER organization is a customer; a SYSTEM container is the
        // workspace's own bootstrap row and must not be presented as an account.
        customer:
          team?.organization && String(team.organization.kind) === "CUSTOMER"
            ? { id: team.organization.id, name: team.organization.name }
            : null,
        ownerEmail: r.ownerUserId
          ? emailByUser.get(r.ownerUserId) ?? null
          : null,
      };
    }),
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}
