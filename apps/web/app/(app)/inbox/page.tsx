"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

/**
 * Phase C — Operational Inbox.
 *
 * Caller-scoped operational attention stream. Renders the unified
 * `/v1/me/inbox` envelope as severity-ordered actionable rows. Every
 * row maps to a real backend signal:
 *
 *   - org_invite: an OrganizationInvite addressed to the caller, not
 *     yet accepted/revoked/expired.
 *   - org_admin: a rollup of pending invites in an org the caller
 *     administers.
 *   - governance: an unacknowledged GovernanceNotification for a
 *     team the caller is a member of.
 *   - onboarding: derived membership / identity state.
 *
 * Hard rules (carried from the Phase C brief):
 *   - No fake AI. No invented signals. No noisy duplicates.
 *   - Items are sourced from unresolved backend state — an item
 *     disappears when the underlying record is resolved (invite
 *     accepted / governance acknowledged / org joined). On TOP of that
 *     source truth, per-user read / dismiss / snooze state persists in
 *     the `InboxItemState` table (unique per user + itemKey) via the
 *     /read /unread /dismiss /snooze endpoints — this is real, not
 *     local UI state.
 *   - No cross-org leak. The endpoint is caller-scoped server-side.
 *   - Every CTA is a real registered route. No invented destinations.
 *   - Honest "deferred" panel documents what is NOT delivered (push,
 *     email digests, notification preferences UI, cross-workspace
 *     failed-report aggregation, etc.) so operators have accurate
 *     expectations.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, RefreshCw, SlidersHorizontal, X } from "lucide-react";

import { apiFetch } from "../../../lib/api";
import { useLatestRequest } from "../../../lib/net/useLatestRequest";
import { formatUserDate, formatUserDateTime } from "../../../lib/date";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { AppListbox } from "../../../components/app-primitives";
import { AppAnchoredOverlay } from "../../../components/app-primitives/AppAnchoredOverlay";
import {
  useOrganizations,
  usePersonalSpace,
} from "../../../lib/platform-context";
import { useOperationsUiContext } from "../../../lib/notifications/useOperationsUiContext";
import {
  buildActualItemSignal,
  visibleAdvancedFilterGroups,
  QUICK_OPERATIONS_FILTERS,
  SECONDARY_OPERATIONS_FILTERS,
  type OperationsFilterKey,
  activeAdvancedFilterCount,
} from "../../../lib/notifications/operationsFilterPolicy";

type InboxTone = "info" | "warning" | "high" | "critical";
type InboxCategory =
  | "onboarding"
  | "org_invite"
  | "org_admin"
  | "governance"
  | "review_decision"
  // Phase C2 — operational evidence collaboration signals.
  | "discussion_mention"
  | "discussion_assigned"
  // Phase IA-cleanup — post-/collaboration attention expansion.
  | "review_escalation"
  | "access_review_pending"
  | "mfa_recovery_pending"
  | "communication_failure"
  | "security_event_high"
  // Phase IA-enterprise — operational failure surfacing.
  | "report_failure"
  | "verification_package_failure"
  | "ots_failure"
  // Phase IA-reliability — intake action signals.
  | "intake_submission_pending_review"
  | "intake_required_items_missing"
  | "intake_link_expiring"
  // Collaboration-team notifications (read state shared with Team pages).
  | "collaboration"
  // Forensic completion — RFC3161 timestamping failures + real case
  // assignments (CaseAssignment, status ACTIVE).
  | "tsa_failure"
  | "case_assignment";

// Phase IA-enterprise — operator-priority tier. Mirrors the backend
// `InboxPriority` so the section-grouping render reads the server's
// authoritative classification.
type InboxPriority = "P1" | "P2" | "P3" | "P4" | "P5";

type InboxItem = {
  id: string;
  /** Phase IA-reliability — server-supplied state key. By convention
   * `itemKey === id` but we store it as a distinct field so the
   * mutation endpoints can take it as a path parameter. */
  itemKey: string;
  category: InboxCategory;
  tone: InboxTone;
  /** Phase IA-enterprise — server-assigned priority tier. */
  priority: InboxPriority;
  title: string;
  body: string;
  href: string;
  occurredAt: string;
  /** Optional real deadline from the source row; never fabricated. */
  dueAt?: string | null;
  /** Phase IA-reliability — per-user state from the
   * /v1/me/inbox/items/:itemKey/{read,unread,dismiss,snooze} endpoints. */
  isRead: boolean;
  readAt?: string | null;
  dismissedAt?: string | null;
  snoozedUntil?: string | null;
  /** History (snapshot-backed) rows only — when the canonical source
   * resolved the item upstream. */
  /** LEGACY NAME. See `sourceClearedAt` — this is a NOTIFICATION-history
   *  fact (the source stopped addressing this to me), never the shared
   *  Operations lifecycle status. */
  resolvedAt?: string | null;
  /** PHASE 2.1 — canonical name. When the canonical source stopped emitting
   *  this item for THIS user. Says nothing about whether the underlying
   *  workspace condition was resolved; Operations owns that. */
  sourceClearedAt?: string | null;
  canMarkRead: boolean;
  canDismiss: boolean;
  canSnooze: boolean;
  context: Record<string, string | number | null>;
};

// Phase IA-cleanup + enterprise — per-category truncation flags from
// the backend. "truncated" means the source query hit its bounded
// limit and the inbox didn't pull every matching row; the UI's
// "Showing X of Y" indicator + per-category note reads from this.
type InboxTruncated = Record<
  | "governance"
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
  | "case_assignment",
  boolean
>;

// Phase IA-enterprise — pagination block returned by the backend.
type InboxPagination = {
  offset: number;
  pageSize: number;
  returned: number;
  nextCursor: string | null;
  totalEstimate: number;
  totalIsExact: boolean;
  appliedFilter: string;
  appliedTone: InboxTone | null;
};

type InboxEnvelope = {
  generatedAt: string;
  caller: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
  summary: {
    total: number;
    byTone: Record<InboxTone, number>;
    byCategory: Record<InboxCategory, number>;
    byPriority?: Record<InboxPriority, number>;
  };
  /** HYBRID contract — workspace-scope ACTIVE totals, independent of
   * the category/tone filter. Absent on History responses. */
  scopeSummary?: {
    total: number;
    unread: number;
    byTone: Record<InboxTone, number>;
    /** Filter-independent per-category presence — the actual-item override
     *  signal (backend-authorized). Reveals a category chip that static
     *  eligibility would hide. */
    byCategory?: Partial<Record<InboxCategory, number>>;
    /** Filter-independent deadline posture — powers due_soon / overdue
     *  filter eligibility. */
    deadlines?: { dueSoon: number; overdue: number };
  };
  /**
   * THE METRIC-CARD BASIS — the population the six cards describe.
   *
   * Narrowed by the ADVANCED axes the reader has applied (lifecycle,
   * category, workspace) and NOT by the two the cards themselves set (tone,
   * read-state). That combination is what keeps the row useful: every card
   * answers "how many would I get if I picked this one instead", over
   * whatever the advanced filters currently allow.
   *
   * Distinct from `scopeSummary`, which is deliberately filter-INDEPENDENT
   * because it drives the filter-chip reveal and must not shrink when a
   * filter narrows. The cards used to read that one, which is why selecting
   * Archived showed the ACTIVE severity distribution above a list of archived
   * rows.
   *
   * Server-computed over the FULL filtered population, never the loaded page —
   * so paging cannot move a card's number.
   */
  metricSummary?: {
    total: number;
    unread: number;
    byTone: Record<InboxTone, number>;
  };
  truncated?: InboxTruncated;
  anyTruncated?: boolean;
  /**
   * ATTENTION ARCHITECTURE PHASE 2.3 (2026-08-22) — DEGRADED-STATE HONESTY.
   *
   * `degraded` says a source threw; `anyTruncated` says a source was capped.
   * Both mean the same thing to the person reading the screen — "you are not
   * looking at everything" — and leaving them as two separate flags is how one
   * banner ends up checking only one of them. This carries the per-source
   * verdict, the reason, and the single boolean any surface must read before
   * it is allowed to print a reassuring number.
   */
  completeness?: {
    anyIncomplete: boolean;
    incompleteSources: string[];
    mayAssertAllClear: boolean;
  };
  /** History responses only — false when the persistent snapshot store
   * is not provisioned in this environment. */
  historyAvailable?: boolean;
  pagination?: InboxPagination;
  items: InboxItem[];
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: InboxEnvelope }
  | { kind: "error"; status: number; message: string };

// Tone visuals live in notifications.css (`.ops-*[data-tone]`); the
// page only supplies the label.
/**
 * The PRIMARY VIEW labels — the reader-facing name of each of the six
 * alternatives. Separate from `TONE_LABELS`, which is the all-caps badge
 * vocabulary a notification ROW wears, and separate from
 * `INBOX_FILTER_LABELS`, which names the category filters. Three different
 * jobs; one map each, so a rename in one cannot silently move the others.
 */
const PRIMARY_VIEW_LABELS: Record<PrimaryView, string> = {
  all: "All",
  unread: "Unread",
  critical: "Critical",
  high: "High",
  warning: "Warning",
  info: "Info",
};

const TONE_LABELS: Record<InboxTone, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  warning: "WARNING",
  info: "INFO",
};

/**
 * THE NOTIFICATION SUMMARY, AS METRIC CARDS.
 *
 * These were inline pills beside a running count — visually the weakest thing
 * on the page, and inconsistent with how every other PROOVRA surface presents
 * a row of figures. They are now the canonical `.app-metric-card`, the same
 * primitive Intake Links uses for its KPI row.
 *
 * They are still FILTERS, not a breakdown: `Unread` narrows by read state and
 * the four severities narrow by tone, so the counts deliberately do not sum to
 * `All`. Each card says what it means in its own words rather than leaving the
 * reader to discover that by adding them up.
 *
 * ORDER is by what a person opening their notifications actually asks: what
 * did I miss (Unread), how much is there (All), and then severity descending.
 *
 * `accent` names a TONE, never a colour. The stylesheet resolves it to the
 * canonical `--ops-tone-*` tokens, so this list cannot become a second place
 * where "critical" is decided.
 */
/**
 * THE PRIMARY VIEW. Six alternatives, and the metric cards ARE its control.
 *
 * Named as one type rather than assembled from "a filter" and "a tone" so the
 * mutual exclusion is a property of the model instead of a rule the UI has to
 * remember to enforce. Nothing can hold two of these at once.
 */
type PrimaryView = "all" | "unread" | InboxTone;

/** The metric cards and the quick-filter chips are two controls over the SAME
 *  value, which is why they always agree about what is selected. */
type NotificationMetricKey = PrimaryView;

/** The two the quick row shows permanently. Archived is a STATUS and lives in
 *  the Filters panel; the four severities live on the cards. */
const QUICK_PRIMARY_VIEWS: ReadonlyArray<PrimaryView> = ["all", "unread"];

const PRIMARY_VIEW_VALUES: ReadonlyArray<PrimaryView> = [
  "all",
  "unread",
  "critical",
  "high",
  "warning",
  "info",
];

function isPrimaryView(v: string | null | undefined): v is PrimaryView {
  return !!v && PRIMARY_VIEW_VALUES.includes(v as PrimaryView);
}

const NOTIFICATION_METRICS: ReadonlyArray<{
  key: NotificationMetricKey;
  label: string;
  explanation: string;
  accent: string;
  /** Severity cards filter by tone; Unread and All do not. */
  tone?: InboxTone;
}> = [
  /* ALL LEADS. It is the population every other card is a subset of, and it
     is the state the page opens in, so the row reads left-to-right from
     "everything" into the narrowings of it. */
  {
    key: "all",
    label: "All",
    explanation: "Everything currently addressed to you.",
    accent: "all",
  },
  {
    key: "unread",
    label: "Unread",
    explanation: "Not opened yet.",
    accent: "unread",
  },
  {
    key: "critical",
    label: "Critical",
    explanation: "Needs attention now.",
    accent: "critical",
    tone: "critical",
  },
  {
    key: "high",
    label: "High",
    explanation: "Important, not urgent.",
    accent: "high",
    tone: "high",
  },
  {
    key: "warning",
    label: "Warning",
    explanation: "Worth a look.",
    accent: "warning",
    tone: "warning",
  },
  {
    key: "info",
    label: "Info",
    explanation: "For your awareness.",
    accent: "info",
    tone: "info",
  },
];

const CATEGORY_LABELS: Record<InboxCategory, string> = {
  onboarding: "Onboarding",
  org_invite: "Invite",
  org_admin: "Org governance",
  governance: "Workspace governance",
  review_decision: "Review decision",
  // Phase C2 — operational discussion routing.
  discussion_mention: "Mention",
  discussion_assigned: "Assigned thread",
  // Phase IA-cleanup — post-/collaboration attention expansion.
  review_escalation: "Escalation",
  access_review_pending: "Access review",
  mfa_recovery_pending: "MFA approval",
  communication_failure: "Delivery failure",
  security_event_high: "Security alert",
  // Phase IA-enterprise — operational failures.
  report_failure: "Report failure",
  verification_package_failure: "Package failure",
  ots_failure: "OTS failure",
  // Phase IA-reliability — intake actions.
  intake_submission_pending_review: "Intake review",
  intake_required_items_missing: "Intake incomplete",
  intake_link_expiring: "Link expiring",
  collaboration: "Collaboration",
  tsa_failure: "Timestamp failure",
  case_assignment: "Case assignment",
};

/* PRIORITY_META and PRIORITY_ORDER USED TO LIVE HERE.

   They supplied the "P1 · Critical — act now." section headings the list no
   longer renders. The server still assigns a priority and each row still
   carries it on `data-inbox-item-priority` for tests and analytics; what is gone
   is this page's vocabulary for turning it into an operations-queue heading.
   /operations keeps its own, unchanged. */

// Phase IA-enterprise — server-driven enterprise filter chips. Every
// key maps 1:1 to the backend's `InboxFilter` enum (validated by the
// Zod schema on `/v1/me/inbox`). The server applies the filter so
// admin-only items never reach a non-admin even via crafted requests.
/**
 * THE FILTER VOCABULARY, from its ONE definition.
 *
 * This was a second hand-maintained copy of the same union — identical to the
 * policy module's `OperationsFilterKey` except for whichever key had most
 * recently been added to one and not the other, which is exactly what happened
 * when `archived` landed. Aliasing removes the second authority rather than
 * teaching it the new word.
 */
type InboxFilter = OperationsFilterKey;

/** Runtime membership test for a query-string value. Derived from the two
 *  canonical rows so it cannot drift from the union. */
const ALL_INBOX_FILTERS: ReadonlyArray<InboxFilter> = [
  ...QUICK_OPERATIONS_FILTERS,
  ...SECONDARY_OPERATIONS_FILTERS,
];

const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: "All",
  unread: "Unread",
  critical: "Critical",
  assigned_to_me: "Assigned to me",
  mentions: "Mentions",
  invitations: "Invitations",
  review: "Reviews",
  collaboration: "Collaboration",
  governance: "Governance",
  security: "Security",
  integrity: "Integrity",
  reports: "Reports",
  packages: "Verification packages",
  intake: "Intake",
  failures: "Failures",
  due_soon: "Due soon",
  overdue: "Overdue",
  admin: "Admin",
  /* NOTIFICATION VOCABULARY, not operational lifecycle.
     "Snoozed" named a reminder action this UI no longer exposes, and
     "History" named the resolved-condition history that belongs to
     /operations. What this filter actually shows is the reader's own archived
     notifications, so it says that. */
  snoozed: "Reminders",
  archived: "Archived",
  /* The legacy wire name for `archived`. It is never rendered — the label
     exists so an envelope echoing `appliedFilter: "history"` from a client
     that predates the rename cannot print `undefined` at the reader. */
  history: "Archived",
};

/**
 * SORT — four orderings, and each one is a QUESTION the reader is asking.
 *
 * The server owns every one of them: the selected sort is sent as a query
 * parameter, applied to the FULL population, and the page is sliced from the
 * ordered result. Nothing here reorders the rows the browser happens to hold,
 * because doing that would order page 1 correctly and page 2 by itself.
 *
 * "Due soon" is deliberately ABSENT. A due date exists only on the minority of
 * notifications whose source carries one, so an ordering built on it would
 * silently be an ordering of "the few with dates, then everything else in some
 * other order" — and inventing dates for the rest to make the control look
 * complete is the one thing it must not do.
 */
const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "unread_first", label: "Unread first" },
  { value: "severity", label: "Highest severity" },
] as const;

type InboxSort = (typeof SORT_OPTIONS)[number]["value"];

const DEFAULT_SORT: InboxSort = "newest";

function isInboxSort(v: string | null | undefined): v is InboxSort {
  return SORT_OPTIONS.some((o) => o.value === v);
}

/* `isCategoryFilter` USED TO LIVE HERE.

   It decided whether to offer "Mark <category> as read" beside "Mark all as
   read". Both buttons are gone from this page, so the predicate had no
   caller. The BULK-READ CAPABILITY is untouched — see the note where
   `markAllRead` used to live. */

// Human label for each truncation key. Keep in sync with the InboxTruncated
// union above.
const TRUNCATION_LABELS: Record<keyof InboxTruncated, string> = {
  governance: "Workspace governance",
  discussion_mention: "Mentions",
  discussion_assigned: "Assigned threads",
  review_escalation: "Escalations",
  access_review_pending: "Access reviews",
  mfa_recovery_pending: "MFA approvals",
  communication_failure: "Delivery failures",
  security_event_high: "Security alerts",
  report_failure: "Report failures",
  verification_package_failure: "Package failures",
  ots_failure: "OTS failures",
  intake_submission_pending_review: "Intake awaiting review",
  intake_required_items_missing: "Intake incomplete",
  intake_link_expiring: "Intake link expiring",
  collaboration: "Collaboration",
  tsa_failure: "Timestamp failures",
  case_assignment: "Case assignments",
};

/* `joinReadable` and `describeAttentionAreas` USED TO LIVE HERE.
 *
 * They built a capability-aware sentence — "integrity signals, report
 * failures, intake activity and assignments" — that was spliced into the page
 * subtitle and the empty state. That machinery existed because the old
 * subtitle promised to enumerate what could arrive, and enumerating it wrongly
 * for a Free account was a real defect.
 *
 * The Notifications subtitle no longer enumerates anything: it is one short
 * sentence that is true for every plan, and the empty state says the reader is
 * caught up rather than describing a taxonomy. With nothing left to splice,
 * both helpers had no consumer and are removed rather than left behind as
 * capability logic nothing reads.
 */


export default function InboxPage() {
  return (
    <PageRouteGate routeId="account.notifications">
      <InboxPageInner />
    </PageRouteGate>
  );
}

function InboxPageInner() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  /**
   * THE LAST ENVELOPE THAT LOADED, KEPT ACROSS THE NEXT LOAD.
   *
   * Every filter change puts the page into `loading`, and the metric cards,
   * the toolbar and the result count were all gated on `state.kind ===
   * "ready"` — so all three UNMOUNTED on every click and came back a moment
   * later. On a page whose whole interaction is "click a card, then click
   * another one", that is the interaction: the control you are aiming at
   * disappears from under the cursor, the layout jumps, and a keyboard
   * reader's focus is destroyed with the button that held it.
   *
   * The chrome now renders from the retained envelope while the next one is
   * in flight. Only the LIST swaps, which is the part that is actually
   * changing. The counts are a moment stale during the request and settle
   * when it lands — the honest trade, and far smaller than the alternative.
   */
  const [lastEnvelope, setLastEnvelope] = useState<InboxEnvelope | null>(null);
  /**
   * THE PRIMARY VIEW — ONE value, six alternatives, never a set.
   *
   * This was two independent pieces of state: `filter` (which held `all` or
   * `unread`, among other things) and `toneFilter` (which held a severity).
   * The six metric cards wrote to whichever of the two matched them, so
   * clicking `High` while `Unread` was selected left BOTH set. The page then
   * asked the server for unread-AND-high — an intersection the reader never
   * requested, usually empty — and the only way out was to click the old card
   * a second time to clear it. Two pieces of state for one question is what
   * made that possible; one piece of state makes it unrepresentable.
   *
   * The six are ALTERNATIVES, so selecting one replaces the other, always,
   * and exactly one is selected at every moment.
   */
  const [primaryView, setPrimaryView] = useState<PrimaryView>("all");
  /**
   * The CATEGORY axis — a type/integrity/time narrowing from the Filters
   * panel. Independent of the primary view, which is the point: `High +
   * Reports + Overdue` and `Unread + Mentions` are all legitimate, and none of
   * them is expressible while one slot has to carry both questions.
   */
  const [category, setCategory] = useState<InboxFilter>("all");
  /**
   * The LIFECYCLE axis. Archived left the quick row for the Filters panel; it
   * is a status, not one of the six alternatives, so it composes with them —
   * "archived High notifications" is a real question.
   */
  const [archived, setArchived] = useState(false);
  // Workspace narrowing — "all" (default) keeps the canonical
  // all-workspaces scope; a workspace id narrows server-side (the
  // backend validates membership and 403s on anything else).
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  /**
   * ORDERING. Server-applied, like every other axis on this page — see
   * `SORT_OPTIONS`. Changing it resets pagination for the same reason
   * changing a filter does: the cursor is an offset into an ordered
   * population, so carrying it across a reorder would page into the middle of
   * a list the reader never saw the start of.
   */
  const [sort, setSort] = useState<InboxSort>(DEFAULT_SORT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);
  const personalSpace = usePersonalSpace();
  const organizations = useOrganizations();
  // Canonical UI-context — relevance only; the backend enforces data.
  const uiCtx = useOperationsUiContext();
  // Actual-item override signal — the aggregation's filter-independent,
  // backend-authorized scope summary. A real item reveals its category
  // even when static eligibility would hide it.
  const itemSignal = buildActualItemSignal(
    state.kind === "ready" ? state.data.scopeSummary : null,
  );
  // §8 — subtitle + empty-state describe only categories this user can
  // surface (adaptive, never over-promising reviews/governance), plus any
  // category a real item reveals.

  /**
   * One count per metric card.
   *
   * The numbers move with the ADVANCED filters and stay still under the
   * cards' own axes — which is the property that makes them work as
   * alternatives. Select Archived and every card re-describes the archive;
   * select High within it and the other five keep telling you what is waiting
   * behind them, rather than collapsing to zero because High is now the only
   * thing counted.
   */
  const metricCount = (
    key: NotificationMetricKey,
    data: InboxEnvelope,
  ): number => {
    // `metricSummary` is the canonical basis — see its docstring on the
    // envelope. The fallbacks keep a pre-deploy envelope rendering numbers
    // rather than blanks; they are not a second aggregation.
    const m = data.metricSummary;
    if (key === "unread") return m?.unread ?? data.scopeSummary?.unread ?? 0;
    if (key === "all") {
      return m?.total ?? data.scopeSummary?.total ?? data.summary.total;
    }
    return (
      m?.byTone[key] ?? data.scopeSummary?.byTone[key] ?? data.summary.byTone[key] ?? 0
    );
  };

  /**
   * SELECTING A VIEW REPLACES THE PREVIOUS ONE. Always. No toggle-off.
   *
   * The cards used to be independent toggles, and clicking an active one
   * cleared it. That reads fine in isolation and is wrong as a set: with six
   * toggles over one question, "Unread" and "High" could both be on, and the
   * reader had to clear the first before the second would show anything.
   *
   * There is also no toggle-off here, deliberately. `All` IS the cleared
   * state and it is always one click away, so a card that emptied itself
   * would only produce a seventh state meaning the same thing as the first.
   *
   * Nothing else moves: the category filter, the archived status, the
   * workspace and the sort all survive a view change untouched. Only the
   * cursor resets, because it is an offset into a population that just
   * changed.
   */
  const selectMetric = useCallback((key: PrimaryView) => {
    setPrimaryView(key);
  }, []);
  // Filter grouping (pure policy, unit-tested): a stable QUICK row of three,
  // plus grouped advanced filters behind one control. Capability-gated
  // options (admin, governance) never render for users who can never receive
  // them — the policy decides, this page only draws it.
  const advancedGroups = visibleAdvancedFilterGroups(uiCtx, itemSignal);
  const activeFilterCount = activeAdvancedFilterCount({
    category,
    archived,
    workspaceId: workspaceFilter,
  });
  // Memoized: the active-filter summary derives a label from this list, and
  // a fresh array on every render would rebuild that summary on every render.
  const workspaceOptions: Array<{ value: string; label: string }> = useMemo(
    () => [
      { value: "all", label: "All workspaces" },
      ...(personalSpace?.id
        ? [{ value: personalSpace.id, label: "Personal Space" }]
        : []),
      ...organizations
        .filter((o) => o.membershipStatus === "ACTIVE")
        .map((o) => ({
          value: o.id,
          label: o.displayName ?? o.name ?? "Organization",
        })),
    ],
    [personalSpace?.id, organizations],
  );

  /**
   * CLOSING THE PANEL RETURNS FOCUS TO THE CONTROL THAT OPENED IT.
   *
   * Without this, dismissing the popover drops focus to the document and a
   * keyboard reader is returned to the top of the page — which is the usual
   * way a popover becomes technically operable and practically unusable.
   */

  /**
   * THE VIEW IS IN THE URL, ONE PARAMETER PER AXIS.
   *
   * Refreshing used to drop the reader back to "All / Newest", which on a page
   * whose whole job is narrowing a list is the one thing that makes narrowing
   * feel unsafe. Every axis now round-trips:
   *
   *     /notifications?view=high&filter=reports&lifecycle=archived&sort=oldest
   *
   * ONE PARAMETER PER AXIS, so switching the primary view REPLACES `view`
   * rather than accumulating a second, conflicting narrowing beside it. A URL
   * like `?unread=true&severity=high` cannot be produced here, because the
   * state it would describe cannot exist.
   *
   * BACKWARD COMPATIBLE. `?filter=archived` and `?filter=unread` are shipped
   * URLs — bookmarked, linked, and asserted by the previous pass's tests — so
   * they are still READ, and decomposed into the axis each was really asking
   * about. They are no longer WRITTEN: the canonical spelling is emitted from
   * here on, and the server accepts both.
   *
   * READ ONCE, on mount, from `window.location` rather than through
   * `useSearchParams()`. The hook would put this client component's render
   * behind a Suspense boundary at build time for a page that is otherwise
   * fully client-rendered — a real constraint on this app's static render, and
   * nothing here needs the hook's re-render-on-navigation behaviour.
   *
   * WRITTEN with `history.replaceState`, not a router navigation: replacing
   * means the back button leaves the page rather than walking backwards
   * through every filter click, and `replaceState` does not re-run the route.
   *
   * VALIDATED on the way in. A hand-edited or stale query string resolves to
   * the default rather than putting an unknown key into a request.
   */
  const [urlHydrated, setUrlHydrated] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // The canonical primary-view parameter.
    const view = params.get("view");
    if (isPrimaryView(view)) setPrimaryView(view);

    const lifecycle = params.get("lifecycle");
    if (lifecycle === "archived") setArchived(true);

    const f = params.get("filter");
    if (f && ALL_INBOX_FILTERS.includes(f as InboxFilter)) {
      // LEGACY DECOMPOSITION — the same rule the server applies, so a shipped
      // URL selects the same state it always did.
      if (f === "archived" || f === "history") {
        setArchived(true);
      } else if (f === "unread") {
        if (!isPrimaryView(view)) setPrimaryView("unread");
      } else if (f === "critical") {
        if (!isPrimaryView(view)) setPrimaryView("critical");
      } else {
        setCategory(f as InboxFilter);
      }
    }

    // `tone` was the severity axis before the metric cards became one control.
    const t = params.get("tone");
    if (
      !isPrimaryView(view) &&
      t &&
      (["critical", "high", "warning", "info"] as const).includes(t as InboxTone)
    ) {
      setPrimaryView(t as InboxTone);
    }

    const so = params.get("sort");
    if (isInboxSort(so)) setSort(so);
    const ws = params.get("workspaceId");
    if (ws) setWorkspaceFilter(ws);
    setUrlHydrated(true);
  }, []);

  useEffect(() => {
    // Not before the read above has run, or the first paint's defaults would
    // overwrite the very query string being restored.
    if (!urlHydrated) return;
    const params = new URLSearchParams();
    // ONE parameter per axis. `view` is SET, never appended to, so switching
    // Unread → High replaces the narrowing instead of stacking a second one.
    if (primaryView !== "all") params.set("view", primaryView);
    if (category !== "all") params.set("filter", category);
    if (archived) params.set("lifecycle", "archived");
    if (workspaceFilter !== "all") params.set("workspaceId", workspaceFilter);
    if (sort !== DEFAULT_SORT) params.set("sort", sort);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [urlHydrated, primaryView, category, archived, workspaceFilter, sort]);

  const closeFilters = useCallback(() => {
    setFiltersOpen(false);
    filtersTriggerRef.current?.focus();
  }, []);

  /** Escape closes the panel from anywhere inside it, or from the trigger. */
  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The listbox inside the panel handles its own Escape first and stops
      // propagation, so its dropdown closes without taking the panel with it.
      e.stopPropagation();
      closeFilters();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen, closeFilters]);

  /**
   * ARCHIVED IS A STATUS, so it composes with the primary view rather than
   * replacing it — "archived High notifications" is a real question and the
   * server can answer it.
   *
   * The ONE combination it cannot answer is `Archived + Unread`: archiving
   * writes `readAt` in the same mutation as `dismissedAt`, so an
   * archived-and-unread notification cannot exist. Rather than leave the
   * reader holding an impossible filter that silently returns nothing, turning
   * Archived on while Unread is selected moves the view back to All. The
   * Unread controls then disable themselves and say why.
   */
  const toggleArchived = useCallback(() => {
    setArchived((wasArchived) => {
      const next = !wasArchived;
      if (next) setPrimaryView((v) => (v === "unread" ? "all" : v));
      return next;
    });
  }, []);

  /** Advanced category filters are single-choice; clicking the active one
   *  clears it. They never touch the primary view. */
  const selectAdvancedFilter = useCallback((key: InboxFilter) => {
    setCategory((current) => (current === key ? "all" : key));
  }, []);

  /**
   * CLEAR resets the ADVANCED axes only.
   *
   * The primary view is deliberately left alone: `All` is one click away on
   * the card row directly above, and a "Clear filters" button that also reset
   * a severity the reader had chosen would be undoing a selection they can
   * see is still highlighted.
   */
  const clearAllFilters = useCallback(() => {
    setCategory("all");
    setArchived(false);
    setWorkspaceFilter("all");
  }, []);

  /**
   * THE ACTIVE-FILTER SUMMARY, derived — never a second copy of the state.
   *
   * Only the ADVANCED axes appear here, each with the one action that undoes
   * it. The primary view is excluded because it is never ambiguous: exactly
   * one metric card is lit at all times, directly above this row, so a chip
   * repeating it would be a second place to read the same fact.
   */
  const activeChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; clear: () => void }> = [];
    if (archived) {
      chips.push({
        id: "archived",
        label: "Archived",
        clear: () => setArchived(false),
      });
    }
    if (category !== "all") {
      chips.push({
        id: category,
        label: INBOX_FILTER_LABELS[category],
        clear: () => setCategory("all"),
      });
    }
    if (workspaceFilter !== "all") {
      const ws = workspaceOptions.find((o) => o.value === workspaceFilter);
      chips.push({
        id: `workspace:${workspaceFilter}`,
        label: ws?.label ?? "Workspace",
        clear: () => setWorkspaceFilter("all"),
      });
    }
    return chips;
  }, [archived, category, workspaceFilter, workspaceOptions]);
  // Accumulated items across the current filter window. Reset on
  // filter/tone change; appended on Load More.
  const [items, setItems] = useState<InboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildUrl = useCallback(
    (cursor: string | null): string => {
      const params = new URLSearchParams();
      // ONE PARAMETER PER AXIS, and the primary view resolves to exactly one
      // of them. This is what makes the metric cards mutually exclusive on the
      // WIRE and not merely in the styling: clicking High after Unread sends
      // `tone=high`, with no `readState` beside it, so the server is asked
      // the question the reader actually asked.
      if (primaryView === "unread") params.set("readState", "unread");
      else if (primaryView !== "all") params.set("tone", primaryView);
      if (category !== "all") params.set("filter", category);
      if (archived) params.set("lifecycle", "archived");
      if (workspaceFilter !== "all") params.set("workspaceId", workspaceFilter);
      // ALWAYS SENT, including the default. The API's own default is
      // `priority` — the Operations Center's ordering, which this page is not
      // — so omitting the parameter when the control reads "Newest first"
      // would show a list that did not match the control.
      params.set("sort", sort);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return qs ? `/v1/me/inbox?${qs}` : "/v1/me/inbox";
    },
    [primaryView, category, archived, workspaceFilter, sort],
  );

  /**
   * PHASE 2.6 — LATEST REQUEST WINS.
   *
   * `buildUrl` closes over the workspace filter, so switching workspaces
   * fires a new load while the previous one is still in flight. Without an
   * identity guard the LAST response to arrive commits, which is how one
   * workspace's notifications render under another workspace's heading.
   */
  const request = useLatestRequest();

  const load = useCallback(async () => {
    const attempt = request.begin();
    setState({ kind: "loading" });
    try {
      // `apiFetch` already returns the parsed JSON body (see
      // `apps/web/lib/api.ts:233`). Calling `.json()` on the result
      // throws `TypeError: e.json is not a function` in production
      // (the local variable is minified to `e`).
      const data = (await apiFetch(buildUrl(null), {
        signal: attempt.signal,
      })) as InboxEnvelope;
      // A newer load (workspace switch, filter change) has taken over. Its
      // response is the one the operator is waiting for; committing ours
      // would put this workspace's rows under that workspace's heading.
      if (!attempt.isCurrent()) return;
      setState({ kind: "ready", data });
      setLastEnvelope(data);
      setItems(data.items);
      setNextCursor(data.pagination?.nextCursor ?? null);
    } catch (err: unknown) {
      // A superseded request's abort is not an error the operator caused, and
      // surfacing it would replace the newer request's live results with a
      // failure banner.
      if (!attempt.isCurrent()) return;
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load inbox." }).message;
      setState({ kind: "error", status, message });
    }
  }, [buildUrl, request]);

  /* `markAllRead` USED TO LIVE HERE.

     It drove the two bulk-read buttons this page no longer renders, and with
     the buttons gone it was an unreachable POST. The CAPABILITY is untouched:
     `POST /v1/me/inbox/mark-all-read` keeps its server-side scoping, its
     tests, and its real consumer in the header notification bell. What is
     removed is this page's copy of the call, not the endpoint. */


  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    // Same generation as `load`, deliberately: a workspace switch mid-page
    // must discard this page too. Appending a page fetched under the previous
    // workspace to the new workspace's list is the same defect as replacing
    // it, and harder to spot because only part of the list is wrong.
    const attempt = request.begin();
    setLoadingMore(true);
    try {
      const data = (await apiFetch(buildUrl(nextCursor), {
        signal: attempt.signal,
      })) as InboxEnvelope;
      if (!attempt.isCurrent()) return;
      // Append the new page; refresh the envelope so summary counts +
      // truncation flags stay current. We deliberately do NOT reset
      // items on a Load-More response — the user is paging forward.
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.pagination?.nextCursor ?? null);
      setState((prev) =>
        prev.kind === "ready" ? { kind: "ready", data } : prev,
      );
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Could not load more." }).message;
      // Keep the prior state — Load More failure shouldn't blow away
      // what the user is already looking at. Surface a one-shot error
      // alert via state.error? Simpler: log + leave UI unchanged.
      // The Load More button itself becomes the retry surface.
      if (attempt.isCurrent()) console.error("[inbox] load-more failed:", message);
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, nextCursor, loadingMore, request]);

  // Reset + reload whenever the filter or tone changes. We don't paginate
  // across filter changes — the operator's new filter is a fresh query.
  useEffect(() => {
    void load();
  }, [load]);

  // Phase IA-reliability — per-item mutation helpers. Each one is
  // optimistic-with-rollback: we update local state immediately so the
  // operator's click feels instant, then on success keep the local
  // change; on failure we revert. Dismiss removes the item from the
  // current visible list entirely (matching what the server's next
  // /v1/me/inbox call would do).
  const [pendingItemKey, setPendingItemKey] = useState<string | null>(null);

  type StateDelta = Partial<
    Pick<InboxItem, "isRead" | "readAt" | "dismissedAt" | "snoozedUntil">
  >;

  const applyOptimisticUpdate = useCallback(
    (itemKey: string, delta: StateDelta) => {
      setItems((prev) =>
        prev.map((it) =>
          it.itemKey === itemKey ? ({ ...it, ...delta } as InboxItem) : it,
        ),
      );
    },
    [],
  );

  const removeItemLocally = useCallback((itemKey: string) => {
    setItems((prev) => prev.filter((it) => it.itemKey !== itemKey));
  }, []);

  // ATTENTION ARCHITECTURE PHASE 1 — the CANONICAL personal action names.
  // `dismiss`/`snooze` remain live compatibility aliases on the server for
  // shipped clients; this client calls the canonical names so the product and
  // the API agree about what the operator just did.
  async function postAction(
    itemKey: string,
    action: "read" | "unread" | "archive" | "unarchive" | "remind",
    body?: Record<string, unknown>,
  ) {
    return apiFetch(
      `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
      {
        method: "POST",
        ...(body
          ? {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }
          : {}),
      },
    ) as Promise<{
      itemKey: string;
      isRead: boolean;
      readAt: string | null;
      dismissedAt: string | null;
      snoozedUntil: string | null;
    }>;
  }

  const markRead = useCallback(
    async (item: InboxItem) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      const prevState = {
        isRead: item.isRead,
        readAt: item.readAt ?? null,
      };
      applyOptimisticUpdate(item.itemKey, {
        isRead: true,
        readAt: new Date().toISOString(),
      });
      try {
        await postAction(item.itemKey, "read");
      } catch (err) {
        applyOptimisticUpdate(item.itemKey, prevState);
        console.error("[inbox] mark-read failed:", err);
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, applyOptimisticUpdate],
  );

  const markUnread = useCallback(
    async (item: InboxItem) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      const prevState = {
        isRead: item.isRead,
        readAt: item.readAt ?? null,
      };
      applyOptimisticUpdate(item.itemKey, { isRead: false, readAt: null });
      try {
        await postAction(item.itemKey, "unread");
      } catch (err) {
        applyOptimisticUpdate(item.itemKey, prevState);
        console.error("[inbox] mark-unread failed:", err);
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, applyOptimisticUpdate],
  );

  /**
   * ARCHIVE — file this notification out of MY active feed.
   *
   * It is not "dismiss", and the difference is not cosmetic. Nothing shared
   * moves: if this message is about unresolved work, that work is still
   * unresolved, still counted, and still visible to every other operator.
   */
  const archiveItem = useCallback(
    async (item: InboxItem) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      // Optimistic remove; if the server rejects we re-fetch (the operator's
      // mental model is "I archived it, it should be gone from here").
      removeItemLocally(item.itemKey);
      try {
        await postAction(item.itemKey, "archive");
      } catch (err) {
        console.error("[inbox] archive failed:", err);
        // Re-fetch to restore truth.
        void load();
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, removeItemLocally, load],
  );

  /**
   * UNARCHIVE — put it back.
   *
   * An archive you cannot come back out of is a delete with a friendlier
   * label, and the schema has carried a note promising this endpoint since
   * the state table was written. It is reachable from History, where archived
   * items live.
   */
  const unarchiveItem = useCallback(
    async (item: InboxItem) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      const previous = item.dismissedAt ?? null;
      applyOptimisticUpdate(item.itemKey, { dismissedAt: null });
      try {
        await postAction(item.itemKey, "unarchive");
      } catch (err) {
        applyOptimisticUpdate(item.itemKey, { dismissedAt: previous });
        console.error("[inbox] unarchive failed:", err);
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, applyOptimisticUpdate],
  );

  /** REMIND ME LATER — defer it until a time I choose. Equally private. */
  /* `remindItem` USED TO LIVE HERE.
     It drove a "Remind me tomorrow" row action, which the product does not
     want exposed. The BACKEND capability is deliberately untouched:
     `POST /v1/me/inbox/items/:itemKey/snooze` is a live API surface, and
     removing a published endpoint to satisfy a visual request is an
     API-breaking change made for the wrong reason. The UI exposure is gone;
     the endpoint remains for any client that already calls it. */

  // The items the page renders: the accumulated list (already filtered
  // server-side by `filter` + `toneFilter` query params).
  const visibleItems = items;

  /** The envelope the page CHROME draws from — see `lastEnvelope`. */
  const shellData: InboxEnvelope | null =
    state.kind === "ready" ? state.data : lastEnvelope;

  /**
   * WHAT THE COUNT IS COUNTING, in the page's own vocabulary.
   *
   * "items" is a queue's word. These are notifications, and when a narrowing
   * is in force the sentence should say which notifications — "12 archived
   * notifications" tells the reader what they are looking at, where "12 of 36
   * items" makes them reconstruct it from the toolbar.
   */
  const resultNoun = useMemo(() => {
    const plural = visibleItems.length === 1 ? "notification" : "notifications";
    // Lifecycle first, then the primary view — the order the reader reads the
    // controls in, so "archived high notifications" comes out in that order.
    const lifecycle = archived ? "archived " : "";
    if (primaryView === "unread") return `${lifecycle}unread ${plural}`;
    if (primaryView !== "all") {
      return `${lifecycle}${PRIMARY_VIEW_LABELS[primaryView].toLowerCase()} ${plural}`;
    }
    if (category !== "all") {
      return `${lifecycle}${INBOX_FILTER_LABELS[category].toLowerCase()} ${plural}`;
    }
    return `${lifecycle}${plural}`;
  }, [archived, primaryView, category, visibleItems.length]);


  return (
    <PageShell
      data-phase-c-inbox
      data-inbox-total={state.kind === "ready" ? state.data.summary.total : 0}
      header={
        /* THIS IS THE NOTIFICATIONS PAGE. IT SAYS SO.
           It used to open with `ACCOUNT · OPERATIONS CENTER`, a title of
           `Operations Center`, and a subtitle about "operational items that
           require your attention". All three belong to `/operations`, which is
           now a separate product surface: the shared workspace workbench. This
           one is personal awareness — updates addressed to a person — and the
           eyebrow is dropped entirely rather than replaced, because the title
           already says where you are and the canonical header does not need a
           breadcrumb to prove it. */
        <PageHeader
          title={
            /* THE CASES TITLE TREATMENT, REUSED — not re-cut.
               `.app-title-row` + `.app-title-icon` are the /cases page title's
               own geometry, gradient, border and inner highlight, lifted into
               the shared primitives sheet so both pages render one definition.
               Only the glyph differs, and it is the canonical Bell from
               lucide-react, the icon library this app already uses.

               `aria-hidden` because the heading beside it already names the
               page; announcing "Notifications" twice is noise, not an
               affordance. This renders INSIDE PageHeader's own <h1>, so there
               is exactly one heading here — unlike /cases, which nests its
               own. */
            <span className="app-title-row">
              <span aria-hidden className="app-title-icon">
                <Bell strokeWidth={1.75} data-notifications-title-icon />
              </span>
              <span data-notifications-title>Notifications</span>
            </span>
          }
          subtitle="Updates, assignments, mentions and integrity alerts relevant to you."
          primaryAction={
            /* The CANONICAL primary action, the same one the header's New Case
               button paints — reused as a class, not re-typed as a hex. It was
               a legacy `btn secondary`, which is why it read as belonging to a
               different application than the page around it. */
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void load()}
              disabled={state.kind === "loading"}
              aria-busy={state.kind === "loading"}
              data-action="refresh-inbox"
            >
              <RefreshCw
                size={15}
                strokeWidth={2}
                aria-hidden="true"
                data-notifications-refresh-icon
              />
              {state.kind === "loading" ? "Refreshing…" : "Refresh"}
            </button>
          }
        />
      }
    >
      {/* ==================================================================
           ATTENTION ARCHITECTURE PHASE 6.1 (2026-08-22) — THIS IS A
           NOTIFICATION CENTRE, NOT AN INCIDENT CONSOLE.

           WHAT WAS HERE: five giant severity KPI tiles — CRITICAL, HIGH,
           WARNING, INFO, ALL — as the page's hero. That is the chrome of an
           operations dashboard, and it made a personal feed look like the
           workspace's operational state, which is the confusion this entire
           program removes. It also put "CRITICAL 0" at the top of a page whose
           actual question is "what did I miss?".

           WHAT IS HERE NOW: the two facts a person opening their notifications
           needs — how many are unread, and whether we can be trusted to have
           shown them everything — plus severity as compact METADATA. Severity
           still matters (a failed anchor is not a mention) and it is still
           filterable; it is simply no longer the headline.
           ================================================================== */}
      {shellData && (
        <section
          data-notifications-summary
          aria-label="Notification summary"
          className="ops-metrics"
        >
          <ul className="ops-metrics__grid" data-notifications-metric-grid>
            {NOTIFICATION_METRICS.map((metric) => {
              const count = metricCount(metric.key, shellData);
              // ONE comparison, because there is ONE piece of state. Exactly
              // one card is selected at every moment, and selecting another
              // transfers it — no card can be "also" selected.
              const active = primaryView === metric.key;
              // A ZERO COUNT IS A FACT, NOT A DISABLED CONTROL.
              //
              // Zero-count severity cards used to be `disabled` and painted at
              // 55% opacity, which said "this card is unavailable" when what
              // was true is "this number is currently zero". It also trapped
              // the reader: with Unread at 0 selected, every other zero card
              // was inert, so there was no way out but back to a card that
              // happened to be non-empty.
              //
              // The one card that IS unavailable is Unread while Archived is
              // on — archiving marks read, so that intersection cannot exist.
              // That one says why.
              const impossible = metric.key === "unread" && archived;
              const descId = `notif-metric-${metric.key}`;
              return (
                <li key={metric.key}>
                  <button
                    type="button"
                    className="app-metric-card ops-metric"
                    data-ops-metric-tone={metric.accent}
                    data-notifications-metric={metric.key}
                    data-notifications-metric-count={count}
                    data-notifications-metric-active={active ? "true" : "false"}
                    data-notifications-metric-zero={count === 0 ? "true" : "false"}
                    aria-pressed={active}
                    aria-describedby={descId}
                    disabled={impossible}
                    title={
                      impossible
                        ? "Archived notifications are always marked read."
                        : undefined
                    }
                    onClick={() => selectMetric(metric.key)}
                  >
                    <span className="app-metric-card__value">{count}</span>
                    <span className="app-metric-card__label">
                      {metric.label}
                    </span>
                    <span className="app-metric-card__meta" id={descId}>
                      {metric.explanation}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* PHASE 2.3 — HONESTY BEFORE REASSURANCE.
              A "0 unread" over a partial read is the same lie as a dashboard
              saying "all clear", told in less space. When the server could not
              read every source, the page says so instead of implying calm. */}
          {shellData.completeness &&
          !shellData.completeness.mayAssertAllClear ? (
            <p data-notifications-incomplete className="ops-metrics__note">
              Some sources could not be read, so this may not be everything.
              {shellData.completeness.incompleteSources.length > 0
                ? ` Affected: ${shellData.completeness.incompleteSources.join(", ")}.`
                : ""}
            </p>
          ) : null}
        </section>
      )}

      {shellData && archived && shellData.historyAvailable === false ? (
        <section
          data-inbox-history-unavailable
          role="status"
          className="ops-note"
        >
          Archived notifications are not available in this environment yet.
        </section>
      ) : null}

      {/* THE TWO BULK-READ BUTTONS USED TO BE HERE.
           `Mark all as read` and `Mark <category> as read` sat between the
           metric cards and the toolbar as a third band of chrome, and in the
           Archived view — where every row is read by definition — they were
           two controls offering to do nothing.

           THE UI EXPOSURE IS GONE; THE CAPABILITY IS NOT. `POST
           /v1/me/inbox/mark-all-read` still has a real consumer in the header
           notification bell (`NotificationBell.tsx`), which is the surface
           where "clear all of this" is actually the thing a person wants. The
           endpoint, its server-side scoping and its tests are untouched, so
           nothing is broken for that caller or for an API client. */}

      {/* ==================================================================
           THE TOOLBAR. One row, three controls, and nothing permanent that
           the reader did not ask for.

           WHAT WAS HERE: up to fifteen filter pills, all rendered all the
           time, in two uncontrolled rows — a wall that competed with the
           metric cards directly above it, did not scale as categories were
           added, and gave a rarely-used filter exactly as much of the page
           as `All`.

           WHAT IS HERE NOW: three quick filters that ARE the lifecycle of a
           personal feed, one grouped `Filters` popover carrying a count when
           something is applied, and a sort control. The advanced filters did
           not disappear — they stopped being permanent furniture.
           ================================================================== */}
      {shellData && (
        <section
          data-inbox-toolbar
          className="ops-toolbar"
          aria-label="Notification filters and sorting"
        >
          {/* TWO quick controls, not three. `Archived` left this row for the
              Filters panel: it is a STATUS, and standing it beside All and
              Unread implied the three were alternatives when only the first
              two are. What remains are the two the reader uses constantly.

              These write the SAME `primaryView` the metric cards do, which is
              why the chip and the card can never disagree about what is
              selected — there is one value, and both controls set it. */}
          <div className="ops-toolbar__quick" data-inbox-quick-filters>
            {QUICK_PRIMARY_VIEWS.map((key) => {
              const active = primaryView === key;
              const impossible = key === "unread" && archived;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectMetric(key)}
                  aria-pressed={active}
                  disabled={impossible}
                  title={
                    impossible
                      ? "Archived notifications are always marked read."
                      : undefined
                  }
                  data-inbox-filter-chip={key}
                  data-inbox-filter-chip-active={active ? "true" : "false"}
                  data-active={active ? "true" : "false"}
                  className="app-chip ops-quick-chip"
                >
                  {PRIMARY_VIEW_LABELS[key]}
                </button>
              );
            })}
          </div>

          <div className="ops-toolbar__controls">
            {advancedGroups.length > 0 || workspaceOptions.length > 2 ? (
              <>
                <button
                  ref={filtersTriggerRef}
                  type="button"
                  className="app-secondary-action ops-filters-trigger"
                  aria-expanded={filtersOpen}
                  aria-haspopup="dialog"
                  aria-controls="inbox-advanced-filters"
                  data-action="toggle-advanced-filters"
                  data-active={activeFilterCount > 0 ? "true" : "false"}
                  onClick={() => setFiltersOpen((v) => !v)}
                >
                  <SlidersHorizontal size={15} strokeWidth={2} aria-hidden />
                  Filters
                  {activeFilterCount > 0 ? (
                    <span
                      className="ops-filters-count"
                      data-inbox-active-filter-count={activeFilterCount}
                    >
                      {activeFilterCount}
                    </span>
                  ) : null}
                </button>
                <AppAnchoredOverlay
                  anchorRef={filtersTriggerRef}
                  open={filtersOpen}
                  overlayRef={filtersPanelRef}
                  onPointerDownOutside={() => setFiltersOpen(false)}
                  // A panel, not a select popup: it sizes from its own CSS
                  // instead of inheriting the trigger button width.
                  matchAnchorWidth={false}
                  role="dialog"
                  id="inbox-advanced-filters"
                  aria-label="Filters"
                  className="ops-filters-panel"
                  data-inbox-filters-panel
                >
                  {/* STATUS — the lifecycle axis, in its own group rather
                      than mixed in among the Type categories. It is not a
                      kind of notification; it is which half of the archive
                      boundary you are looking at. */}
                  <div
                    className="ops-filters-group"
                    data-inbox-filter-group="status"
                  >
                    <h3 className="ops-filters-group__label">Status</h3>
                    <div className="ops-filters-group__items">
                      <button
                        type="button"
                        className="app-chip ops-filter-option"
                        aria-pressed={archived}
                        data-inbox-filter-chip="archived"
                        data-inbox-filter-chip-active={
                          archived ? "true" : "false"
                        }
                        onClick={toggleArchived}
                      >
                        Archived
                      </button>
                    </div>
                  </div>

                  {advancedGroups.map((group) => (
                    <div
                      key={group.id}
                      className="ops-filters-group"
                      data-inbox-filter-group={group.id}
                    >
                      <h3 className="ops-filters-group__label">
                        {group.label}
                      </h3>
                      <div className="ops-filters-group__items">
                        {group.keys.map((key) => {
                          const active = category === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              className="app-chip ops-filter-option"
                              aria-pressed={active}
                              data-inbox-filter-chip={key}
                              data-inbox-filter-chip-active={
                                active ? "true" : "false"
                              }
                              onClick={() => selectAdvancedFilter(key)}
                            >
                              {INBOX_FILTER_LABELS[key]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* WORKSPACE lives in the same panel rather than in a strip
                      of its own above the list — it is one more way to narrow
                      the population, and it was the only one with a permanent
                      row. Rendered ONLY for a reader who has somewhere else to
                      switch to: with a single Personal Space, "All workspaces"
                      is a choice between one thing. */}
                  {workspaceOptions.length > 2 ? (
                    <div
                      className="ops-filters-group"
                      data-inbox-filter-group="workspace"
                      data-inbox-workspace-scope
                    >
                      <h3
                        className="ops-filters-group__label"
                        id="inbox-workspace-scope-label"
                      >
                        Workspace
                      </h3>
                      <AppListbox
                        value={workspaceFilter}
                        options={workspaceOptions}
                        onChange={(v) => setWorkspaceFilter(v)}
                        ariaLabelledby="inbox-workspace-scope-label"
                      />
                    </div>
                  ) : null}

                  <div className="ops-filters-panel__footer">
                    <button
                      type="button"
                      className="app-secondary-action"
                      data-action="clear-advanced-filters"
                      disabled={activeFilterCount === 0}
                      onClick={clearAllFilters}
                    >
                      Clear filters
                    </button>
                    <button
                      type="button"
                      className="app-primary-action"
                      data-action="close-advanced-filters"
                      onClick={closeFilters}
                    >
                      Done
                    </button>
                  </div>
                </AppAnchoredOverlay>
              </>
            ) : null}

            <div className="ops-sort">
              <span className="ops-sort__label" id="inbox-sort-label">
                Sort
              </span>
              <AppListbox
                value={sort}
                options={SORT_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                onChange={(v) => setSort(v as InboxSort)}
                ariaLabelledby="inbox-sort-label"
                className="ops-sort__control"
              />
            </div>
          </div>
        </section>
      )}

      {/* ---------- ACTIVE FILTER SUMMARY. Only what is actually applied,
           each with its own remove control, plus one way out. This is the
           replacement for reading the state off a wall of pills: the reader
           never has to scan fifteen chips to find which two are lit. */}
      {shellData && activeChips.length > 0 && (
        <section
          data-inbox-active-filters
          className="ops-active-filters"
          aria-label="Active filters"
        >
          <ul className="app-chip-row">
            {activeChips.map((chip) => (
              <li key={chip.id}>
                <span className="app-chip ops-active-chip">
                  {chip.label}
                  <button
                    type="button"
                    className="ops-active-chip__remove"
                    aria-label={`Remove ${chip.label} filter`}
                    data-action="remove-filter"
                    data-inbox-remove-filter={chip.id}
                    onClick={chip.clear}
                  >
                    <X size={12} strokeWidth={2.5} aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ops-link-btn"
            data-action="clear-all-filters"
            onClick={clearAllFilters}
          >
            Clear all
          </button>
        </section>
      )}

      {/* ---------- Phase IA-enterprise — "Showing X of Y" indicator.
           The backend's pagination block reports exact + estimated
           totals. We render an honest message so operators always know
           whether the count is precise or capped. Per-category
           truncation detail is folded into a small caveat line. */}
      {state.kind === "ready" && state.data.pagination && (
        <section
          data-inbox-pagination-summary
          className="ops-result-summary"
        >
          <strong
            data-inbox-showing-text
            data-inbox-shown={visibleItems.length}
            data-inbox-total={state.data.pagination.totalEstimate}
            data-inbox-total-exact={
              state.data.pagination.totalIsExact ? "true" : "false"
            }
          >
            {/* NOTIFICATION VOCABULARY, and honest about the total.
                It said "items" — the word for a row in an operational queue.
                It also says "of N" only while N is EXACT; when a source was
                capped the backend reports an estimate, and claiming a precise
                total we do not have is the one thing a count must not do, so
                the phrasing changes rather than appending a "+" to a number
                the reader will read as exact anyway. */}
            {state.data.pagination.totalIsExact
              ? `Showing ${visibleItems.length} of ${state.data.pagination.totalEstimate} ${resultNoun}`
              : `Showing ${visibleItems.length} ${resultNoun} (more may exist)`}
          </strong>
          {state.data.anyTruncated && state.data.truncated && (
            <span style={{ opacity: 0.85 }}>
              Some sources were capped:{" "}
              {Object.entries(state.data.truncated)
                .filter(([, capped]) => capped)
                .map(
                  ([key]) =>
                    TRUNCATION_LABELS[key as keyof InboxTruncated],
                )
                .join(", ")}
              . Open the relevant console for the full list.
            </span>
          )}
        </section>
      )}

      {/* ---------- list states ---------- */}
      {state.kind === "loading" && (
        <div data-state="loading">
          <Card variant="empty" padding="comfortable">
            <span style={{ opacity: 0.75, fontSize: 13 }}>Loading inbox…</span>
          </Card>
        </div>
      )}

      {state.kind === "error" && (
        <div data-state="error" role="alert">
          <Card variant="status" tone="risk" padding="comfortable">
            <strong>Couldn’t load inbox.</strong>
            <div
              style={{
                fontSize: 13,
                marginTop: 4,
                color: "var(--ink-secondary, inherit)",
              }}
            >
              {state.status ? `HTTP ${state.status}: ` : ""}
              {state.message}
            </div>
            <div style={{ marginTop: 12 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void load()}
                data-action="retry-inbox"
              >
                Retry
              </Button>
            </div>
          </Card>
        </div>
      )}

      {state.kind === "ready" &&
        (state.data.scopeSummary?.total ?? state.data.summary.total) === 0 && (
          <div data-state="empty">
            <EmptyState
              framed
              /* A NOTIFICATION empty state, not an operations one.
                 It used to read "Nothing requires your attention right now",
                 explain that items "leave this list automatically when their
                 source stops raising them", and offer "Open workspace command
                 center" as its primary action. All three describe a shared
                 condition lifecycle — which is what /operations tracks. A
                 notification is an event addressed to a person; it does not
                 have a lifecycle the reader needs explained, and the CTA sent
                 a Personal Free user to Home for a workbench they do not have.

                 NO CTA. There is nothing useful to do from an empty
                 notification list, and a button that merely navigates
                 elsewhere is worse than the honest absence of one. */
              title="You're all caught up"
              purpose="You don't have any notifications right now. New updates will appear here when something relevant happens."
            />
          </div>
        )}

      {state.kind === "ready" &&
        (state.data.scopeSummary?.total ?? state.data.summary.total) > 0 &&
        visibleItems.length === 0 && (
          <div data-state="filter-empty">
            {/* THREE DIFFERENT NOTHINGS, three different sentences.
                One generic "no items match" for all of them made an empty
                archive look like a broken filter, and a broken filter look
                like an empty inbox. The reader needs to know which of the
                three they are in, because only one of them has an action.

                CENTRED, and sized to the message. The copy used to sit hard
                against the top-inline-start corner of a wide outlined
                rectangle, which reads as a panel that failed to finish
                loading rather than as an answer. */}
            {archived && activeFilterCount === 1 && category === "all" ? (
              <div className="ops-empty" data-inbox-empty-reason="archive">
                <p className="ops-empty__title">No archived notifications.</p>
                <p className="ops-empty__body">
                  Archiving a notification files it here and takes it out of
                  your active list.
                </p>
              </div>
            ) : (
              <div className="ops-empty" data-inbox-empty-reason="filters">
                <p className="ops-empty__title">
                  No notifications match these filters.
                </p>
                <p className="ops-empty__body">
                  Try changing or clearing the active filters.
                </p>
                {/* The CANONICAL action button, not a text link. Clearing is a
                    real action with a real consequence, and it is the only
                    thing to do from this state — it should look like something
                    you press. */}
                <button
                  type="button"
                  onClick={clearAllFilters}
                  data-action="clear-filter"
                  className="app-secondary-action"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        )}

      {/* ==================================================================
           ONE FLAT, ORDERED STREAM.

           WHAT WAS HERE: the list was bucketed into P1..P5 sections, each
           under a heading like "P1 · Critical — Operational failures and
           critical signals — act now. · 8 items". That is an operations work
           queue's vocabulary, and /operations is where it belongs. On a
           personal feed it told the reader their notifications were a
           prioritised backlog to work through.

           IT ALSO BROKE SORTING. Regrouping by priority AFTER the server
           returned an ordered page means the reader's chosen ordering only
           ever applied WITHIN a bucket: "Oldest first" put the oldest P1
           above the oldest P2, and every P2 below every P1 regardless of age.
           The control said one thing and the DOM did another.

           The server's order is now the render order, exactly. Severity has
           not been lost — every row still wears its tone badge, which is
           where severity belongs on a feed: on the thing that has it.
           ================================================================== */}
      {state.kind === "ready" && visibleItems.length > 0 && (
        <div
          data-inbox-items
          data-inbox-visible-count={visibleItems.length}
        >
          <ul
            data-inbox-stream
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 8,
            }}
          >
            {visibleItems.map((item) => {
                    return (
                      <li
                        key={item.id}
                        data-inbox-item={item.id}
                        data-inbox-item-key={item.itemKey}
                        data-inbox-item-category={item.category}
                        data-inbox-item-tone={item.tone}
                        data-inbox-item-priority={item.priority}
                        data-inbox-item-read={item.isRead ? "true" : "false"}
                        data-tone={item.tone}
                        data-read={item.isRead ? "true" : "false"}
                        className="ops-item"
                      >
                        <div className="ops-item__main">
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              data-tone-chip={item.tone}
                              data-tone={item.tone}
                              className="ops-item__chip"
                            >
                              {TONE_LABELS[item.tone]}
                            </span>
                            <span
                              data-category-chip={item.category}
                              className="ops-item__chip"
                            >
                              {CATEGORY_LABELS[item.category]}
                            </span>
                            <span className="ops-item__title">
                              {item.title}
                            </span>
                          </div>
                          <div className="ops-item__body">{item.body}</div>
                          <div className="ops-item__meta">
                            <span>
                              {formatUserDateTime(item.occurredAt)}
                            </span>
                            {/* Phase IA-cleanup — render real deadlines only
                                when the source row carries one. Overdue rows
                                get a visible badge; future rows show "due …". */}
                            {item.dueAt && (
                              <span
                                data-inbox-item-due={item.dueAt}
                                data-overdue={
                                  new Date(item.dueAt).getTime() < Date.now()
                                    ? "true"
                                    : "false"
                                }
                              >
                                {new Date(item.dueAt).getTime() < Date.now()
                                  ? "Overdue · "
                                  : "Due "}
                                {formatUserDate(item.dueAt)}
                              </span>
                            )}
                            {/* History (snapshot) lifecycle chips — the
                                persistent record survives source
                                resolution; each state is a real
                                timestamp, never inferred. */}
                            {item.resolvedAt ? (
                              <span data-inbox-item-resolved>
                                No longer active{" "}
                                {formatUserDate(
                                  item.sourceClearedAt ?? item.resolvedAt,
                                )}
                              </span>
                            ) : null}
                            {item.dismissedAt ? (
                              <span data-inbox-item-dismissed>
                                Archived {formatUserDate(item.dismissedAt)}
                              </span>
                            ) : null}
                            {item.snoozedUntil &&
                            new Date(item.snoozedUntil).getTime() > Date.now() ? (
                              <span data-inbox-item-snoozed>
                                Reminder set for {formatUserDate(item.snoozedUntil)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        {/* Phase IA-reliability — per-item action
                            cluster. Open always shows. Mark-read/unread
                            toggles based on current state. Snooze
                            defaults to 1 day; future UI can expose a
                            picker. Dismiss is final (until the source
                            re-fires). */}
                        <div data-inbox-item-actions className="ops-item__actions">
                          <Link
                            href={item.href}
                            data-action="open-inbox-item"
                            data-inbox-item-href={item.href}
                            onClick={() => {
                              // Opening an item implicitly marks it
                              // read. Fire-and-forget; we don't wait
                              // for the round-trip before navigating.
                              if (!item.isRead && item.canMarkRead) {
                                void markRead(item);
                              }
                            }}
                            /* The CANONICAL row action, the same class the
                               Intake Links row uses for "View submissions" and
                               "Open". It was `ops-link-btn`, a shape only this
                               page knew about.
                               `--dark` marks it as the row's ONE primary verb:
                               Open takes you to the thing, the other two file
                               the message. Same geometry, only the fill
                               differs. */
                            className="app-primary-action ops-item__open"
                          >
                            Open
                          </Link>
                          {item.canMarkRead &&
                            (item.isRead ? (
                              <button
                                type="button"
                                className="app-secondary-action app-secondary-action--filled"
                                data-action="mark-unread"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void markUnread(item)}
                                disabled={pendingItemKey === item.itemKey}
                                aria-busy={pendingItemKey === item.itemKey}
                                aria-label={`Mark as unread: ${item.title}`}
                              >
                                Mark as unread
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="app-secondary-action app-secondary-action--filled"
                                data-action="mark-read"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void markRead(item)}
                                disabled={pendingItemKey === item.itemKey}
                                aria-busy={pendingItemKey === item.itemKey}
                                aria-label={`Mark as read: ${item.title}`}
                              >
                                Mark as read
                              </button>
                            ))}
                          {/* ARCHIVE vs UNARCHIVE. An already-archived row
                              (History) offers the way back out; anything else
                              offers the way in. */}
                          {item.dismissedAt ? (
                            <button
                              type="button"
                              className="app-secondary-action"
                              data-action="unarchive"
                              data-inbox-item-key={item.itemKey}
                              onClick={() => void unarchiveItem(item)}
                              disabled={pendingItemKey === item.itemKey}
                              aria-busy={pendingItemKey === item.itemKey}
                              aria-label={`Unarchive: ${item.title}`}
                            >
                              Unarchive
                            </button>
                          ) : (
                            item.canDismiss && (
                              <button
                                type="button"
                                className="app-secondary-action"
                                data-action="archive"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void archiveItem(item)}
                                disabled={pendingItemKey === item.itemKey}
                                aria-busy={pendingItemKey === item.itemKey}
                                aria-label={`Archive: ${item.title}`}
                              >
                                Archive
                              </button>
                            )
                          )}
                        </div>
                      </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ---------- Phase IA-enterprise — Load More button.
           Cursor pagination over the current filter window. The button
           appears only when the server reports a `nextCursor`. We never
           silently truncate — operators always see how many more pages
           are available via the "Showing X of Y" indicator above. */}
      {state.kind === "ready" && nextCursor && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 14,
          }}
        >
          <Button
            variant="secondary"
            onClick={() => void loadMore()}
            loading={loadingMore}
            data-action="load-more-inbox"
            data-inbox-next-cursor={nextCursor}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

    </PageShell>
  );
}


