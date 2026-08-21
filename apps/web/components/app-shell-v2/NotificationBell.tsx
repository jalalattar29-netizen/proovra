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
import { formatUserDate } from "../../lib/date";
import { useDeepLinkNavigation } from "../../lib/navigation/useDeepLinkNavigation";
import { usePlatformContext } from "../../lib/platform-context";

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
  return formatUserDate(iso);
}

function formatCount(n: number, exact: boolean): string {
  if (n <= 0) return "0";
  if (n > 99) return "99+";
  return exact ? String(n) : `${n}+`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  // PHASE 11 §4 — notification destinations may name a tenant resource in
  // another Workspace; they navigate through the ONE deep-link chokepoint
  // (server resolve → dirty-work guard → stale rejection), never raw.
  const { open: openDestination } = useDeepLinkNavigation();
  // The canonical identity/tenant generation. It advances whenever the signed-in
  // account or the active workspace changes, and it is the ONE signal this
  // component uses to decide that everything it holds belongs to a context that
  // no longer exists.
  const { contextGeneration } = usePlatformContext();
  const [deniedKey, setDeniedKey] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [countIsExact, setCountIsExact] = useState(true);
  const [items, setItems] = useState<BellItem[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  /**
   * THE EPOCH — why awaiting the mutation is not enough on its own.
   *
   * The badge has three independent producers: the 120s summary poll, the
   * popover's row fetch, and the post-mutation refetch. They race. A poll that
   * left before `Mark all as read` committed can land after it, and its body is
   * a truthful description of a world that no longer exists — so applying it
   * silently restores the count the user just cleared. On screen that is
   * indistinguishable from the mutation having failed, which is precisely the
   * symptom this component was reported for.
   *
   * Every read captures the epoch it started in; every mutation and every
   * identity change advances it. A response from a superseded epoch is
   * DISCARDED, never merged. The request is aborted at the same moment, so the
   * discard is usually free rather than merely late.
   *
   * Refs rather than state: the guard has to be readable by a closure that is
   * already suspended at an `await`, and a state update is not visible there.
   */
  const epochRef = useRef(0);
  const inFlightRef = useRef<Set<AbortController>>(new Set());
  /**
   * The re-entrancy guard for mutations.
   *
   * `busyKey` disables the buttons, but `disabled` is a rendering outcome and
   * cannot stop a second call that is dispatched before React commits — a held
   * Enter key, a double tap, a synthetic event. The ref is set synchronously
   * inside the handler, so the second call returns before it reaches the wire.
   */
  const mutationInFlightRef = useRef(false);

  /** Supersede every read now in flight, and return the new epoch. */
  const bumpEpoch = useCallback((): number => {
    for (const ctrl of inFlightRef.current) ctrl.abort();
    inFlightRef.current.clear();
    epochRef.current += 1;
    return epochRef.current;
  }, []);

  /**
   * Run one read under the current epoch.
   *
   * Returns `null` when the response must not be applied — superseded, aborted
   * or failed. A caller therefore cannot accidentally apply a stale body:
   * there is no body to apply.
   */
  const readUnderEpoch = useCallback(
    async <T,>(path: string): Promise<T | null> => {
      const epoch = epochRef.current;
      const ctrl = new AbortController();
      inFlightRef.current.add(ctrl);
      try {
        const res = (await apiFetch(path, { signal: ctrl.signal })) as T;
        return epoch === epochRef.current ? res : null;
      } catch {
        // Best-effort awareness surface — never break the header. An abort and
        // a transport failure are both "no usable answer", and both leave what
        // is already on screen alone.
        return null;
      } finally {
        inFlightRef.current.delete(ctrl);
      }
    },
    [],
  );

  // Lightweight summary poll — drives the badge only. The summary is
  // computed server-side from the SAME canonical aggregation as the
  // Operations Center (cached per user, invalidated on every mutation),
  // so the badge and the page cannot disagree.
  const loadSummary = useCallback(async () => {
    const res = await readUnderEpoch<SummaryResponse>("/v1/me/inbox/summary");
    if (!res) return;
    setUnreadCount(res.unread);
    setCountIsExact(!res.hasTruncatedSources);
  }, [readUnderEpoch]);

  // Full rows are fetched ONLY when the popover opens.
  const loadItems = useCallback(async () => {
    const res = await readUnderEpoch<UnreadResponse>(
      `/v1/me/inbox?filter=unread&pageSize=${PREVIEW_SIZE}`,
    );
    if (!res) return;
    setItems(res.items);
    setUnreadCount(res.pagination.totalEstimate);
    setCountIsExact(res.pagination.totalIsExact);
  }, [readUnderEpoch]);

  /**
   * IDENTITY / TENANT CHANGE — drop everything rather than decay into it.
   *
   * The bell aggregates across the caller's workspaces, so switching workspace
   * does not change WHAT it counts — but switching account does, and both
   * advance the same generation. Leaving the old count on screen while the new
   * one loads would attribute one account's unread work to another. The reset
   * is synchronous with the generation change; the effects below repopulate.
   */
  useEffect(() => {
    bumpEpoch();
    mutationInFlightRef.current = false;
    setItems(null);
    setUnreadCount(0);
    setCountIsExact(true);
    setDeniedKey(null);
    setActionNotice(null);
    setBusyKey(null);
  }, [contextGeneration, bumpEpoch]);

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

  // Focus management — move focus into the popover on open, keep Tab
  // cycling inside it (light trap for a non-modal dialog), and hand
  // focus back to the bell trigger on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    const popover = popoverRef.current;
    // Captured while the popover is OPEN: the cleanup below must return focus
    // to the element that owned it then, not to whatever the ref happens to
    // point at once React has re-rendered/unmounted the trigger.
    const trigger = triggerRef.current;
    const focusables = () =>
      popover
        ? Array.from(
            popover.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled])',
            ),
          )
        : [];
    focusables()[0]?.focus();
    function onTrapKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    popover?.addEventListener("keydown", onTrapKeyDown);
    return () => {
      popover?.removeEventListener("keydown", onTrapKeyDown);
      trigger?.focus();
    };
  }, [open]);

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

  /**
   * One mutation, then reconcile with the SERVER.
   *
   * There is deliberately no local decrement. A client-side count is a guess
   * about a computation that runs over ~19 sources server-side, and a guess
   * that disagrees with the next poll produces a number that jumps — which is
   * worse than a number that lags. The refetch is the answer; the epoch bump
   * is what stops an older answer from overwriting it.
   */
  async function mutate(itemKey: string, action: "read" | "dismiss") {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusyKey(itemKey);
    setActionNotice(null);
    try {
      await apiFetch(
        `/v1/me/inbox/items/${encodeURIComponent(itemKey)}/${action}`,
        { method: "POST" },
      );
      // Everything that left before this write is now describing the previous
      // state of the inbox and must not be applied.
      bumpEpoch();
      // Reconcile with the server (the mutation invalidated the summary
      // cache, so both refetches return the post-mutation truth).
      await Promise.all([loadItems(), loadSummary()]);
      setActionNotice(
        action === "read" ? "Notification marked as read." : "Notification dismissed.",
      );
    } catch {
      // The write did not happen, so nothing local may claim it did — the item
      // stays exactly where it is and the failure is announced rather than
      // swallowed. The Operations Center remains the recovery path.
      setActionNotice(
        action === "read"
          ? "Could not mark that notification as read."
          : "Could not dismiss that notification.",
      );
    } finally {
      mutationInFlightRef.current = false;
      setBusyKey(null);
    }
  }

  async function markAllRead() {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusyKey("__all__");
    setActionNotice(null);
    try {
      const res = (await apiFetch("/v1/me/inbox/mark-all-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })) as { markedRead?: number } | null;
      bumpEpoch();
      await Promise.all([loadItems(), loadSummary()]);
      // What the SERVER did, not what was asked for. A bulk read that found
      // nothing to do is a real outcome and says so.
      const marked = typeof res?.markedRead === "number" ? res.markedRead : null;
      setActionNotice(
        marked === 0
          ? "Nothing left to mark as read."
          : marked === 1
            ? "1 notification marked as read."
            : marked === null
              ? "Notifications marked as read."
              : `${marked} notifications marked as read.`,
      );
    } catch {
      /* server state unchanged on failure */
      setActionNotice("Could not mark notifications as read.");
    } finally {
      mutationInFlightRef.current = false;
      setBusyKey(null);
    }
  }

  const has = unreadCount > 0;

  return (
    <div ref={rootRef} style={{ position: "relative" }} data-app-notification-bell>
      <button
        ref={triggerRef}
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
          ref={popoverRef}
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
                  data-notification-action="mark-all"
                  className="ops-bell-action"
                >
                  Mark all as read
                </button>
              ) : null}
            </span>
          </div>

          {/*
            THE OUTCOME OF THE LAST ACTION, announced.

            Every one of these actions used to be silent on failure — the
            request was awaited inside an empty `catch` and the row simply did
            not move. A sighted user could infer something from the unchanged
            badge; a screen-reader user got nothing at all. This region carries
            what the SERVER did, including "nothing", and it is the only place
            a mutation result is stated.
          */}
          {actionNotice ? (
            <p
              role="status"
              aria-live="polite"
              data-notification-action-status
              className="ops-bell-popover__empty"
            >
              {actionNotice}
            </p>
          ) : null}

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
                          <a
                            href={it.href}
                            onClick={(e) => {
                              // §4 — the destination is opened ONLY via the
                              // canonical chokepoint (server resolve first);
                              // the raw href never navigates directly.
                              e.preventDefault();
                              void openDestination(it.href).then((result) => {
                                if (result.status === "navigated") {
                                  setOpen(false);
                                  void mutate(it.itemKey, "read");
                                } else if (result.status === "denied") {
                                  // Anti-enumeration: one generic message for
                                  // every denial — nothing about existence.
                                  setDeniedKey(it.itemKey);
                                }
                              });
                            }}
                            data-notification-destination
                            className="ops-bell-row__title"
                          >
                            {it.title}
                          </a>
                          {deniedKey === it.itemKey ? (
                            <div
                              role="status"
                              data-notification-destination-denied
                              className="ops-bell-row__body"
                            >
                              This item is not available.
                            </div>
                          ) : null}
                          <div className="ops-bell-row__body">{it.body}</div>
                          {/*
                            TWO CONTROLS, TWO NAMES.

                            These are separate actions with separate outcomes,
                            and their accessible names have to say which item
                            they act on: a popover holding eight rows otherwise
                            offers eight buttons all called "Mark read", and a
                            screen-reader user moving through them by control
                            has no way to tell them apart. Reading the row in
                            sequence also used to run the two labels together
                            as one string.

                            `aria-label` carries the item title; the visible
                            text stays short. Each control is disabled and
                            marked busy independently while THIS row is in
                            flight, and neither is nested inside the other or
                            inside the row's link.
                          */}
                          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                            <button
                              type="button"
                              onClick={() => void mutate(it.itemKey, "read")}
                              disabled={busyKey !== null}
                              aria-busy={busyKey === it.itemKey}
                              aria-label={`Mark as read: ${it.title}`}
                              data-notification-action="read"
                              className="ops-bell-action"
                            >
                              Mark read
                            </button>
                            {it.canDismiss ? (
                              <button
                                type="button"
                                onClick={() => void mutate(it.itemKey, "dismiss")}
                                disabled={busyKey !== null}
                                aria-busy={busyKey === it.itemKey}
                                aria-label={`Dismiss: ${it.title}`}
                                data-notification-action="dismiss"
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
