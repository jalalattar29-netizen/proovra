/**
 * A CREATOR'S GRANTS END WITH THEIR REACH TO THE RECORD (members re-audit,
 * second round, defect 4).
 *
 * An owner share link or an external-review grant is outward access held in a
 * person's name (creator-share-grants.ts). Membership end and role loss
 * already revoke them. A third event closes a record to a person who keeps
 * both: a restricted case. When a case becomes restricted without them, when
 * they (or the Collaboration Team that carried them) are removed from its
 * list, or when a record is linked to a restricted case they are not on, the
 * person can no longer open the record — and a link they handed out must not
 * keep opening it for somebody else.
 *
 * WHAT "LOSES REACH" MEANS. After the change, inside its transaction, the
 * canonical record authority (`resolveEvidenceRecordAccess`, evidence.read)
 * is asked for the creator. Only the restricted-case answer
 * (`case_access_list`) revokes here: that is the reach this change takes away.
 * A creator who is no longer a member, or lost the role, is the membership
 * path's business (standing-reach / rbac revoke those, with their own
 * reasons); an authorization error never revokes anything. A CASE-scope
 * external-review grant on the case itself ends when the case is no longer
 * visible to its creator, by the same rule (case-visibility.ts).
 *
 * The rows are revoked with CREATOR_LOST_RECORD_REACH, never deleted. Issued
 * REPORT / PACKAGE tokens and the record's `pvr_` reference are not touched:
 * they belong to the record's publication state, not to a person.
 */
import type { PrismaClient } from "@prisma/client";

import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { revokeShareGrantsByIdTx } from "../sharing/creator-share-grants.js";
import { CASE_VISIBILITY_SELECT, caseRowVisibleTo } from "./case-visibility.js";

export async function revokeGrantsOfCreatorsWithoutReachTx(
  tx: PrismaClient,
  input: {
    /** Cases whose list or restriction just changed (every record linked to them is examined). */
    caseIds?: readonly string[];
    /** Records whose reach just changed (e.g. newly linked to a restricted case). */
    evidenceIds?: readonly string[];
    actorUserId: string | null;
  },
): Promise<{ ownerShares: number; externalReview: number }> {
  const caseIds = [...new Set(input.caseIds ?? [])];
  const linked =
    caseIds.length > 0
      ? await tx.caseEvidenceLink.findMany({ where: { caseId: { in: caseIds } }, select: { evidenceId: true } })
      : [];
  const evidenceIds = [...new Set([...(input.evidenceIds ?? []), ...linked.map((l) => l.evidenceId)])];
  if (evidenceIds.length === 0 && caseIds.length === 0) return { ownerShares: 0, externalReview: 0 };

  const now = new Date();
  const shares =
    evidenceIds.length > 0
      ? await tx.verificationShareToken.findMany({
          where: {
            evidenceId: { in: evidenceIds },
            purpose: "OWNER_SHARE",
            revokedAtUtc: null,
            createdByUserId: { not: null },
            OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
          },
          select: { id: true, evidenceId: true, createdByUserId: true },
        })
      : [];
  const packages =
    evidenceIds.length > 0
      ? await tx.verificationPackage.findMany({
          where: { evidenceId: { in: evidenceIds } },
          select: { id: true, evidenceId: true },
        })
      : [];
  const evidenceOfPackage = new Map(packages.map((p) => [p.id, p.evidenceId]));
  const scopeOr = [
    ...(evidenceIds.length > 0 ? [{ evidenceId: { in: evidenceIds } }] : []),
    ...(caseIds.length > 0 ? [{ caseId: { in: caseIds } }] : []),
    ...(packages.length > 0 ? [{ packageId: { in: packages.map((p) => p.id) } }] : []),
  ];
  const grants = await tx.externalReviewGrant.findMany({
    where: { state: { in: ["INVITED", "ACTIVE"] }, expiresAtUtc: { gt: now }, OR: scopeOr },
    select: { id: true, scopeKind: true, evidenceId: true, caseId: true, packageId: true, invitedByUserId: true },
  });

  // One decision per (creator, record) and per (creator, case).
  const recordReach = new Map<string, boolean>();
  const reachesRecord = async (userId: string, evidenceId: string): Promise<boolean> => {
    const key = `${userId}:${evidenceId}`;
    const known = recordReach.get(key);
    if (known !== undefined) return known;
    const decision = await resolveEvidenceRecordAccess({ userId, evidenceId, permission: "evidence.read" }, tx);
    const reaches = decision.allowed || decision.internalReason !== "case_access_list";
    recordReach.set(key, reaches);
    return reaches;
  };
  const caseReach = new Map<string, boolean>();
  const reachesCase = async (userId: string, caseId: string): Promise<boolean> => {
    const key = `${userId}:${caseId}`;
    const known = caseReach.get(key);
    if (known !== undefined) return known;
    const row = await tx.case.findUnique({ where: { id: caseId }, select: CASE_VISIBILITY_SELECT });
    const reaches = row === null || caseRowVisibleTo(row, userId);
    caseReach.set(key, reaches);
    return reaches;
  };

  const ownerShareIds: string[] = [];
  for (const s of shares) {
    if (s.createdByUserId && !(await reachesRecord(s.createdByUserId, s.evidenceId))) ownerShareIds.push(s.id);
  }
  const externalReviewIds: string[] = [];
  for (const g of grants) {
    const recordId =
      g.scopeKind === "EVIDENCE" ? g.evidenceId : g.scopeKind === "PACKAGE" && g.packageId ? evidenceOfPackage.get(g.packageId) ?? null : null;
    const lost =
      g.scopeKind === "CASE" && g.caseId
        ? !(await reachesCase(g.invitedByUserId, g.caseId))
        : recordId
          ? !(await reachesRecord(g.invitedByUserId, recordId))
          : false;
    if (lost) externalReviewIds.push(g.id);
  }

  return revokeShareGrantsByIdTx(tx, {
    ownerShareIds,
    externalReviewIds,
    reason: "CREATOR_LOST_RECORD_REACH",
    actorUserId: input.actorUserId,
  });
}
