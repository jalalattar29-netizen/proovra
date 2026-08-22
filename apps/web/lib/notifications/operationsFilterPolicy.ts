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
  | "archived"
  /** LEGACY wire name for `archived`; the API normalizes it. */
  | "history";

/**
 * TWO LEVELS, NOT FIFTEEN CHIPS.
 *
 * This shipped as one permanently-rendered row of every filter the reader was
 * eligible for, plus a "More filters" row that unfolded the rest — up to
 * fifteen pills competing with the metric cards directly above them. It did
 * not scale (every new category made it longer), it did not read as
 * enterprise software, and it gave a rarely-used filter exactly as much of the
 * page as `All`.
 *
 * The model is now:
 *
 *   QUICK      three chips, always visible, always the same three. These are
 *              the lifecycle of a personal feed — everything, what I have not
 *              read, what I have filed away — and they are the only filters a
 *              reader touches on most visits.
 *
 *   ADVANCED   everything else, GROUPED, behind one `Filters` control that
 *              carries a count when something is applied.
 *
 * `snoozed` is in neither, deliberately: the reminder action was withdrawn
 * from the UI, its eligibility is universal (no category count could reveal it
 * selectively), so its chip could only ever have been empty for everyone. The
 * key and `POST .../snooze` are untouched, and a snoozed item still returns to
 * the list on its own when the reminder falls due.
 *
 * `critical` is in neither for a different reason: severity already has a
 * control on this page. The four tone metric cards toggle it, and a second
 * place to set the same axis is how two controls end up disagreeing about
 * which one is in force.
 *
 * `archived` is the canonical key. `history` was its name while the filter
 * meant "read OR archived"; that predicate is fixed server-side and the key is
 * renamed with it, so the label and the population finally agree.
 */
export const QUICK_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> = [
  "all",
  "unread",
  "archived",
];

/**
 * THE ADVANCED PANEL, GROUPED.
 *
 * Order within a group is stable and hand-chosen; groups are rendered in this
 * order. A group whose every member is hidden by eligibility renders no
 * heading — an empty labelled section reads as a loading failure.
 */
export interface OperationsFilterGroup {
  readonly id: "type" | "integrity" | "time";
  readonly label: string;
  readonly keys: ReadonlyArray<OperationsFilterKey>;
}

export const ADVANCED_OPERATIONS_FILTER_GROUPS: ReadonlyArray<OperationsFilterGroup> =
  [
    {
      id: "type",
      label: "Type",
      keys: [
        "mentions",
        "assigned_to_me",
        "collaboration",
        "invitations",
        "review",
        "intake",
        "reports",
        "packages",
        "governance",
        "security",
        "admin",
      ],
    },
    {
      id: "integrity",
      label: "Evidence & integrity",
      keys: ["integrity", "failures"],
    },
    { id: "time", label: "Time & urgency", keys: ["due_soon", "overdue"] },
  ];

/**
 * BACK-COMPATIBLE PROJECTIONS.
 *
 * The visibility policy below, its unit tests and the Notification Preferences
 * groups all reason over "primary" and "secondary" rows. Those names now
 * describe the quick row and the advanced panel's flattened contents, so one
 * eligibility rule still serves every consumer and no second predicate exists.
 */
export const PRIMARY_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> =
  QUICK_OPERATIONS_FILTERS;

export const SECONDARY_OPERATIONS_FILTERS: ReadonlyArray<OperationsFilterKey> =
  ADVANCED_OPERATIONS_FILTER_GROUPS.flatMap((g) => [...g.keys]);

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
      // archived — universal operational core.
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

/**
 * THE ADVANCED PANEL'S CONTENTS, eligibility-filtered and grouped.
 *
 * Unlike `visibleSecondaryFilters`, this does NOT drop the active key. That
 * exclusion exists because the old layout PROMOTED the active secondary filter
 * into the always-visible row, so leaving it in the overflow would have shown
 * it twice. A panel has no such row: the active filter has to stay where the
 * reader can see it is selected — and, more importantly, where they can click
 * it again to turn it off.
 *
 * A group with no eligible members is dropped entirely rather than rendered as
 * an empty heading, which reads as a section that failed to load.
 */
export function visibleAdvancedFilterGroups(
  ctx: FilterPolicyContext,
  items: ActualItemSignal = NO_ACTUAL_ITEMS,
): Array<{ id: OperationsFilterGroup["id"]; label: string; keys: OperationsFilterKey[] }> {
  return ADVANCED_OPERATIONS_FILTER_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    keys: g.keys.filter((k) => filterAllowed(k, ctx, items)),
  })).filter((g) => g.keys.length > 0);
}

/**
 * HOW MANY FILTERS ARE ACTUALLY APPLIED — the number on the `Filters` control.
 *
 * Counts the AXES that are narrowing the list, not the chips that exist. There
 * are three, and they are independent:
 *
 *   category    one of the advanced keys (the quick row's `all`/`unread`/
 *               `archived` are the page's own lifecycle state, not an advanced
 *               filter, so they never contribute to this badge — a reader who
 *               has simply clicked "Unread" has not "applied 1 filter")
 *   tone        set by the severity metric cards
 *   workspace   set by the workspace selector, when the reader has more than
 *               one
 *
 * Keeping this a pure function means the badge, the "clear all" affordance and
 * the tests all read the same rule.
 */
export function activeAdvancedFilterCount(input: {
  filter: OperationsFilterKey;
  tone: string;
  workspaceId: string;
}): number {
  let n = 0;
  if (!QUICK_OPERATIONS_FILTERS.includes(input.filter)) n += 1;
  if (input.tone !== "all") n += 1;
  if (input.workspaceId !== "all") n += 1;
  return n;
}
