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

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { useLatestRequest } from "../../../lib/net/useLatestRequest";
import { formatUserDate, formatUserDateTime } from "../../../lib/date";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { AppListbox } from "../../../components/app-primitives";
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
  visibleSecondaryFilters,
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
type InboxFilter =
  | "all"
  | "critical"
  | "assigned_to_me"
  | "review"
  | "governance"
  | "failures"
  | "security"
  | "mentions"
  | "unread"
  | "due_soon"
  | "overdue"
  | "admin"
  | "invitations"
  | "intake"
  | "reports"
  | "packages"
  | "integrity"
  | "collaboration"
  | "snoozed"
  | "history";

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
  snoozed: "Snoozed",
  history: "History",
};

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

/** Oxford-comma join for a human-readable inline list. */
function joinReadable(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * §8 — context-aware attention areas. The page describes ONLY the
 * categories this workspace/plan can actually surface, so a FREE
 * personal user is never told about reviews or governance they cannot
 * receive. Incoming/universal categories (mentions, invitations,
 * security, integrity) always apply and anchor the list.
 */
function describeAttentionAreas(
  uiCtx: ReturnType<typeof useOperationsUiContext>,
  items: ReturnType<typeof buildActualItemSignal>,
): string[] {
  // Universal signals anchor the list; plan/participation areas are added
  // only when the user can genuinely receive them OR already has a real
  // item (the same eligibility-OR-item rule as the filters).
  const has = (cats: InboxCategory[]): boolean =>
    cats.some((c) => (items.byCategory[c] ?? 0) > 0);
  const areas: string[] = ["integrity signals"];
  if (uiCtx.canUseReports || has(["report_failure"]))
    areas.push("report failures");
  if (uiCtx.canUseVerificationPackages || has(["verification_package_failure"]))
    areas.push("verification-package failures");
  if (
    uiCtx.canUseIntake ||
    has([
      "intake_submission_pending_review",
      "intake_required_items_missing",
      "intake_link_expiring",
    ])
  )
    areas.push("intake activity");
  if (uiCtx.canReceiveAssignments || has(["case_assignment", "discussion_assigned"]))
    areas.push("assignments");
  if (uiCtx.canParticipateInReviews || has(["review_decision", "review_escalation"]))
    areas.push("reviews and escalations");
  if (uiCtx.canCollaborate || has(["collaboration", "discussion_mention"]))
    areas.push("mentions");
  if (uiCtx.canReceiveGovernance || has(["governance"]))
    areas.push("governance events");
  areas.push("security alerts");
  return areas;
}

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
  const attentionAreas = describeAttentionAreas(uiCtx, itemSignal);
  const attentionSummary = joinReadable(attentionAreas);
  // Filter grouping (pure policy, unit-tested): a stable primary row +
  // a "More filters" overflow; capability-gated chips (admin,
  // governance) never render for users who can never receive them, and
  // the ACTIVE filter is always visible even while collapsed.
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const primaryFilters = visiblePrimaryFilters(uiCtx, filter, itemSignal);
  const secondaryFilters = visibleSecondaryFilters(uiCtx, filter, itemSignal);
  const workspaceOptions: Array<{ value: string; label: string }> = [
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
  ];
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
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return qs ? `/v1/me/inbox?${qs}` : "/v1/me/inbox";
    },
    [filter, toneFilter, workspaceFilter],
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
  const remindItem = useCallback(
    async (item: InboxItem, untilIso: string) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      removeItemLocally(item.itemKey);
      try {
        await postAction(item.itemKey, "remind", { remindAt: untilIso });
      } catch (err) {
        console.error("[inbox] remind failed:", err);
        void load();
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, removeItemLocally, load],
  );

  // The items the page renders: the accumulated list (already filtered
  // server-side by `filter` + `toneFilter` query params).
  const visibleItems = items;

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
        <PageHeader
          eyebrow="Account · Operations Center"
          title="Operations Center"
          subtitle={`Operational items that require your attention — ${attentionSummary}.`}
          primaryAction={
            <Button
              variant="secondary"
              onClick={() => void load()}
              disabled={state.kind === "loading"}
              data-action="refresh-inbox"
            >
              {state.kind === "loading" ? "Refreshing…" : "Refresh"}
            </Button>
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
        <section data-notifications-summary className="ops-summary-strip">
          <div data-notifications-unread className="ops-summary-strip__primary">
            <span className="ops-summary-strip__count">
              {state.data.scopeSummary?.unread ?? 0}
            </span>
            <span className="ops-summary-strip__label">
              {(state.data.scopeSummary?.unread ?? 0) === 1
                ? "unread notification"
                : "unread notifications"}
            </span>
          </div>

          {/* PHASE 2.3 — HONESTY BEFORE REASSURANCE.
              A "0 unread" over a partial read is the same lie as a dashboard
              saying "all clear", told in less space. When the server could not
              read every source, the page says so instead of implying calm. */}
          {state.data.completeness &&
          !state.data.completeness.mayAssertAllClear ? (
            <p data-notifications-incomplete className="ops-summary-strip__note">
              Some sources could not be read, so this may not be everything.
              {state.data.completeness.incompleteSources.length > 0
                ? ` Affected: ${state.data.completeness.incompleteSources.join(", ")}.`
                : ""}
            </p>
          ) : null}

          {/* Severity as METADATA. Same filter behaviour as before, a fraction
              of the visual weight — these are chips beside the count, not
              five cards competing with the feed for the page. */}
          <div data-notifications-severity className="ops-summary-strip__chips">
            {(["critical", "high", "warning", "info"] as InboxTone[]).map(
              (tone) => {
                const count =
                  state.data.scopeSummary?.byTone[tone] ??
                  state.data.summary.byTone[tone];
                const active = toneFilter === tone;
                const disabled = toneTileDisabled(count, active);
                return (
                  <button
                    key={tone}
                    type="button"
                    onClick={() => setToneFilter(active ? "all" : tone)}
                    aria-pressed={active}
                    disabled={disabled}
                    data-inbox-tone-tile={tone}
                    data-inbox-tone-tile-active={active ? "true" : "false"}
                    data-inbox-tone-tile-count={count}
                    data-tone={tone}
                    data-active={active ? "true" : "false"}
                    className="ops-severity-chip"
                  >
                    <span className="ops-severity-chip__label">
                      {TONE_LABELS[tone]}
                    </span>
                    <span className="ops-severity-chip__count">{count}</span>
                  </button>
                );
              },
            )}
            <button
              type="button"
              onClick={() => setToneFilter("all")}
              aria-pressed={toneFilter === "all"}
              data-inbox-tone-tile="all"
              data-inbox-tone-tile-active={
                toneFilter === "all" ? "true" : "false"
              }
              data-inbox-tone-tile-count={
                state.data.scopeSummary?.total ?? state.data.summary.total
              }
              data-tone="all"
              data-active={toneFilter === "all" ? "true" : "false"}
              className="ops-severity-chip"
            >
              <span className="ops-severity-chip__label">ALL</span>
              <span className="ops-severity-chip__count">
                {state.data.scopeSummary?.total ?? state.data.summary.total}
              </span>
            </button>
          </div>
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
          Operations history is not provisioned in this environment yet.
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

      {/* ---------- Phase IA-enterprise — server-driven filter chips.
           These map 1:1 to the backend's `InboxFilter` enum and are
           validated server-side; the server applies the filter so
           admin-only items never reach a non-admin even via crafted
           requests. The chip click triggers a fresh `/v1/me/inbox`
           request with `filter=...` and resets pagination. */}
      {/* ---------- workspace scope. The default is the canonical
           all-workspaces aggregation; picking a workspace narrows
           SERVER-side (?workspaceId= is membership-validated — a
           crafted id gets a 403, never data). Hidden for single-
           workspace users, where scope is meaningless. */}
      {state.kind === "ready" && workspaceOptions.length > 2 && (
        <section
          data-inbox-workspace-scope
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            id="inbox-workspace-scope-label"
            style={{ fontSize: 12, fontWeight: 600, opacity: 0.75 }}
          >
            Workspace scope
          </span>
          <AppListbox
            value={workspaceFilter}
            options={workspaceOptions}
            onChange={(v) => setWorkspaceFilter(v)}
            ariaLabelledby="inbox-workspace-scope-label"
          />
          <span style={{ fontSize: 11.5, opacity: 0.65 }}>
            {workspaceFilter === "all"
              ? "Showing items from every workspace you belong to."
              : "Showing only this workspace’s items."}
          </span>
        </section>
      )}

      {state.kind === "ready" && (
        <section
          data-inbox-filter-chips
          aria-label="Operations Center filters"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {primaryFilters.map((key) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={active}
                  data-inbox-filter-chip={key}
                  data-inbox-filter-chip-active={active ? "true" : "false"}
                  data-active={active ? "true" : "false"}
                  className="ops-chip"
                >
                  {INBOX_FILTER_LABELS[key]}
                </button>
              );
            })}
            {secondaryFilters.length > 0 ? (
              <button
                type="button"
                onClick={() => setMoreFiltersOpen((v) => !v)}
                aria-expanded={moreFiltersOpen}
                aria-controls="inbox-secondary-filters"
                data-action="toggle-more-filters"
                data-active={moreFiltersOpen ? "true" : "false"}
                className="ops-chip ops-chip--more"
              >
                {moreFiltersOpen
                  ? "Fewer filters"
                  : `More filters (${secondaryFilters.length})`}
              </button>
            ) : null}
          </div>
          {moreFiltersOpen && secondaryFilters.length > 0 ? (
            <div
              id="inbox-secondary-filters"
              data-inbox-secondary-filters
              style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
            >
              {secondaryFilters.map((key) => {
                const active = filter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    aria-pressed={active}
                    data-inbox-filter-chip={key}
                    data-inbox-filter-chip-active={active ? "true" : "false"}
                    data-active={active ? "true" : "false"}
                    className="ops-chip"
                  >
                    {INBOX_FILTER_LABELS[key]}
                  </button>
                );
              })}
            </div>
          ) : null}
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
            Showing {visibleItems.length} of{" "}
            {state.data.pagination.totalEstimate}
            {state.data.pagination.totalIsExact ? "" : "+"}{" "}
            {filter === "all" ? "items" : `${INBOX_FILTER_LABELS[filter]} items`}
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
              title="Nothing requires your attention right now."
              purpose={`When operational items appear — ${attentionSummary} — they show up here. Items leave this list automatically when their source stops raising them. They stay in History.`}
              action={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                  <Link
                    href="/home"
                    data-action="empty-open-home"
                    className="ops-link-btn"
                    data-variant="primary"
                  >
                    Open workspace command center
                  </Link>
                  {uiCtx.hasOrganizations ? (
                    <Link
                      href="/organizations"
                      data-action="empty-open-organizations"
                      className="ops-link-btn"
                    >
                      Organizations
                    </Link>
                  ) : (
                    <Link
                      href="/evidence"
                      data-action="empty-open-evidence"
                      className="ops-link-btn"
                    >
                      Evidence library
                    </Link>
                  )}
                </div>
              }
            />
          </div>
        )}

      {state.kind === "ready" &&
        (state.data.scopeSummary?.total ?? state.data.summary.total) > 0 &&
        visibleItems.length === 0 && (
          <div data-state="filter-empty">
            <Card variant="empty" padding="comfortable">
              <span style={{ fontSize: 14 }}>
                No items match the{" "}
                <strong>{INBOX_FILTER_LABELS[filter]}</strong> filter
                {toneFilter !== "all" ? (
                  <>
                    {" "}
                    with <strong>{toneFilter}</strong> tone
                  </>
                ) : null}{" "}
                right now.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setFilter("all");
                    setToneFilter("all");
                  }}
                  data-action="clear-filter"
                  className="ops-link-btn"
                  style={{ marginLeft: 6 }}
                >
                  Show all
                </button>
              </span>
            </Card>
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
                            className="ops-link-btn"
                    data-variant="primary"
                          >
                            Open
                          </Link>
                          {item.canMarkRead &&
                            (item.isRead ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                data-action="mark-unread"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void markUnread(item)}
                                disabled={pendingItemKey === item.itemKey}
                              >
                                Mark unread
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                data-action="mark-read"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void markRead(item)}
                                disabled={pendingItemKey === item.itemKey}
                              >
                                Mark read
                              </Button>
                            ))}
                          {item.canSnooze && (
                            <Button
                              variant="secondary"
                              size="sm"
                              data-action="remind"
                              data-inbox-item-key={item.itemKey}
                              onClick={() => {
                                const oneDay = new Date(
                                  Date.now() + 24 * 60 * 60 * 1000,
                                ).toISOString();
                                void remindItem(item, oneDay);
                              }}
                              disabled={pendingItemKey === item.itemKey}
                            >
                              Remind me tomorrow
                            </Button>
                          )}
                          {/* ARCHIVE vs UNARCHIVE. An already-archived row
                              (History) offers the way back out; anything else
                              offers the way in. */}
                          {item.dismissedAt ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              data-action="unarchive"
                              data-inbox-item-key={item.itemKey}
                              onClick={() => void unarchiveItem(item)}
                              disabled={pendingItemKey === item.itemKey}
                            >
                              Unarchive
                            </Button>
                          ) : (
                            item.canDismiss && (
                              <Button
                                variant="secondary"
                                size="sm"
                                data-action="archive"
                                data-inbox-item-key={item.itemKey}
                                onClick={() => void archiveItem(item)}
                                disabled={pendingItemKey === item.itemKey}
                              >
                                Archive
                              </Button>
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


