/**
 * Operations Center filter/action policy — PURE functions so the
 * grouping, gating, and action-visibility rules are unit-testable
 * runtime behavior (not source-string assertions).
 *
 * Grouping model (enterprise overflow, no functionality removed):
 *   - PRIMARY chips render always: the stable attention core plus the
 *     highest-value evidence-operations pivots.
 *   - SECONDARY chips live behind a "More filters" disclosure.
 *   - A capability-gated chip (admin, governance) never renders at all
 *     for a user who can never receive that class of item.
 *   - The ACTIVE filter is always visible even while the overflow is
 *     collapsed, so state is never hidden.
 */

import type { OperationsUiContext } from "./useOperationsUiContext";

export type OperationsFilterKey =
  | "all"
  | "unread"
  | "critical"
  | "assigned_to_me"
  | "mentions"
  | "invitations"
  | "review"
  | "collaboration"
  | "governance"
  | "security"
  | "integrity"
  | "reports"
  | "packages"
  | "intake"
  | "failures"
  | "due_soon"
  | "overdue"
  | "admin"
  | "snoozed"
  | "history";

export const PRIMARY_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> = [
  "all",
  "unread",
  "critical",
  "failures",
  "integrity",
  "assigned_to_me",
  "review",
  "snoozed",
  "history",
];

export const SECONDARY_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> =
  [
    "mentions",
    "collaboration",
    "invitations",
    "reports",
    "packages",
    "intake",
    "due_soon",
    "overdue",
    "security",
    "governance",
    "admin",
  ];

/** Capability gate: which context flag (if any) a filter requires. */
function filterAllowed(
  key: OperationsFilterKey,
  ctx: Pick<
    OperationsUiContext,
    "canViewAdminAttention" | "canReceiveGovernance"
  >,
): boolean {
  if (key === "admin") return ctx.canViewAdminAttention;
  if (key === "governance") return ctx.canReceiveGovernance;
  return true;
}

export function visiblePrimaryFilters(
  ctx: Pick<
    OperationsUiContext,
    "canViewAdminAttention" | "canReceiveGovernance"
  >,
  activeFilter: OperationsFilterKey,
): OperationsFilterKey[] {
  const primary = PRIMARY_OPERATIONS_FILTERS.filter((k) =>
    filterAllowed(k, ctx),
  );
  // The active filter must never be invisible: promote an active
  // secondary filter into the primary row while it is selected.
  if (
    !primary.includes(activeFilter) &&
    filterAllowed(activeFilter, ctx)
  ) {
    return [...primary, activeFilter];
  }
  return primary;
}

export function visibleSecondaryFilters(
  ctx: Pick<
    OperationsUiContext,
    "canViewAdminAttention" | "canReceiveGovernance"
  >,
  activeFilter: OperationsFilterKey,
): OperationsFilterKey[] {
  return SECONDARY_OPERATIONS_FILTERS.filter(
    (k) => filterAllowed(k, ctx) && k !== activeFilter,
  );
}

/**
 * Bulk actions reflect reality: never offer a read action with nothing
 * unread in the workspace scope, and never offer the category-scoped
 * variant over an empty filtered result.
 */
export function shouldOfferMarkAllRead(scopeUnread: number): boolean {
  return scopeUnread > 0;
}

export function shouldOfferMarkCategoryRead(
  scopeUnread: number,
  filteredTotal: number,
  isCategoryFilter: boolean,
): boolean {
  return isCategoryFilter && scopeUnread > 0 && filteredTotal > 0;
}

/**
 * Severity tiles: a zero-count tile is informational-only (disabled)
 * unless it is the currently active tone — the user must always be
 * able to un-toggle their own selection.
 */
export function toneTileDisabled(count: number, isActive: boolean): boolean {
  return count === 0 && !isActive;
}
