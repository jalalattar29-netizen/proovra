/**
 * Operations Center filter/action policy — PURE functions so the
 * grouping, gating, and action-visibility rules are unit-testable
 * runtime behavior (not source-string assertions).
 *
 * Visibility model (2026-07-15 — participation + actual-item override):
 *   VISIBLE = STATIC ELIGIBILITY  ||  AN AUTHORIZED ITEM EXISTS
 *
 *   - STATIC ELIGIBILITY is the backend-derived plan + workspace type +
 *     role/capability + participation projection (OperationsUiContext).
 *   - THE OVERRIDE reads the aggregation's filter-independent
 *     `scopeSummary.byCategory` / `scopeSummary.deadlines` — every count
 *     there is already membership/role-authorized by the aggregation, so
 *     a real item can REVEAL a category that static eligibility hides (an
 *     incoming Team invitee mentioned in a paid workspace, a downgraded
 *     user's historical assignment). It never HIDES a category.
 *   - A capability-gated chip with neither eligibility nor an item never
 *     renders. The ACTIVE filter is always visible even while collapsed.
 *
 * The SAME predicate is consumed by the Operations Center filters and the
 * Notification Preferences groups (one domain rule, multiple consumers).
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

/**
 * THE NOTIFICATION FILTER ROW.
 *
 * `snoozed` left BOTH rows when the "Remind me tomorrow" action was withdrawn
 * from the UI. A filter for a state the reader can no longer create is a chip
 * that is permanently empty, and its eligibility is universal — there is no
 * category signal that could reveal it only when it has contents — so leaving
 * it in "More filters" would show everyone an empty view forever.
 *
 * Nothing is stranded by that. A snoozed item is hidden only until its
 * reminder falls due, at which point it returns to the ordinary list on its
 * own. The key, the backend state and `POST .../snooze` are all untouched, so
 * an API client that sets one still works and the item still comes back.
 *
 * `history` stays, renamed to "Archived" at the label: what it shows is the
 * reader's own archived notifications, not the resolved-condition history that
 * /operations owns.
 */
export const PRIMARY_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> = [
  "all",
  "unread",
  "critical",
  "failures",
  "integrity",
  "assigned_to_me",
  "review",
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

/** The subset of resolver context the visibility policy consumes. */
export type FilterPolicyContext = Pick<
  OperationsUiContext,
  | "canViewAdminAttention"
  | "canReceiveGovernance"
  | "canUseReports"
  | "canUseVerificationPackages"
  | "canUseIntake"
  | "canParticipateInReviews"
  | "canReceiveAssignments"
  | "canCollaborate"
  | "hasPendingInvitation"
  | "hasEligibleDeadlineSource"
>;

// ---------------------------------------------------------------------------
// Actual-item override signal — a THIN projection of the aggregation's
// filter-independent scope summary. Every count is already backend-
// authorized; this only ever REVEALS a category, never hides one.
// ---------------------------------------------------------------------------

/** The inbox categories the override reasons about (mirrors the backend
 *  scopeSummary.byCategory keys — the aggregation is the source of truth). */
export type InboxCategoryKey =
  | "onboarding"
  | "org_invite"
  | "org_admin"
  | "governance"
  | "review_decision"
  | "discussion_mention"
  | "discussion_assigned"
  | "review_escalation"
  | "access_review_pending"
  | "mfa_recovery_pending"
  | "communication_failure"
  | "security_event_high"
  | "report_failure"
  | "verification_package_failure"
  | "ots_failure"
  | "intake_submission_pending_review"
  | "intake_required_items_missing"
  | "intake_link_expiring"
  | "collaboration"
  | "tsa_failure"
  | "case_assignment";

export type ActualItemSignal = {
  byCategory: Partial<Record<InboxCategoryKey, number>>;
  deadlines: { dueSoon: number; overdue: number };
};

export const NO_ACTUAL_ITEMS: ActualItemSignal = {
  byCategory: {},
  deadlines: { dueSoon: 0, overdue: 0 },
};

/**
 * Build the override signal from an inbox `scopeSummary`. Accepts the raw
 * envelope block (may be undefined on History responses or a degraded
 * fetch) and normalises it. Shared by the Operations Center page and the
 * Notification Preferences panel so both apply the identical predicate.
 */
export function buildActualItemSignal(
  scopeSummary:
    | {
        byCategory?: Partial<Record<string, number>>;
        deadlines?: { dueSoon?: number; overdue?: number };
      }
    | null
    | undefined,
): ActualItemSignal {
  if (!scopeSummary) return NO_ACTUAL_ITEMS;
  return {
    byCategory: (scopeSummary.byCategory ?? {}) as Partial<
      Record<InboxCategoryKey, number>
    >,
    deadlines: {
      dueSoon: scopeSummary.deadlines?.dueSoon ?? 0,
      overdue: scopeSummary.deadlines?.overdue ?? 0,
    },
  };
}

function anyCategory(
  sig: ActualItemSignal,
  cats: ReadonlyArray<InboxCategoryKey>,
): boolean {
  return cats.some((c) => (sig.byCategory[c] ?? 0) > 0);
}

/**
 * Does a real, authorized item exist for this filter in the current scope?
 * The category membership mirrors the backend FILTER_CATEGORY_MEMBERS map.
 */
function hasActualItem(key: OperationsFilterKey, sig: ActualItemSignal): boolean {
  switch (key) {
    case "reports":
      return anyCategory(sig, ["report_failure"]);
    case "packages":
      return anyCategory(sig, ["verification_package_failure"]);
    case "intake":
      return anyCategory(sig, [
        "intake_submission_pending_review",
        "intake_required_items_missing",
        "intake_link_expiring",
      ]);
    case "review":
      return anyCategory(sig, [
        "review_decision",
        "review_escalation",
        "intake_submission_pending_review",
      ]);
    case "assigned_to_me":
      return anyCategory(sig, [
        "discussion_assigned",
        "review_escalation",
        "case_assignment",
      ]);
    case "mentions":
      return anyCategory(sig, ["discussion_mention"]);
    case "collaboration":
      return anyCategory(sig, [
        "collaboration",
        "discussion_mention",
        "discussion_assigned",
      ]);
    case "invitations":
      return anyCategory(sig, ["org_invite"]);
    case "governance":
      // intake_link_expiring is an INTAKE deadline, NOT governance — it is
      // deliberately excluded here so a real expiring-link item cannot
      // re-reveal the Governance chip (mirrors the backend
      // FILTER_CATEGORY_MEMBERS.governance membership).
      return anyCategory(sig, ["governance", "access_review_pending"]);
    case "admin":
      return anyCategory(sig, [
        "org_admin",
        "mfa_recovery_pending",
        "communication_failure",
        "report_failure",
        "verification_package_failure",
        "intake_submission_pending_review",
        "intake_link_expiring",
      ]);
    case "due_soon":
      return sig.deadlines.dueSoon > 0;
    case "overdue":
      return sig.deadlines.overdue > 0;
    default:
      return false;
  }
}

/**
 * STATIC eligibility (plan + participation + role + capability) per the
 * commercial contract. Classification (2026-07-15):
 *   - PLAN-GATED own-workflow: reports, packages, intake.
 *   - PARTICIPATION-GATED: review (reviewer participation), assigned_to_me
 *     (a real assignment source), mentions + collaboration (active shared-
 *     space membership), invitations (a pending invite).
 *   - DEADLINE-SOURCED: due_soon / overdue (a reachable deadline source).
 *   - ROLE-GATED: admin (org OWNER/ADMIN).
 *   - CAPABILITY-GATED: governance (GOVERNANCE_VIEW; Pro Personal = false).
 *   - UNIVERSAL CORE: everything else, incl. security (personal security is
 *     universal; admin-security items are aggregation-gated to admins and
 *     never reach an ordinary member, so the filter is safe to always show).
 */
function eligibleByPolicy(
  key: OperationsFilterKey,
  ctx: FilterPolicyContext,
): boolean {
  switch (key) {
    case "admin":
      return ctx.canViewAdminAttention;
    case "governance":
      return ctx.canReceiveGovernance;
    case "reports":
      return ctx.canUseReports;
    case "packages":
      return ctx.canUseVerificationPackages;
    case "intake":
      return ctx.canUseIntake;
    case "review":
      return ctx.canParticipateInReviews;
    case "assigned_to_me":
      return ctx.canReceiveAssignments;
    case "mentions":
    case "collaboration":
      return ctx.canCollaborate;
    case "invitations":
      return ctx.hasPendingInvitation;
    case "due_soon":
    case "overdue":
      return ctx.hasEligibleDeadlineSource;
    default:
      // all, unread, critical, failures, integrity, security, snoozed,
      // history — universal operational core.
      return true;
  }
}

/**
 * The canonical visibility decision: static eligibility OR an authorized
 * item exists. Used identically by the filter chips and the preference
 * groups (via `preferenceGroupVisible`).
 */
export function filterAllowed(
  key: OperationsFilterKey,
  ctx: FilterPolicyContext,
  items: ActualItemSignal = NO_ACTUAL_ITEMS,
): boolean {
  if (eligibleByPolicy(key, ctx)) return true;
  return hasActualItem(key, items);
}

export function visiblePrimaryFilters(
  ctx: FilterPolicyContext,
  activeFilter: OperationsFilterKey,
  items: ActualItemSignal = NO_ACTUAL_ITEMS,
): OperationsFilterKey[] {
  const primary = PRIMARY_OPERATIONS_FILTERS.filter((k) =>
    filterAllowed(k, ctx, items),
  );
  // The active filter must never be invisible: promote an active
  // secondary filter into the primary row while it is selected.
  if (!primary.includes(activeFilter) && filterAllowed(activeFilter, ctx, items)) {
    return [...primary, activeFilter];
  }
  return primary;
}

export function visibleSecondaryFilters(
  ctx: FilterPolicyContext,
  activeFilter: OperationsFilterKey,
  items: ActualItemSignal = NO_ACTUAL_ITEMS,
): OperationsFilterKey[] {
  return SECONDARY_OPERATIONS_FILTERS.filter(
    (k) => filterAllowed(k, ctx, items) && k !== activeFilter,
  );
}

// ---------------------------------------------------------------------------
// Notification Preferences group visibility — the SAME predicate, keyed to
// the group's operational domain. A group shows when its domain filter is
// allowed (eligibility OR a real item). Governance/reviews/intake are the
// gated groups; collaboration + integrity are universal-when-relevant.
// ---------------------------------------------------------------------------

export type PreferenceGroupDomain =
  | "integrity"
  | "review"
  | "intake"
  | "collaboration"
  | "governance";

export function preferenceGroupVisible(
  domain: PreferenceGroupDomain,
  ctx: FilterPolicyContext,
  items: ActualItemSignal = NO_ACTUAL_ITEMS,
): boolean {
  switch (domain) {
    case "integrity":
      // Evidence-integrity failures are universal operational signals.
      return true;
    case "review":
      return filterAllowed("review", ctx, items);
    case "intake":
      return filterAllowed("intake", ctx, items);
    case "collaboration":
      return filterAllowed("collaboration", ctx, items);
    case "governance":
      return filterAllowed("governance", ctx, items);
    default:
      return true;
  }
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
