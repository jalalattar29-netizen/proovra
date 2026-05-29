"use client";

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
 *   - Read state is INHERENT in source state — an item disappears
 *     when the underlying record is resolved (invite accepted /
 *     governance acknowledged / org joined). We do NOT introduce a
 *     separate read-receipt model.
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
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

type InboxTone = "info" | "warning" | "high" | "critical";
type InboxCategory =
  | "onboarding"
  | "org_invite"
  | "org_admin"
  | "governance"
  | "review_decision"
  // Phase C2 — operational evidence collaboration signals.
  | "discussion_mention"
  | "discussion_assigned";

type InboxItem = {
  id: string;
  category: InboxCategory;
  tone: InboxTone;
  title: string;
  body: string;
  href: string;
  occurredAt: string;
  context: Record<string, string | number | null>;
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
  };
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
  const [filter, setFilter] = useState<"all" | InboxTone>("all");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // `apiFetch` already returns the parsed JSON body (see
      // `apps/web/lib/api.ts:233`). Calling `.json()` on the result
      // throws `TypeError: e.json is not a function` in production
      // (the local variable is minified to `e`).
      const data = (await apiFetch("/v1/me/inbox")) as InboxEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        err instanceof Error ? err.message : "Could not load inbox.";
      setState({ kind: "error", status, message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleItems =
    state.kind === "ready"
      ? filter === "all"
        ? state.data.items
        : state.data.items.filter((i) => i.tone === filter)
      : [];

  return (
    <main
      style={{ padding: "1.5rem", maxWidth: 1000, margin: "0 auto" }}
      data-phase-c-inbox
      data-inbox-total={state.kind === "ready" ? state.data.summary.total : 0}
    >
      <header
        style={{
          marginBottom: "1.25rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            Account · Operational inbox
          </div>
          <h1 style={{ margin: "0.25rem 0 0.35rem" }}>Inbox</h1>
          <p style={{ margin: 0, opacity: 0.85, fontSize: 13.5, maxWidth: 720 }}>
            Operational items that require your attention. Each item is
            a real, unresolved backend signal — items disappear when
            the underlying state is resolved (invite accepted,
            governance event acknowledged, organization joined). No
            invented alerts.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void load()}
            disabled={state.kind === "loading"}
            data-action="refresh-inbox"
            style={toolbarBtn(false)}
          >
            {state.kind === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* ---------- summary strip ---------- */}
      {state.kind === "ready" && (
        <section
          data-inbox-summary
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            marginBottom: "1rem",
          }}
        >
          {(["critical", "high", "warning", "info"] as InboxTone[]).map(
            (tone) => {
              const count = state.data.summary.byTone[tone];
              const tStyle = TONE_STYLES[tone];
              const active = filter === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  onClick={() => setFilter(active ? "all" : tone)}
                  data-inbox-tone-tile={tone}
                  data-inbox-tone-tile-active={active ? "true" : "false"}
                  data-inbox-tone-tile-count={count}
                  style={{
                    padding: "0.6rem 0.8rem",
                    border: `1px solid ${tStyle.border}`,
                    background: active
                      ? tStyle.chipBg
                      : tStyle.background,
                    borderRadius: 8,
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
            onClick={() => setFilter("all")}
            data-inbox-tone-tile="all"
            data-inbox-tone-tile-active={filter === "all" ? "true" : "false"}
            data-inbox-tone-tile-count={state.data.summary.total}
            style={{
              padding: "0.6rem 0.8rem",
              border: "1px dashed rgba(127,127,127,0.4)",
              background:
                filter === "all"
                  ? "rgba(127,127,127,0.12)"
                  : "rgba(127,127,127,0.04)",
              borderRadius: 8,
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

      {/* ---------- list states ---------- */}
      {state.kind === "loading" && (
        <div data-state="loading" style={listLoadingStyle}>
          Loading inbox…
        </div>
      )}

      {state.kind === "error" && (
        <div data-state="error" role="alert" style={listErrorStyle}>
          <strong>Couldn’t load inbox.</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {state.status ? `HTTP ${state.status}: ` : ""}
            {state.message}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void load()}
              data-action="retry-inbox"
              style={toolbarBtn(false)}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {state.kind === "ready" &&
        state.data.summary.total === 0 && (
          <div
            data-state="empty"
            style={listEmptyStyle}
          >
            <strong>Nothing requires your attention right now.</strong>
            <p style={{ marginTop: 8, fontSize: 13 }}>
              When operational items appear — pending invites,
              governance events, admin governance signals — they show up
              here. Items disappear automatically when their underlying
              state resolves (accepted, acknowledged, etc.). No noisy
              read/unread counters.
            </p>
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
          </div>
        )}

      {state.kind === "ready" &&
        state.data.summary.total > 0 &&
        visibleItems.length === 0 && (
          <div
            data-state="filter-empty"
            style={listEmptyStyle}
          >
            No items in the <strong>{filter}</strong> tone right now.{" "}
            <button
              type="button"
              onClick={() => setFilter("all")}
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
          </div>
        )}

      {state.kind === "ready" && visibleItems.length > 0 && (
        <ul
          data-inbox-items
          data-inbox-visible-count={visibleItems.length}
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}
        >
          {visibleItems.map((item) => {
            const tStyle = TONE_STYLES[item.tone];
            return (
              <li
                key={item.id}
                data-inbox-item={item.id}
                data-inbox-item-category={item.category}
                data-inbox-item-tone={item.tone}
                style={{
                  padding: "0.7rem 0.9rem",
                  border: `1px solid ${tStyle.border}`,
                  background: tStyle.background,
                  borderRadius: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
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
                  <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 3 }}>
                    {item.body}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>
                    {new Date(item.occurredAt).toLocaleString()}
                  </div>
                </div>
                <Link
                  href={item.href}
                  data-action="open-inbox-item"
                  data-inbox-item-href={item.href}
                  style={cardLinkBtn(true)}
                >
                  Open
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- operational scope panel ---------- */}
      <section
        data-inbox-scope-panel
        style={{
          marginTop: 20,
          padding: "0.9rem 1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          background: "rgba(127,127,127,0.04)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            opacity: 0.7,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Operational scope
        </div>
        <p style={{ fontSize: 13, margin: "0 0 8px" }}>
          Honest summary of what the inbox surfaces today vs what is
          deliberately deferred to later backend work. Items marked
          “deferred” are not faked in the UI — the underlying signal
          either does not exist as a model, or its cross-workspace
          aggregation is not built.
        </p>
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
              <li data-inbox-scope-item="onboarding">
                <strong>Onboarding signals.</strong> No-organizations yet;
                no email identity bound.
              </li>
            </ul>
          </div>
          <div
            data-inbox-scope-block="deferred"
            style={scopeBlockStyle("deferred")}
          >
            <div style={scopeBlockTitle}>Deferred</div>
            <ul style={scopeListStyle}>
              <li data-inbox-scope-item="read-state">
                <strong>Read-state persistence.</strong> The inbox shows
                items that are unresolved on the backend; we do not track
                a separate per-user “seen” receipt yet. This is a
                deliberate “avoid infinite unread growth” choice.
              </li>
              <li data-inbox-scope-item="preferences-ui">
                <strong>Notification preferences UI.</strong> No
                NotificationPreference model is wired today. All operators
                receive all in-app inbox items their RBAC allows.
              </li>
              <li data-inbox-scope-item="email-digest">
                <strong>Email digests / push channels.</strong>{" "}
                Transactional email delivery exists for evidence-request
                and reviewer-assignment paths (the existing
                NotificationDelivery pipeline). Digest / push / SMS aren’t
                wired for inbox items.
              </li>
              <li data-inbox-scope-item="cross-workspace-reports">
                <strong>Cross-workspace failed reports.</strong> Failed
                report generation is visible per-workspace in /reports
                with a Retry CTA (Phase A.1D); a cross-workspace
                aggregation in the inbox is not built.
              </li>
              <li data-inbox-scope-item="cross-workspace-reviews">
                <strong>Cross-workspace reviewer assignments.</strong>{" "}
                Reviewer queues, escalations and SLAs are visible
                per-workspace at /reviewer-ops/* (Phase A.1D + B); a
                cross-workspace assignment view is not built.
              </li>
              <li data-inbox-scope-item="seat-overrun">
                <strong>Billing seat-overrun alerts.</strong> Per-workspace
                billing posture is visible to admins on the
                /organizations/[id] page (Phase A.1B); a seat-overrun
                inbox item is not built — backend has no incident model
                for it yet.
              </li>
              <li data-inbox-scope-item="dismiss">
                <strong>Dismiss-with-snooze.</strong> Items disappear when
                the underlying record resolves; there is no manual
                per-user dismiss yet.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------- shared styles ----------

function toolbarBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.4rem 0.8rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

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
        ? "1px solid rgba(34, 197, 94, 0.45)"
        : "1px solid rgba(127, 127, 127, 0.4)",
    background:
      kind === "available"
        ? "rgba(34, 197, 94, 0.06)"
        : "rgba(127, 127, 127, 0.04)",
    borderRadius: 6,
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

const listLoadingStyle: React.CSSProperties = {
  padding: "1rem",
  border: "1px dashed rgba(127,127,127,0.3)",
  borderRadius: 8,
  opacity: 0.75,
  fontSize: 13,
};

const listErrorStyle: React.CSSProperties = {
  padding: "1rem",
  border: "1px solid #d44",
  borderRadius: 8,
  background: "rgba(220,68,68,0.06)",
};

const listEmptyStyle: React.CSSProperties = {
  padding: "1.1rem",
  border: "1px dashed rgba(127,127,127,0.4)",
  borderRadius: 8,
  fontSize: 14,
};
