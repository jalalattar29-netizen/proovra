/**
 * PHASE 12 REMEDIATION — §6.1 / COMM-001 (2026-08-06).
 *
 * THE seat/member occupancy authority. One implementation, shared by the API
 * and the worker, so the two can never disagree about how many seats a
 * workspace occupies.
 *
 * The defect this replaces
 * -----------------------
 * `billing.service.ts:cancelTeamPlan` and `worker/workspace-billing.ts` each
 * counted occupancy with `prisma.teamMember.count({ where: { teamId } })` —
 * no status predicate. SUSPENDED and REVOKED members therefore OCCUPIED
 * SEATS in the arithmetic:
 *
 *   * a workspace whose members had all been revoked was still marked
 *     `overSeatLimit = memberCount > 0` on cancellation;
 *   * worker-side seat reconciliation overstated occupancy, so a workspace
 *     could be reported over its plan limit on the strength of members who
 *     hold no access at all.
 *
 * Meanwhile `identity/rbac.service.ts` — the module that enforces the seat
 * LIMIT on invite — counted `{ status: "ACTIVE" }`. Two arithmetics for one
 * quantity, and they disagreed.
 *
 * The policy, stated once
 * -----------------------
 * A seat is occupied by a membership that CURRENTLY GRANTS ACCESS. That is
 * exactly `teamMemberStatusGrantsAccess`, the same predicate the canonical
 * access-policy engine uses to decide whether a member may operate. A member
 * who cannot enter the workspace does not occupy one of its seats.
 *
 * PENDING/INVITED occupancy is deliberately NOT redefined here: this module
 * reports what the canonical predicate says about the persisted status, and
 * the predicate is the single place that meaning lives.
 */

/**
 * Structural client type. Accepts a `PrismaClient` or a transaction client
 * from either host without importing Prisma's generated types into this
 * package (the two hosts generate their own clients).
 */
export type SeatOccupancyClient = {
  teamMember: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
};

/**
 * The canonical Prisma `where` fragment for "memberships that occupy a seat
 * in this workspace".
 *
 * Exported so a caller that must combine occupancy with other predicates in
 * ONE query composes the same fragment instead of writing `status: "ACTIVE"`
 * for itself. Spread it; do not re-type it.
 */
export function activeSeatMembershipWhere(teamId: string): {
  teamId: string;
  status: "ACTIVE";
} {
  return { teamId, status: "ACTIVE" };
}

/**
 * How many seats workspace `teamId` currently occupies.
 *
 * Counts only memberships that grant access. Revoked and suspended members
 * are excluded, as are workspaces with no members at all (0).
 */
export async function countActiveSeatOccupancy(
  input: { teamId: string },
  client: SeatOccupancyClient,
): Promise<number> {
  return client.teamMember.count({
    where: activeSeatMembershipWhere(input.teamId),
  });
}

// DELIBERATELY NOT DEFINED HERE: "is this workspace over its seat ceiling?"
//
// That rule already has exactly ONE authority —
// `services/api/src/services/billing.service.ts:computeOverSeatLimit`, where
// `includedSeats <= 0` means NO CEILING (unlimited), not "zero seats". A
// second ceiling function in this module would be the very duplication
// §6.1 exists to remove, and it would silently disagree with the canonical
// one about the `includedSeats: 0` case.
//
// This module owns the OCCUPANCY QUANTITY. `computeOverSeatLimit` owns the
// COMPARISON. Callers compose the two.
