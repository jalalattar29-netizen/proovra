import type { EvidenceLifecycleState, Prisma, PrismaClient } from "@prisma/client";

import { OUTPUT_PRODUCING_LIFECYCLE_STATE_LIST } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { outputEntitlementScope } from "./evidence-output-eligibility.service.js";

/**
 * AUD-30 (2026-10-20) — THE PLATFORM-WIDE OWED-OUTPUT NARROWING.
 *
 * "Signed, no report" and "Reported, no package" are backlog signals: a record
 * in them is supposed to be OWED an output nobody produced. The platform admin
 * and operations counts read the raw status columns, so every record the
 * producer guard refuses on purpose — an archived or trashed record, a record
 * on a plan that does not include outputs — was counted as an operational gap
 * that would never clear.
 *
 * The narrowing is the two canonical decisions, not a third opinion:
 *   - lifecycle: the producer guard's own output-producing states
 *     (`outputLifecycleRefusal`), and not soft-deleted;
 *   - entitlement: `outputEntitlementScope` per subject (workspace, or the
 *     personal account), the same reading every workspace aggregator uses.
 *
 * Subjects are enumerated from the backlog population itself, so the cost is
 * one entitlement reading per subject that HAS a backlog. A subject whose
 * entitlement cannot be read is kept in the count (fail open, as the per-
 * workspace aggregators do): an unreadable plan must never hide a real gap.
 *
 * Compose under `AND` with a backlog predicate. It is not a population on its
 * own: a subject with no backlog has no arm here.
 */
export const OUTPUT_PRODUCING_LIFECYCLE_WHERE: Prisma.EvidenceWhereInput = {
  deletedAt: null,
  lifecycleState: { in: [...OUTPUT_PRODUCING_LIFECYCLE_STATE_LIST] as EvidenceLifecycleState[] },
};

/** Every record a backlog signal can name, before narrowing. */
const OUTPUT_BACKLOG_WHERE: Prisma.EvidenceWhereInput = {
  OR: [
    { status: "SIGNED", latestReportVersion: null },
    { status: "REPORTED", verificationPackageVersion: null },
  ],
};

/** Bounded: beyond this many subjects the narrowing keeps lifecycle only. */
const MAX_BACKLOG_SUBJECTS = 2000;

export async function owedOutputNarrowing(
  client: PrismaClient = defaultPrisma,
): Promise<Prisma.EvidenceWhereInput> {
  let rows: Array<{ teamId: string | null; ownerUserId: string }>;
  try {
    rows = await client.evidence.findMany({
      where: { AND: [OUTPUT_BACKLOG_WHERE, OUTPUT_PRODUCING_LIFECYCLE_WHERE] },
      distinct: ["teamId", "ownerUserId"],
      select: { teamId: true, ownerUserId: true },
      take: MAX_BACKLOG_SUBJECTS + 1,
    });
  } catch {
    return OUTPUT_PRODUCING_LIFECYCLE_WHERE;
  }
  if (rows.length > MAX_BACKLOG_SUBJECTS) return OUTPUT_PRODUCING_LIFECYCLE_WHERE;

  const teams = new Set<string>();
  const owners = new Set<string>();
  for (const r of rows) {
    if (r.teamId) teams.add(r.teamId);
    else owners.add(r.ownerUserId);
  }
  const arms: Prisma.EvidenceWhereInput[] = await Promise.all([
    ...[...teams].map(async (teamId): Promise<Prisma.EvidenceWhereInput> => {
      const scope = await outputEntitlementScope({ teamId });
      return scope.kind === "NARROW" ? { AND: [{ teamId }, scope.where] } : { teamId };
    }),
    ...[...owners].map(async (ownerUserId): Promise<Prisma.EvidenceWhereInput> => {
      const scope = await outputEntitlementScope({ teamId: null, ownerUserId });
      const subject: Prisma.EvidenceWhereInput = { teamId: null, ownerUserId };
      return scope.kind === "NARROW" ? { AND: [subject, scope.where] } : subject;
    }),
  ]);
  return {
    AND: [OUTPUT_PRODUCING_LIFECYCLE_WHERE, { OR: arms.length > 0 ? arms : [{ id: { in: [] } }] }],
  };
}
