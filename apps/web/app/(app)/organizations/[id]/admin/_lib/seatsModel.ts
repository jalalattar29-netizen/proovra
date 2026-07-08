/**
 * Phase 4 (Enterprise Administration) — Seats derivation model.
 *
 * Pure logic that turns REAL, already-exposed org data into a seat posture.
 * NO new endpoints. Inputs come from:
 *
 *   - GET /v1/orgs/:id/workspaces  → per-workspace billing block
 *     (includedSeats, overSeatLimit, billingOwnerUserId) for ORG_ADMIN+ /
 *     ORG_BILLING_ADMIN callers (organizations.routes.ts).
 *   - GET /v1/orgs/:id             → summary.memberCount (used seats).
 *   - GET /v1/orgs/:id/invites     → summary.totalPending (pending impact).
 *
 * Seats live on the Team (workspace) records; the org "included seats" is the
 * SUM of its workspaces' includedSeats. "Used" seats = current org member
 * count (each member consumes one org seat). This is a read-only summary — the
 * only mutations remain the existing member/invite ones. Enterprise plans have
 * NO self-serve checkout: over-limit surfaces a contact-sales CTA.
 */

export interface WorkspaceBilling {
  includedSeats: number | null;
  overSeatLimit: boolean | null;
  billingOwnerUserId: string | null;
}

export interface SeatsInput {
  /** Workspaces the caller can see billing for (billing block present). */
  workspaces: ReadonlyArray<WorkspaceBilling>;
  /** Current confirmed org members = used seats. */
  memberCount: number;
  /** Pending (unaccepted) invites — each will consume a seat on accept. */
  pendingInviteCount: number;
}

export interface SeatsPosture {
  /** Sum of includedSeats across visible workspaces (null-safe). */
  includedSeats: number;
  /** Used seats = confirmed members. */
  usedSeats: number;
  /** Pending invites that will consume seats when accepted. */
  pendingSeats: number;
  /** usedSeats + pendingSeats — the projected consumption. */
  projectedSeats: number;
  /** includedSeats - usedSeats, floored at nothing (can go negative). */
  remainingSeats: number;
  /** True when confirmed members already exceed included seats. */
  overSeatLimit: boolean;
  /** True when accepting all pending invites WOULD exceed the cap. */
  projectedOverLimit: boolean;
  /** Any workspace whose own overSeatLimit flag is set. */
  anyWorkspaceOverLimit: boolean;
  /** Distinct billing-owner user ids across visible workspaces. */
  billingOwnerUserIds: ReadonlyArray<string>;
  /** Whether the caller could see any billing data at all. */
  hasBillingVisibility: boolean;
  /** Severity for the UI banner. */
  status: SeatStatus;
}

export type SeatStatus = "ok" | "warning" | "over";

/**
 * Derive the org seat posture from visible workspace billing + counts.
 * Deterministic and side-effect free so it can be unit-tested directly.
 */
export function deriveSeatsPosture(input: SeatsInput): SeatsPosture {
  const includedSeats = input.workspaces.reduce(
    (sum, w) => sum + (w.includedSeats ?? 0),
    0,
  );
  const usedSeats = Math.max(0, input.memberCount);
  const pendingSeats = Math.max(0, input.pendingInviteCount);
  const projectedSeats = usedSeats + pendingSeats;
  const remainingSeats = includedSeats - usedSeats;

  const hasBillingVisibility = input.workspaces.some(
    (w) => w.includedSeats !== null && w.includedSeats !== undefined,
  );

  const anyWorkspaceOverLimit = input.workspaces.some(
    (w) => w.overSeatLimit === true,
  );

  // Only treat "over" as meaningful when we actually know the cap.
  const overSeatLimit =
    hasBillingVisibility &&
    (includedSeats > 0
      ? usedSeats > includedSeats || anyWorkspaceOverLimit
      : anyWorkspaceOverLimit);

  const projectedOverLimit =
    hasBillingVisibility && includedSeats > 0 && projectedSeats > includedSeats;

  const billingOwnerUserIds = Array.from(
    new Set(
      input.workspaces
        .map((w) => w.billingOwnerUserId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  let status: SeatStatus = "ok";
  if (overSeatLimit) {
    status = "over";
  } else if (projectedOverLimit) {
    status = "warning";
  }

  return {
    includedSeats,
    usedSeats,
    pendingSeats,
    projectedSeats,
    remainingSeats,
    overSeatLimit,
    projectedOverLimit,
    anyWorkspaceOverLimit,
    billingOwnerUserIds,
    hasBillingVisibility,
    status,
  };
}
