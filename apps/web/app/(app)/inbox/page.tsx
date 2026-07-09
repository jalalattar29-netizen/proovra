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
import { formatUserDate, formatUserDateTime } from "../../../lib/date";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

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
  | "intake_link_expiring";

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
  | "intake_link_expiring",
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
  truncated?: InboxTruncated;
  anyTruncated?: boolean;
  pagination?: InboxPagination;
  items: InboxItem[];
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: InboxEnvelope }
  | { kind: "error"; status: number; message: string };

const TONE_STYLES: Record<
  InboxTone,
  { border: string; background: string; chipBg: string; chipFg: string; label: string }
> = {
  critical: {
    border: "rgba(127, 29, 29, 0.65)",
    background: "rgba(239, 68, 68, 0.12)",
    chipBg: "rgba(127, 29, 29, 0.3)",
    chipFg: "#7f1d1d",
    label: "CRITICAL",
  },
  high: {
    border: "rgba(239, 68, 68, 0.55)",
    background: "rgba(239, 68, 68, 0.08)",
    chipBg: "rgba(239, 68, 68, 0.22)",
    chipFg: "#7f1d1d",
    label: "HIGH",
  },
  warning: {
    border: "rgba(245, 158, 11, 0.55)",
    background: "rgba(245, 158, 11, 0.08)",
    chipBg: "rgba(245, 158, 11, 0.22)",
    chipFg: "#78350f",
    label: "WARNING",
  },
  info: {
    border: "rgba(99, 102, 241, 0.45)",
    background: "rgba(99, 102, 241, 0.06)",
    chipBg: "rgba(99, 102, 241, 0.18)",
    chipFg: "#312e81",
    label: "INFO",
  },
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
};

// Phase IA-enterprise — operator-priority tier display metadata. Tiers
// are rendered as section headers above grouped items, so each tier
// gets a short label + accent color.
const PRIORITY_META: Record<
  InboxPriority,
  { label: string; tagline: string; accent: string }
> = {
  P1: {
    label: "P1 · Critical",
    tagline: "Operational failures and critical signals — act now.",
    accent: "#7f1d1d",
  },
  P2: {
    label: "P2 · Requires action",
    tagline: "Items waiting on you (escalations, reviews, approvals, security).",
    accent: "#92400e",
  },
  P3: {
    label: "P3 · Assigned to me",
    tagline: "Discussion mentions + assigned threads.",
    accent: "#1e3a8a",
  },
  P4: {
    label: "P4 · Governance",
    tagline: "Workspace governance + admin notifications.",
    accent: "#3730a3",
  },
  P5: {
    label: "P5 · Notifications",
    tagline: "Awareness signals — informational only.",
    accent: "#475569",
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
  | "admin";

const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: "All",
  critical: "Critical",
  assigned_to_me: "Assigned to me",
  review: "Review",
  governance: "Governance",
  failures: "Failures",
  security: "Security",
  mentions: "Mentions",
  unread: "Unread",
  due_soon: "Due soon",
  overdue: "Overdue",
  admin: "Admin",
};

const INBOX_FILTER_ORDER: ReadonlyArray<InboxFilter> = [
  "all",
  "critical",
  "assigned_to_me",
  "review",
  "governance",
  "failures",
  "security",
  "mentions",
  "due_soon",
  "overdue",
  "admin",
  "unread",
];

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
};

export default function InboxPage() {
  return (
    <PageRouteGate routeId="account.inbox">
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
  // Accumulated items across the current filter window. Reset on
  // filter/tone change; appended on Load More.
  const [items, setItems] = useState<InboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildUrl = useCallback(
    (cursor: string | null): string => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("filter", filter);
      if (toneFilter !== "all") params.set("tone", toneFilter);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return qs ? `/v1/me/inbox?${qs}` : "/v1/me/inbox";
    },
    [filter, toneFilter],
  );

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // `apiFetch` already returns the parsed JSON body (see
      // `apps/web/lib/api.ts:233`). Calling `.json()` on the result
      // throws `TypeError: e.json is not a function` in production
      // (the local variable is minified to `e`).
      const data = (await apiFetch(buildUrl(null))) as InboxEnvelope;
      setState({ kind: "ready", data });
      setItems(data.items);
      setNextCursor(data.pagination?.nextCursor ?? null);
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load inbox." }).message;
      setState({ kind: "error", status, message });
    }
  }, [buildUrl]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = (await apiFetch(buildUrl(nextCursor))) as InboxEnvelope;
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
      console.error("[inbox] load-more failed:", message);
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, nextCursor, loadingMore]);

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

  async function postAction(
    itemKey: string,
    action: "read" | "unread" | "dismiss" | "snooze",
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

  const dismissItem = useCallback(
    async (item: InboxItem) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      // Optimistic remove; if the server rejects we'll re-fetch (the
      // operator's mental model is "I clicked dismiss, it should be
      // gone").
      removeItemLocally(item.itemKey);
      try {
        await postAction(item.itemKey, "dismiss");
      } catch (err) {
        console.error("[inbox] dismiss failed:", err);
        // Re-fetch to restore truth.
        void load();
      } finally {
        setPendingItemKey(null);
      }
    },
    [pendingItemKey, removeItemLocally, load],
  );

  const snoozeItem = useCallback(
    async (item: InboxItem, untilIso: string) => {
      if (pendingItemKey) return;
      setPendingItemKey(item.itemKey);
      removeItemLocally(item.itemKey);
      try {
        await postAction(item.itemKey, "snooze", {
          snoozedUntil: untilIso,
        });
      } catch (err) {
        console.error("[inbox] snooze failed:", err);
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
          eyebrow="Account · Operational inbox"
          title="Inbox"
          subtitle="Operational items that require your attention. Each item is a real, unresolved backend signal — items disappear when the underlying state is resolved (invite accepted, governance event acknowledged, organization joined). No invented alerts."
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
      {/* ---------- summary strip ---------- */}
      {state.kind === "ready" && (
        <section
          data-inbox-summary
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          }}
        >
          {(["critical", "high", "warning", "info"] as InboxTone[]).map(
            (tone) => {
              const count = state.data.summary.byTone[tone];
              const tStyle = TONE_STYLES[tone];
              const active = toneFilter === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  onClick={() => setToneFilter(active ? "all" : tone)}
                  data-inbox-tone-tile={tone}
                  data-inbox-tone-tile-active={active ? "true" : "false"}
                  data-inbox-tone-tile-count={count}
                  style={{
                    padding: "0.6rem 0.8rem",
                    border: `1px solid ${tStyle.border}`,
                    background: active
                      ? tStyle.chipBg
                      : tStyle.background,
                    borderRadius: "var(--radius-card, 12px)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "inherit",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.8 }}>
                    {tStyle.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{count}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {count === 1 ? "item" : "items"}
                  </div>
                </button>
              );
            },
          )}
          <button
            type="button"
            onClick={() => setToneFilter("all")}
            data-inbox-tone-tile="all"
            data-inbox-tone-tile-active={toneFilter === "all" ? "true" : "false"}
            data-inbox-tone-tile-count={state.data.summary.total}
            style={{
              padding: "0.6rem 0.8rem",
              border: "1px dashed var(--border-strong, rgba(127,127,127,0.4))",
              background:
                toneFilter === "all"
                  ? "var(--surface-muted, rgba(127,127,127,0.12))"
                  : "rgba(127,127,127,0.04)",
              borderRadius: "var(--radius-card, 12px)",
              cursor: "pointer",
              textAlign: "left",
              color: "inherit",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.8 }}>
              ALL
            </div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {state.data.summary.total}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {state.data.summary.total === 1 ? "open item" : "open items"}
            </div>
          </button>
        </section>
      )}

      {/* ---------- Phase IA-enterprise — server-driven filter chips.
           These map 1:1 to the backend's `InboxFilter` enum and are
           validated server-side; the server applies the filter so
           admin-only items never reach a non-admin even via crafted
           requests. The chip click triggers a fresh `/v1/me/inbox`
           request with `filter=...` and resets pagination. */}
      {state.kind === "ready" && (
        <section
          data-inbox-filter-chips
          aria-label="Inbox filters"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {INBOX_FILTER_ORDER.map((key) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                data-inbox-filter-chip={key}
                data-inbox-filter-chip-active={active ? "true" : "false"}
                style={{
                  padding: "0.3rem 0.7rem",
                  border: active
                    ? "1px solid var(--status-governance-solid, rgba(99,102,241,0.7))"
                    : "1px solid var(--border-default, rgba(127,127,127,0.4))",
                  background: active
                    ? "var(--status-governance-bg, rgba(99,102,241,0.16))"
                    : "transparent",
                  color: active
                    ? "var(--status-governance-fg, inherit)"
                    : "inherit",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {INBOX_FILTER_LABELS[key]}
              </button>
            );
          })}
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
          style={{
            padding: "0.45rem 0.75rem",
            border: "1px solid var(--border-default, rgba(127,127,127,0.3))",
            background: "var(--surface-muted, rgba(127,127,127,0.04))",
            borderRadius: "var(--radius-card, 12px)",
            fontSize: 12.5,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            color: "var(--ink-secondary, inherit)",
          }}
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
            {state.data.pagination.totalIsExact ? "" : "+"} items
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
        state.data.summary.total === 0 && (
          <div data-state="empty">
            <EmptyState
              framed
              title="Nothing requires your attention right now."
              purpose="When operational items appear — pending invites, governance events, admin governance signals — they show up here. Items disappear automatically when their underlying state resolves (accepted, acknowledged, etc.). No noisy read/unread counters."
              action={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                  <Link
                    href="/home"
                    data-action="empty-open-home"
                    style={cardLinkBtn(true)}
                  >
                    Open workspace command center
                  </Link>
                  <Link
                    href="/organizations"
                    data-action="empty-open-organizations"
                    style={cardLinkBtn(false)}
                  >
                    Organizations
                  </Link>
                </div>
              }
            />
          </div>
        )}

      {state.kind === "ready" &&
        state.data.summary.total > 0 &&
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
                  style={{
                    background: "transparent",
                    border: "1px solid currentColor",
                    borderRadius: 4,
                    padding: "0.2rem 0.5rem",
                    fontSize: 12,
                    cursor: "pointer",
                    marginLeft: 6,
                  }}
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
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 6,
                    paddingBottom: 4,
                    borderBottom: `2px solid ${meta.accent}`,
                  }}
                >
                  <span
                    data-inbox-priority-label={priority}
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      color: meta.accent,
                    }}
                  >
                    {meta.label}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      opacity: 0.75,
                    }}
                  >
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
                    const tStyle = TONE_STYLES[item.tone];
                    return (
                      <li
                        key={item.id}
                        data-inbox-item={item.id}
                        data-inbox-item-key={item.itemKey}
                        data-inbox-item-category={item.category}
                        data-inbox-item-tone={item.tone}
                        data-inbox-item-priority={item.priority}
                        data-inbox-item-read={item.isRead ? "true" : "false"}
                        style={{
                          padding: "0.7rem 0.9rem",
                          border: `1px solid ${tStyle.border}`,
                          background: tStyle.background,
                          borderRadius: "var(--radius-card, 12px)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
                          // Phase IA-reliability — visually de-emphasize
                          // already-read items so unread items pop. We
                          // keep them readable (opacity 0.7) rather than
                          // hiding them outright, so operators can still
                          // re-open / mark-unread if needed.
                          opacity: item.isRead ? 0.7 : 1,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
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
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: 0.5,
                                textTransform: "uppercase",
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: tStyle.chipBg,
                                color: tStyle.chipFg,
                              }}
                            >
                              {tStyle.label}
                            </span>
                            <span
                              data-category-chip={item.category}
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: 0.4,
                                textTransform: "uppercase",
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "rgba(127,127,127,0.18)",
                              }}
                            >
                              {CATEGORY_LABELS[item.category]}
                            </span>
                            <span style={{ fontWeight: 600, fontSize: 14 }}>
                              {item.title}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 12.5,
                              opacity: 0.85,
                              marginTop: 3,
                            }}
                          >
                            {item.body}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              opacity: 0.7,
                              marginTop: 3,
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <span>
                              {formatUserDateTime(item.occurredAt)}
                            </span>
                            {/* Phase IA-cleanup — render real deadlines only
                                when the source row carries one. Overdue rows
                                get a visible badge; future rows show "due …". */}
                            {item.dueAt && (
                              <span
                                data-inbox-item-due={item.dueAt}
                                style={{
                                  fontWeight: 600,
                                  color:
                                    new Date(item.dueAt).getTime() < Date.now()
                                      ? "#7f1d1d"
                                      : "#92400e",
                                }}
                              >
                                {new Date(item.dueAt).getTime() < Date.now()
                                  ? "Overdue · "
                                  : "Due "}
                                {formatUserDate(item.dueAt)}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Phase IA-reliability — per-item action
                            cluster. Open always shows. Mark-read/unread
                            toggles based on current state. Snooze
                            defaults to 1 day; future UI can expose a
                            picker. Dismiss is final (until the source
                            re-fires). */}
                        <div
                          data-inbox-item-actions
                          style={{
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
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
                            style={cardLinkBtn(true)}
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
                              data-action="snooze"
                              data-inbox-item-key={item.itemKey}
                              onClick={() => {
                                const oneDay = new Date(
                                  Date.now() + 24 * 60 * 60 * 1000,
                                ).toISOString();
                                void snoozeItem(item, oneDay);
                              }}
                              disabled={pendingItemKey === item.itemKey}
                            >
                              Snooze 1d
                            </Button>
                          )}
                          {item.canDismiss && (
                            <Button
                              variant="secondary"
                              size="sm"
                              data-action="dismiss"
                              data-inbox-item-key={item.itemKey}
                              onClick={() => void dismissItem(item)}
                              disabled={pendingItemKey === item.itemKey}
                            >
                              Dismiss
                            </Button>
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

      {/* ---------- operational scope panel ---------- */}
      <PageSection
        data-inbox-scope-panel
        title="Operational scope"
        description="Honest summary of what the inbox surfaces today vs what is deliberately deferred to later backend work. Items marked “deferred” are not faked in the UI — the underlying signal either does not exist as a model, or its cross-workspace aggregation is not built."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 10,
          }}
        >
          <div
            data-inbox-scope-block="available"
            style={scopeBlockStyle("available")}
          >
            <div style={scopeBlockTitle}>Available now</div>
            <ul style={scopeListStyle}>
              <li data-inbox-scope-item="pending-org-invites">
                <strong>Pending organization invites.</strong> Email-matched
                invites the caller can accept.
              </li>
              <li data-inbox-scope-item="admin-pending-invites">
                <strong>Admin pending-invite rollup.</strong> One item per
                org the caller administers with open invites.
              </li>
              <li data-inbox-scope-item="governance-notifications">
                <strong>Unacknowledged governance notifications.</strong>{" "}
                Legal hold placed, destruction pending, retention conflict,
                lifecycle drift, export blocked, etc. — per team the caller
                belongs to.
              </li>
              <li data-inbox-scope-item="discussion-mentions">
                <strong>Discussion @-mentions.</strong> Workspace-scoped
                evidence-discussion mentions the caller has not yet been
                notified about. Each opens the exact thread.
              </li>
              <li data-inbox-scope-item="discussion-assigned">
                <strong>Assigned discussion threads.</strong> Open threads
                where the caller is the assignee. Escalated threads bump
                to high tone.
              </li>
              <li data-inbox-scope-item="review-decisions">
                <strong>Multi-stage review decisions.</strong> Conflict-
                detected workflows where the caller is an adjudicator,
                plus awareness for first-stage decisions awaiting peer
                review.
              </li>
              <li data-inbox-scope-item="review-escalations">
                <strong>Review escalations assigned to me.</strong> Open
                workflow-tier escalations with the caller as assignee
                (SLA breach, reviewer inactivity, QC failure, …).
              </li>
              <li data-inbox-scope-item="access-reviews">
                <strong>Access reviews involving me.</strong> Pending
                reviews where the caller is the subject or the initiator,
                with the source dueAt date.
              </li>
              <li data-inbox-scope-item="mfa-recovery-admin">
                <strong>MFA recovery approvals (admin only).</strong>{" "}
                Pending lost-factor reset queue for teams the caller
                OWNs or ADMINs. Never surfaces to non-admins.
              </li>
              <li data-inbox-scope-item="communication-failures">
                <strong>Recent delivery failures (admin only).</strong>{" "}
                Failed SMS/WhatsApp/OTP in the last 24h for teams the
                caller OWNs or ADMINs. Phone preview is masked; OTP
                codes are never persisted.
              </li>
              <li data-inbox-scope-item="my-security-alerts">
                <strong>Security alerts on my account.</strong> High-
                severity SecurityEvents on the caller's userId in the
                last 7 days. Never surfaces other users' events.
              </li>
              <li data-inbox-scope-item="report-failures">
                <strong>Report generation failures.</strong> Sourced from
                OperationalIncident rows with category REPORT (status
                OPEN or ACKNOWLEDGED). Team-scoped via incident.teamId.
                Deep-links to evidence integrity tab when set, else the
                Operations / Observability console.
              </li>
              <li data-inbox-scope-item="package-failures">
                <strong>Verification package failures.</strong> Same
                source + scoping as report failures, category PACKAGE.
              </li>
              <li data-inbox-scope-item="ots-failures">
                <strong>OTS anchoring failures.</strong> Evidence rows
                with otsStatus = FAILED (the Phase-12 OTS pipeline
                terminal state). Never surfaces PENDING /
                RETRY_SCHEDULED / WAITING_CONFIRMATIONS — those are
                normal lifecycle states. Terminal GLOBAL_BUDGET_EXHAUSTED
                renders as critical tone.
              </li>
              <li data-inbox-scope-item="onboarding">
                <strong>Onboarding signals.</strong> No-organizations yet;
                no email identity bound.
              </li>
              <li data-inbox-scope-item="per-user-state">
                <strong>Per-user read / dismiss / snooze.</strong> Read,
                unread, dismiss, and snooze persist per user in the
                InboxItemState table (unique per user + item). Dismissed
                and snoozed items drop out of the list until they re-fire;
                read items de-emphasize. These are real, audited-by-source
                mutations — not local UI state.
              </li>
            </ul>
          </div>
          <div
            data-inbox-scope-block="deferred"
            style={scopeBlockStyle("deferred")}
          >
            <div style={scopeBlockTitle}>Deferred</div>
            <ul style={scopeListStyle}>
              <li data-inbox-scope-item="preferences-ui">
                <strong>Notification preferences UI.</strong> The
                NotificationPreference model is partially wired (per-
                workspace MENTION + ASSIGNED_THREAD toggles); a full UI
                for managing per-category delivery channels is not built.
              </li>
              <li data-inbox-scope-item="email-digest">
                <strong>Email digests / push channels.</strong>{" "}
                Transactional email delivery exists for evidence-request
                and reviewer-assignment paths (the existing
                NotificationDelivery pipeline). Digest / push / SMS aren’t
                wired for inbox items.
              </li>
              <li data-inbox-scope-item="seat-overrun">
                <strong>Billing seat-overrun alerts.</strong> Per-workspace
                billing posture is visible to admins on the
                /organizations/[id] page (Phase A.1B); a seat-overrun
                inbox item is not built — backend has no incident model
                for it yet.
              </li>
            </ul>
          </div>
        </div>
      </PageSection>
    </PageShell>
  );
}

// ---------- shared styles ----------

function cardLinkBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.35rem 0.7rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    textDecoration: "none",
    whiteSpace: "nowrap",
  };
}

function scopeBlockStyle(kind: "available" | "deferred"): React.CSSProperties {
  return {
    padding: "0.7rem 0.85rem",
    border:
      kind === "available"
        ? "1px solid var(--status-verified-border, rgba(34, 197, 94, 0.45))"
        : "1px solid var(--border-default, rgba(127, 127, 127, 0.4))",
    background:
      kind === "available"
        ? "var(--status-verified-bg, rgba(34, 197, 94, 0.06))"
        : "var(--surface-muted, rgba(127, 127, 127, 0.04))",
    borderRadius: "var(--radius-card, 10px)",
    fontSize: 12,
  };
}

const scopeBlockTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  marginBottom: 6,
  opacity: 0.85,
};

const scopeListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: 5,
};
