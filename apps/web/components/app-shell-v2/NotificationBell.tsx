"use client";

/**
 * Header Notification Bell — quick awareness, not operational work.
 *
 * Opens a compact popover with the caller's UNREAD operational
 * notifications (top 8) and a single deep link to the Operations
 * Center where the real work happens.
 *
 * One unread calculation platform-wide: the bell polls the CANONICAL
 * aggregation endpoint (`GET /v1/me/inbox?filter=unread&pageSize=8`)
 * — the same server computation the Operations Center renders — so the
 * badge can never disagree with the page. The badge equals
 * `pagination.totalEstimate` of the unread filter: unread actionable
 * notifications only, never total activity, never audit events, never
 * delivery logs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

import { apiFetch } from "../../lib/api";

type BellItem = {
  id: string;
  itemKey: string;
  category: string;
  tone: "info" | "warning" | "high" | "critical";
  priority: "P1" | "P2" | "P3" | "P4" | "P5";
  title: string;
  body: string;
  href: string;
  occurredAt: string;
  canDismiss: boolean;
  context: Record<string, string | number | null>;
};

type UnreadResponse = {
  items: BellItem[];
  pagination: { totalEstimate: number; totalIsExact: boolean };
};

type SummaryResponse = {
  unread: number;
  critical: number;
  high: number;
  assignedToMe: number;
  overdue: number;
  hasTruncatedSources: boolean;
  degraded: boolean;
  generatedAtUtc: string;
};

// Slow poll of the LIGHTWEIGHT cached summary — the full item rows are
// fetched only when the popover opens. Awareness cadence, not realtime.
const POLL_INTERVAL_MS = 120_000;
const PREVIEW_SIZE = 8;

const CATEGORY_LABEL: Record<string, string> = {
  onboarding: "Getting started",
  org_invite: "Invitation",
  org_admin: "Administration",
  governance: "Governance",
  review_decision: "Review",
  discussion_mention: "Mention",
  discussion_assigned: "Assignment",
  review_escalation: "Escalation",
  access_review_pending: "Access review",
  mfa_recovery_pending: "Security",
  communication_failure: "Delivery failure",
  security_event_high: "Security",
  report_failure: "Report",
  verification_package_failure: "Verification package",
  ots_failure: "Integrity",
  intake_submission_pending_review: "Intake",
  intake_required_items_missing: "Intake",
  intake_link_expiring: "Intake",
  collaboration: "Collaboration",
  tsa_failure: "Timestamping",
  case_assignment: "Case assignment",
};

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatCount(n: number, exact: boolean): string {
  if (n <= 0) return "0";
  if (n > 99) return "99+";
  return exact ? String(n) : `${n}+`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [countIsExact, setCountIsExact] = useState(true);
  const [items, setItems] = useState<BellItem[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Lightweight summary poll — drives the badge only. The summary is
  // computed server-side from the SAME canonical aggregation as the
  // Operations Center (cached per user, invalidated on every mutation),
  // so the badge and the page cannot disagree.
  const loadSummary = useCallback(async () => {
    try {
      const res = (await apiFetch("/v1/me/inbox/summary")) as SummaryResponse;
      setUnreadCount(res.unread);
      setCountIsExact(!res.hasTruncatedSources);
    } catch {
      // Best-effort awareness surface — never break the header.
    }
  }, []);

  // Full rows are fetched ONLY when the popover opens.
  const loadItems = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/me/inbox?filter=unread&pageSize=${PREVIEW_SIZE}`,
      )) as UnreadResponse;
      setItems(res.items);
      setUnreadCount(res.pagination.totalEstimate);
      setCountIsExact(res.pagination.totalIsExact);
    } catch {
      // Leave the previous list; the Operations Center is the recovery path.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      await loadSummary();
      if (alive) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [loadSummary]);

  // Fetch rows on open; close on outside click and on Escape.
  useEffect(() => {
    if (!open) return;
    void loadItems();
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, loadItems]);

  async function mutate(itemKey: string, action: "read" | "dismiss") {
    if (busyKey) return;
    setBusyKey(itemKey);
    try {
      await apiFetch(
        `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
        { method: "POST" },
      );
      // Reconcile with the server (the mutation invalidated the summary
      // cache, so both refetches return the post-mutation truth).
      await Promise.all([loadItems(), loadSummary()]);
    } catch {
      // Leave the item in place; the Operations Center is the recovery path.
    } finally {
      setBusyKey(null);
    }
  }

  async function markAllRead() {
    if (busyKey) return;
    setBusyKey("__all__");
    try {
      await apiFetch("/v1/me/inbox/mark-all-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await Promise.all([loadItems(), loadSummary()]);
    } catch {
      /* server state unchanged on failure */
    } finally {
      setBusyKey(null);
    }
  }

  const has = unreadCount > 0;

  return (
    <div ref={rootRef} style={{ position: "relative" }} data-app-notification-bell>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        title="Unread operational items across all your workspaces"
        aria-expanded={open}
        aria-label={
          has
            ? `Notifications: ${formatCount(unreadCount, countIsExact)} unread`
            : "Notifications"
        }
        data-notification-bell-unread={unreadCount}
        data-has-unread={has ? "true" : "false"}
        className="ops-bell"
      >
        <Bell size={16} strokeWidth={1.9} />
        {has ? (
          <span
            aria-hidden="true"
            data-notification-bell-badge
            className="ops-bell__badge"
          >
            {formatCount(unreadCount, countIsExact)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Unread notifications"
          data-notification-bell-popover
          className="ops-bell-popover"
        >
          <div className="ops-bell-popover__header">
            <strong style={{ fontSize: 13 }}>Notifications</strong>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 12, opacity: 0.6 }} aria-live="polite">
                {has
                  ? `${formatCount(unreadCount, countIsExact)} unread`
                  : "All caught up"}
              </span>
              {has ? (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  disabled={busyKey !== null}
                  aria-busy={busyKey === "__all__"}
                  className="ops-bell-action"
                >
                  Mark all as read
                </button>
              ) : null}
            </span>
          </div>

          <div className="ops-bell-popover__scroll">
            {items === null ? (
              <p className="ops-bell-popover__empty" aria-live="polite">
                Loading…
              </p>
            ) : items.length === 0 ? (
              <p className="ops-bell-popover__empty">
                No unread notifications.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {items.map((it) => {
                  const workspace =
                    (it.context?.teamName as string | null) ??
                    (it.context?.organizationName as string | null) ??
                    null;
                  return (
                    <li key={it.itemKey} className="ops-bell-row">
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span
                          aria-hidden="true"
                          className="ops-bell-row__dot"
                          data-tone={it.tone}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="ops-bell-row__meta">
                            <span>{CATEGORY_LABEL[it.category] ?? it.category}</span>
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime(it.occurredAt)}</span>
                            {workspace ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{workspace}</span>
                              </>
                            ) : null}
                          </div>
                          <Link
                            href={it.href}
                            onClick={() => {
                              setOpen(false);
                              void mutate(it.itemKey, "read");
                            }}
                            className="ops-bell-row__title"
                          >
                            {it.title}
                          </Link>
                          <div className="ops-bell-row__body">{it.body}</div>
                          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                            <button
                              type="button"
                              onClick={() => void mutate(it.itemKey, "read")}
                              disabled={busyKey === it.itemKey}
                              aria-busy={busyKey === it.itemKey}
                              className="ops-bell-action"
                            >
                              Mark read
                            </button>
                            {it.canDismiss ? (
                              <button
                                type="button"
                                onClick={() => void mutate(it.itemKey, "dismiss")}
                                disabled={busyKey === it.itemKey}
                                className="ops-bell-action"
                              >
                                Dismiss
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Link
            href="/inbox"
            onClick={() => setOpen(false)}
            className="ops-bell-footer"
          >
            View Operations Center →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
