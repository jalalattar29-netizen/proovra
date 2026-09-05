"use client";

/**
 * Header Notification Bell — recent awareness, not operational work.
 *
 * WHAT IT SHOWS
 *
 * The FIVE most recent visible notifications for the signed-in user in the
 * ACTIVE workspace — read and unread alike — plus one deep link to the
 * Operations Center, where the full queue and its history live.
 *
 * WHAT CHANGED, AND WHY
 *
 * It used to query `filter=unread`, so the list WAS the unread set. Marking
 * something read therefore deleted it from the panel: the act of
 * acknowledging a notification was indistinguishable, on screen, from
 * dismissing it, and there was no way to see what you had just read. Worse,
 * a caught-up user saw an empty popover and had no idea whether that meant
 * "nothing happened" or "you already read it".
 *
 * So the two concepts are now separate, and each has one owner:
 *
 *   READ      is a STATE. The row stays, in a quieter presentation, and
 *             leaves the badge count.
 *   DISMISSED is REMOVAL. The row goes, the next most recent eligible item
 *             takes its place, and the audit history is untouched.
 *
 * ONE VISIBILITY AUTHORITY. The list and the badge are two reads of the same
 * server aggregation, scoped to the same workspace: the list is
 * `filter=all&sort=recent&pageSize=5`, the badge is that aggregation's unread
 * count. Neither is computed here, and they cannot disagree because neither
 * gets to decide.
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
  /**
   * READ IS A STATE, NOT A DISAPPEARANCE.
   *
   * The list used to be `filter=unread`, so marking an item read removed it —
   * the only way to see what you had just acknowledged was to open the
   * Operations Center. The list is now the five most recent VISIBLE items,
   * read and unread alike, and this field is what separates the two
   * presentations.
   */
  isRead: boolean;
  canDismiss: boolean;
  context: Record<string, string | number | null>;
};

type RecentResponse = {
  items: BellItem[];
  pagination: { totalEstimate: number; totalIsExact: boolean };
};

type SummaryResponse = {
  /** UNREAD and non-dismissed only. Read items are in the list, not here. */
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
/**
 * FIVE. The bell is a glance, not a queue.
 *
 * It was eight, and eight UNREAD — so a busy workspace filled the popover with
 * a backlog and a quiet one showed nothing at all. Five most-recent items,
 * whatever their read state, is a consistent amount of recent history, and the
 * Operations Center is one click away for the rest.
 */
const PREVIEW_SIZE = 5;

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

/**
 * Attach the active workspace to a bell request.
 *
 * Built once so the list and the summary cannot be scoped differently — the
 * whole point of scoping them at all is that they describe one population.
 * A null workspace (no active context yet) sends nothing, which the server
 * reads as "every workspace this caller belongs to".
 */
function withWorkspace(path: string, workspaceId: string | null): string {
  if (!workspaceId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
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
  const { contextGeneration, activeWorkspaceId, state: contextState } =
    usePlatformContext();
  /*
   * Has the workspace been DECIDED yet?
   *
   * Not "is it non-null" — a resolved context can legitimately have no
   * workspace, and the bell still belongs on screen for that person. This
   * distinguishes "no workspace" from "we have not been told yet", which are
   * the same `null` and very different questions.
   */
  const workspaceResolved = contextState?.name !== "LOADING_CONTEXT";
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
    // SAME SCOPE as the list. A badge counted across every workspace beside a
    // list showing one of them is a number nothing on screen adds up to.
    const res = await readUnderEpoch<SummaryResponse>(
      withWorkspace("/v1/me/inbox/summary", activeWorkspaceId),
    );
    if (!res) return;
    setUnreadCount(res.unread);
    setCountIsExact(!res.hasTruncatedSources);
  }, [readUnderEpoch, activeWorkspaceId]);

  /**
   * The five most recent VISIBLE notifications — read and unread.
   *
   * `filter=all` and `sort=recent`, not `filter=unread`. The old query is why
   * marking something read made it vanish: the list was defined as the unread
   * set, so changing an item's read state removed it from the query's own
   * population. Dismissal is what removes a row; reading is a state it wears.
   *
   * The server orders and limits. Fetching read and unread separately and
   * merging here would be a second ordering authority living in a browser.
   *
   * NOTE the count is NOT taken from this response: `totalEstimate` counts the
   * whole visible population, which now includes read items, and the badge
   * counts unread. The summary endpoint owns that number.
   */
  const loadItems = useCallback(async () => {
    const res = await readUnderEpoch<RecentResponse>(
      withWorkspace(
        `/v1/me/inbox?filter=all&sort=recent&pageSize=${PREVIEW_SIZE}`,
        activeWorkspaceId,
      ),
    );
    if (!res) return;
    setItems(res.items);
  }, [readUnderEpoch, activeWorkspaceId]);

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
    /*
     * DO NOT COUNT BEFORE THE SCOPE IS KNOWN.
     *
     * `loadSummary` closes over `activeWorkspaceId`, so this effect used to
     * run once while the platform context was still loading — with no
     * workspace, which the server reads as "every workspace" — and then again
     * the moment the context arrived. Two requests in the most contended part
     * of the boot, and the first answer was thrown away by the second.
     *
     * It was also briefly WRONG in exactly the way the scoping comment on
     * `loadSummary` warns about: a badge counted across every workspace,
     * shown beside a list showing one of them.
     *
     * Once the context has resolved this behaves as it always did, including
     * when it resolves to no workspace at all.
     */
    if (!workspaceResolved) return;
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
  }, [loadSummary, workspaceResolved]);

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
          aria-label="Recent notifications"
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
                No recent notifications.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {items.map((it) => {
                  const workspace =
                    (it.context?.teamName as string | null) ??
                    (it.context?.organizationName as string | null) ??
                    null;
                  return (
                    <li
                      key={it.itemKey}
                      className="ops-bell-row"
                      /* ONE anatomy, two states. The row geometry is identical
                         either way, so reading an item cannot move anything
                         below it — only weight and ink change. */
                      data-notification-row-read={it.isRead ? "true" : "false"}
                    >
                      {/* The state, stated. Colour and weight alone cannot
                          carry it, so every row names its status in text that
                          is available to assistive technology. */}
                      <span className="app-visually-hidden">
                        {it.isRead ? "Read" : "Unread"}
                      </span>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span
                          aria-hidden="true"
                          className="ops-bell-row__dot"
                          data-tone={it.tone}
                          /* The unread marker. Absent when read — the dot is
                             the indicator, not a decoration. */
                          data-notification-unread-dot={it.isRead ? "false" : "true"}
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
                            {/* Offered only while it can do something. A
                                "Mark read" control on a read row is an action
                                whose outcome is already true. Dismiss stays,
                                because a read notification can still be
                                cleared from the list. */}
                            {it.isRead ? null : (
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
                            )}
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
            href="/notifications"
            onClick={() => setOpen(false)}
            className="ops-bell-footer"
          >
            View all notifications →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
