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
  shouldOfferMarkAllRead,
  shouldOfferMarkCategoryRead,
  toneTileDisabled,
  visiblePrimaryFilters,
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
type NotificationMetricKey = "unread" | "all" | InboxTone;

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

// Phase IA-enterprise — operator-priority tier display metadata. Tiers
// are rendered as section headers above grouped items, so each tier
// gets a short label + accent color.
const PRIORITY_META: Record<
  InboxPriority,
  { label: string; tagline: string }
> = {
  P1: {
    label: "P1 · Critical",
    tagline: "Operational failures and critical signals — act now.",
  },
  P2: {
    label: "P2 · Requires action",
    tagline: "Items waiting on you (escalations, reviews, approvals, security).",
  },
  P3: {
    label: "P3 · Assigned to me",
    tagline: "Discussion mentions + assigned threads.",
  },
  P4: {
    label: "P4 · Governance",
    tagline: "Workspace governance + admin notifications.",
  },
  P5: {
    label: "P5 · Awareness",
    tagline: "Awareness signals — informational only.",
  },
};

const PRIORITY_ORDER: ReadonlyArray<InboxPriority> = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
];

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

/** Filters that make sense as a "mark this category as read" scope —
 *  everything except the whole-queue/state views. */
function isCategoryFilter(f: InboxFilter): boolean {
  return f !== "all" && f !== "unread" && f !== "history" && f !== "snoozed";
}

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
  // Phase IA-enterprise — tone tile filter (existing UX) + the 12-key
  // server-driven filter chip. Both are sent to the backend as query
  // params; the server applies them and returns the post-filter
  // summary + paginated items.
  const [toneFilter, setToneFilter] = useState<"all" | InboxTone>("all");
  const [filter, setFilter] = useState<InboxFilter>("all");
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
   * One count per metric card, read from the SCOPE summary.
   *
   * `scopeSummary` is filter-independent — it describes the workspace scope
   * rather than the current filter window — which is what a summary strip has
   * to be: a set of cards whose numbers changed every time you clicked one of
   * them would be describing the click, not the inbox.
   */
  const metricCount = (
    key: NotificationMetricKey,
    data: InboxEnvelope,
  ): number => {
    if (key === "unread") return data.scopeSummary?.unread ?? 0;
    if (key === "all") return data.scopeSummary?.total ?? data.summary.total;
    return data.scopeSummary?.byTone[key] ?? data.summary.byTone[key];
  };

  /**
   * Clicking a card applies the filter it names, and clicking it again clears
   * it — the card is a toggle, so the surface always matches what the card
   * promised. `All` clears both axes, because that is what it says.
   */
  const selectMetric = (key: NotificationMetricKey) => {
    if (key === "unread") {
      setFilter(filter === "unread" ? "all" : "unread");
      return;
    }
    if (key === "all") {
      setFilter("all");
      setToneFilter("all");
      return;
    }
    setToneFilter(toneFilter === key ? "all" : key);
  };
  // Filter grouping (pure policy, unit-tested): a stable QUICK row of three,
  // plus grouped advanced filters behind one control. Capability-gated
  // options (admin, governance) never render for users who can never receive
  // them — the policy decides, this page only draws it.
  const quickFilters = visiblePrimaryFilters(uiCtx, filter, itemSignal);
  const advancedGroups = visibleAdvancedFilterGroups(uiCtx, itemSignal);
  const activeFilterCount = activeAdvancedFilterCount({
    filter,
    tone: toneFilter,
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
   * THE VIEW IS IN THE URL.
   *
   * Refreshing used to drop the reader back to "All / Newest", which on a page
   * whose whole job is narrowing a list is the one thing that makes narrowing
   * feel unsafe. The three axes and the ordering now round-trip through the
   * query string, so a refresh keeps the view and a link to it describes it:
   *
   *     /notifications?filter=archived&tone=critical&sort=oldest
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
   * The honest cost is that in-app back/forward does not restore a previous
   * filter combination; refresh, bookmark and share — the cases people
   * actually hit — all do.
   *
   * VALIDATED on the way in. A hand-edited or stale query string resolves to
   * the default rather than putting an unknown key into a request.
   */
  const [urlHydrated, setUrlHydrated] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("filter");
    if (f && ALL_INBOX_FILTERS.includes(f as InboxFilter)) {
      setFilter(f as InboxFilter);
    }
    const t = params.get("tone");
    if (t && (["critical", "high", "warning", "info"] as const).includes(
      t as InboxTone,
    )) {
      setToneFilter(t as InboxTone);
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
    if (filter !== "all") params.set("filter", filter);
    if (toneFilter !== "all") params.set("tone", toneFilter);
    if (workspaceFilter !== "all") params.set("workspaceId", workspaceFilter);
    if (sort !== DEFAULT_SORT) params.set("sort", sort);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [urlHydrated, filter, toneFilter, workspaceFilter, sort]);

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
   * A quick filter is the page's LIFECYCLE state, so selecting one clears the
   * tone narrowing with it: "show me everything I have archived" and "…but
   * only the critical ones" are two different requests, and silently keeping
   * the second is how a reader concludes their archive is empty.
   */
  const selectQuickFilter = useCallback(
    (key: InboxFilter) => {
      setFilter(key);
      setToneFilter("all");
    },
    [],
  );

  /** Advanced filters are single-choice; clicking the active one clears it. */
  const selectAdvancedFilter = useCallback(
    (key: InboxFilter) => {
      setFilter((current) => (current === key ? "all" : key));
    },
    [],
  );

  const clearAllFilters = useCallback(() => {
    setFilter("all");
    setToneFilter("all");
    setWorkspaceFilter("all");
  }, []);

  /**
   * THE ACTIVE-FILTER SUMMARY, derived — never a second copy of the state.
   *
   * Only axes that are actually narrowing the list appear, each with the one
   * action that undoes it. The quick row is excluded for the same reason it
   * does not count towards the badge: `All`/`Unread`/`Archived` is where the
   * page always is, not something applied on top of it.
   */
  const activeChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; clear: () => void }> = [];
    if (!QUICK_OPERATIONS_FILTERS.includes(filter)) {
      chips.push({
        id: filter,
        label: INBOX_FILTER_LABELS[filter],
        clear: () => setFilter("all"),
      });
    }
    if (toneFilter !== "all") {
      chips.push({
        id: `tone:${toneFilter}`,
        label: TONE_LABELS[toneFilter],
        clear: () => setToneFilter("all"),
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
  }, [filter, toneFilter, workspaceFilter, workspaceOptions]);
  // Accumulated items across the current filter window. Reset on
  // filter/tone change; appended on Load More.
  const [items, setItems] = useState<InboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<"all" | "category" | null>(null);

  const buildUrl = useCallback(
    (cursor: string | null): string => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("filter", filter);
      if (toneFilter !== "all") params.set("tone", toneFilter);
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
    [filter, toneFilter, workspaceFilter, sort],
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

  /**
   * SERVER-scoped bulk read. The backend re-derives the caller's visible
   * unread items from the canonical aggregation (optionally narrowed by
   * ONE validated filter key) — no item keys leave the client. Read is
   * attention state only.
   */
  const markAllRead = useCallback(
    async (bulkFilter: InboxFilter | null) => {
      if (bulkBusy) return;
      setBulkBusy(bulkFilter ? "category" : "all");
      try {
        await apiFetch("/v1/me/inbox/mark-all-read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bulkFilter ? { filter: bulkFilter } : {}),
        });
        await load();
      } catch {
        /* server state unchanged on failure; the list stays as-is */
      } finally {
        setBulkBusy(null);
      }
    },
    [bulkBusy, load],
  );

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
    if (filter === "archived") return `archived ${plural}`;
    if (filter === "unread") return `unread ${plural}`;
    if (filter === "all") return plural;
    return `${INBOX_FILTER_LABELS[filter].toLowerCase()} ${plural}`;
  }, [filter, visibleItems.length]);

  // Group visibleItems by priority for the section render. Items keep
  // their server-assigned position within a priority bucket.
  const itemsByPriority: Record<InboxPriority, InboxItem[]> = {
    P1: [],
    P2: [],
    P3: [],
    P4: [],
    P5: [],
  };
  for (const it of visibleItems) {
    itemsByPriority[it.priority].push(it);
  }

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
      {state.kind === "ready" && (
        <section
          data-notifications-summary
          aria-label="Notification summary"
          className="ops-metrics"
        >
          <ul className="ops-metrics__grid" data-notifications-metric-grid>
            {NOTIFICATION_METRICS.map((metric) => {
              const count = metricCount(metric.key, state.data);
              const active = metric.tone
                ? toneFilter === metric.tone
                : metric.key === "unread"
                  ? filter === "unread"
                  : toneFilter === "all" && filter === "all";
              const disabled = metric.tone
                ? toneTileDisabled(count, active)
                : false;
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
                    aria-pressed={active}
                    aria-describedby={descId}
                    disabled={disabled}
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
          {state.data.completeness &&
          !state.data.completeness.mayAssertAllClear ? (
            <p data-notifications-incomplete className="ops-metrics__note">
              Some sources could not be read, so this may not be everything.
              {state.data.completeness.incompleteSources.length > 0
                ? ` Affected: ${state.data.completeness.incompleteSources.join(", ")}.`
                : ""}
            </p>
          ) : null}
        </section>
      )}

      {state.kind === "ready" &&
      filter === "history" &&
      state.data.historyAvailable === false ? (
        <section
          data-inbox-history-unavailable
          role="status"
          className="ops-note"
        >
          Archived notifications are not available in this environment yet.
        </section>
      ) : null}

      {/* ---------- bulk read actions. SERVER-scoped: the backend re-runs
           the canonical aggregation for the caller and marks exactly the
           visible unread items (optionally one validated category) — the
           frontend never submits item keys for mass updates. Read is
           attention-state only: it never resolves, dismisses, or
           acknowledges anything. */}
      {state.kind === "ready" &&
        filter !== "history" &&
        filter !== "snoozed" &&
        shouldOfferMarkAllRead(
          state.data.scopeSummary?.unread ?? state.data.summary.total,
        ) && (
        <section
          data-inbox-bulk-actions
          aria-label="Bulk read actions"
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Button
            variant="secondary"
            data-action="mark-all-read"
            loading={bulkBusy === "all"}
            onClick={() => void markAllRead(null)}
          >
            Mark all as read
          </Button>
          {shouldOfferMarkCategoryRead(
            state.data.scopeSummary?.unread ?? state.data.summary.total,
            state.data.summary.total,
            isCategoryFilter(filter),
          ) ? (
            <Button
              variant="secondary"
              data-action="mark-category-read"
              loading={bulkBusy === "category"}
              onClick={() => void markAllRead(filter)}
            >
              Mark {INBOX_FILTER_LABELS[filter].toLowerCase()} as read
            </Button>
          ) : null}
        </section>
      )}

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
      {state.kind === "ready" && (
        <section
          data-inbox-toolbar
          className="ops-toolbar"
          aria-label="Notification filters and sorting"
        >
          <div className="ops-toolbar__quick" data-inbox-quick-filters>
            {quickFilters.map((key) => {
              const active = filter === key;
              /* Archived items are archived-AND-read by construction — the
                 archive action writes both stamps in one mutation, so an
                 "archived but unread" item cannot exist. Offering Unread while
                 Archived is in force would be offering a view guaranteed to be
                 empty, so it is disabled and says why. */
              const meaningless = key === "unread" && filter === "archived";
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectQuickFilter(key)}
                  aria-pressed={active}
                  disabled={meaningless}
                  title={
                    meaningless
                      ? "Archived notifications are always marked read."
                      : undefined
                  }
                  data-inbox-filter-chip={key}
                  data-inbox-filter-chip-active={active ? "true" : "false"}
                  data-active={active ? "true" : "false"}
                  className="app-chip ops-quick-chip"
                >
                  {INBOX_FILTER_LABELS[key]}
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
                          const active = filter === key;
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
      {state.kind === "ready" && activeChips.length > 0 && (
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
          className="ops-note"
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
                three they are in, because only one of them has an action. */}
            {filter === "archived" && activeFilterCount === 0 ? (
              <Card variant="empty" padding="comfortable">
                <span
                  style={{ fontSize: 14 }}
                  data-inbox-empty-reason="archive"
                >
                  No archived notifications. Archiving a notification files it
                  here and takes it out of your active list.
                </span>
              </Card>
            ) : (
              <Card variant="empty" padding="comfortable">
                <span
                  style={{ fontSize: 14 }}
                  data-inbox-empty-reason="filters"
                >
                  No notifications match these filters.{" "}
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    data-action="clear-filter"
                    className="ops-link-btn"
                    style={{ marginInlineStart: 6 }}
                  >
                    Clear filters
                  </button>
                </span>
              </Card>
            )}
          </div>
        )}

      {/* ---------- Phase IA-enterprise — items grouped by priority.
           Within each priority section the server's sort order is
           preserved (priority → due posture → tone → recency). The
           operator can see at a glance how many critical items they
           have vs awareness signals. */}
      {state.kind === "ready" && visibleItems.length > 0 && (
        <div
          data-inbox-items
          data-inbox-visible-count={visibleItems.length}
          style={{ display: "grid", gap: 14 }}
        >
          {PRIORITY_ORDER.map((priority) => {
            const groupItems = itemsByPriority[priority];
            if (groupItems.length === 0) return null;
            const meta = PRIORITY_META[priority];
            return (
              <section
                key={priority}
                data-inbox-priority-section={priority}
                data-inbox-priority-count={groupItems.length}
              >
                <header
                  className="ops-priority-header"
                  data-priority={priority}
                >
                  <span
                    data-inbox-priority-label={priority}
                    className="ops-priority-header__label"
                  >
                    {meta.label}
                  </span>
                  <span className="ops-priority-header__tagline">
                    {meta.tagline} · {groupItems.length}{" "}
                    {groupItems.length === 1 ? "item" : "items"}
                  </span>
                </header>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  {groupItems.map((item) => {
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
                               page knew about. */
                            className="app-secondary-action"
                          >
                            Open
                          </Link>
                          {item.canMarkRead &&
                            (item.isRead ? (
                              <button
                                type="button"
                                className="app-secondary-action"
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
                                className="app-secondary-action"
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
              </section>
            );
          })}
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


