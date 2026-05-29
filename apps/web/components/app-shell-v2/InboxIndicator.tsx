"use client";

/**
 * Phase C2 — Topbar inbox/mention indicator.
 *
 * Bounded, operator-safe indicator surfacing the caller's unread
 * discussion mentions + open assigned discussion threads. Polls
 * `GET /v1/me/inbox/summary` on a slow interval so the badge updates
 * without hammering the API. Clicking the indicator deep-links to
 * `/inbox` where mentions + assignments live as full inbox rows.
 *
 * Hard rules:
 *   * No social-app spam — only the two operational counters from
 *     the inbox summary endpoint.
 *   * Bounded display — counts > 99 render as "99+".
 *   * Workspace-safe — the summary endpoint is server-scoped to
 *     caller's team memberships; no cross-workspace leak.
 *   * Read-only — the indicator never mutates; it only routes the
 *     operator to the existing audited surfaces.
 *   * No realtime sockets, no push notifications, no toast spam.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

import { apiFetch } from "../../lib/api";

type SummaryResponse = {
  generatedAt: string;
  unreadMentions: number;
  openAssignments: number;
};

// Slow poll: every 60 seconds. The full inbox page does its own
// fetch on mount + on user-driven refresh. Anything sub-minute is
// notification-spam, not operational coordination.
const POLL_INTERVAL_MS = 60_000;

function formatCount(n: number): string {
  if (n <= 0) return "0";
  if (n > 99) return "99+";
  return String(n);
}

export function InboxIndicator() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        // `apiFetch` already returns the parsed JSON body (see
        // `apps/web/lib/api.ts:233`). Calling `.json()` on the result
        // throws `TypeError: e.json is not a function`. Same bug as
        // the visible /inbox page; this indicator silently caught it
        // and rendered no badge.
        const data = (await apiFetch("/v1/me/inbox/summary")) as SummaryResponse;
        if (alive) {
          setSummary(data);
          setErrored(false);
        }
      } catch {
        // Best-effort. Don't surface errors in the topbar.
        if (alive) setErrored(true);
      }
      if (alive) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    void tick();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const unreadMentions = summary?.unreadMentions ?? 0;
  const openAssignments = summary?.openAssignments ?? 0;
  const total = unreadMentions + openAssignments;
  const has = total > 0;

  return (
    <Link
      href="/inbox"
      className="app-topbar-v2-inbox-indicator"
      data-app-topbar-inbox-indicator
      data-inbox-has-unread={has ? "true" : "false"}
      data-inbox-unread-mentions={unreadMentions}
      data-inbox-open-assignments={openAssignments}
      data-inbox-errored={errored ? "true" : "false"}
      aria-label={
        has
          ? `Inbox: ${formatCount(unreadMentions)} unread mentions, ${formatCount(openAssignments)} open assignments`
          : "Inbox"
      }
      title={
        has
          ? `${unreadMentions} unread mention${unreadMentions === 1 ? "" : "s"} · ${openAssignments} open assignment${openAssignments === 1 ? "" : "s"}`
          : "Inbox"
      }
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,0.25)",
        background: has ? "rgba(99,102,241,0.08)" : "transparent",
        color: "inherit",
      }}
    >
      <Bell size={16} strokeWidth={1.9} />
      {has ? (
        <span
          data-inbox-indicator-badge
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 18,
            height: 18,
            padding: "0 4px",
            borderRadius: 999,
            background: "#b91c1c",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid var(--app-topbar-bg, #fff)",
            lineHeight: 1,
          }}
        >
          {formatCount(total)}
        </span>
      ) : null}
    </Link>
  );
}
