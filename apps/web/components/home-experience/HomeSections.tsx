/**
 * PROOVRA Home — operational command surface components.
 *
 * This is NOT a second sidebar. Every widget answers a practical work
 * question (what needs action, what's waiting, what failed, what's ready,
 * what's trustworthy, what changed) and is wired to a real view-model
 * slice. No static marketing copy, no fabricated values, no nav-duplicate
 * header CTAs. Inline actions are used where a real flow exists today
 * (failed-delivery retry); everything else deep-links to the working
 * route and is flagged as a navigation fallback in the view model.
 */

"use client";

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDate } from "../../lib/date";

import type {
  ActiveMatterRow,
  ActivityGroup,
  CaseHealthSummary,
  ChecklistStep,
  HeroAction,
  IntakePipeline,
  ReportProduction,
  StorageUsage,
  TeamWork,
  TrustState,
  VerificationHealth,
  WorkspaceHealthMetric,
} from "./home-view-model";
import {
  ANALYTICS_PALETTE,
  HOME_COLORS,
  HOME_SEMANTIC,
  HOME_TINTS,
  homeCardCtaStyle,
  homeCardHeaderStyle,
  homeCardTitleStyle,
  homeChipStyle,
  homeOpsRowStyle,
  homeOuterCardStyle,
  homeSecondaryButtonStyle,
  infoBadgeStyle,
  successBadgeStyle,
  toneColor,
  type HomeTone,
} from "./home-theme";

// ============================================================================
// Local visual helpers (Phase HOME-DENSITY — pure presentational)
// ============================================================================

/** Cap for how many list rows any Home module renders by default. Purely a
 * RENDER cap — the underlying data/counts are untouched (summary tiles and
 * "view all" footers still reflect the full totals). */
const HOME_PREVIEW_LIMIT = 3;

/** MIDDLE-truncate a long identifier / UUID so BOTH the start and end stay
 * legible (e.g. `dd440009-5606-4a44-…-1792a3780fe0`). The full id is always
 * available via a `title=` tooltip and to assistive tech on the row. Purely
 * presentational — keys, hrefs and testids still use the full id. */
function middleTruncate(id: string, head = 18, tail = 8): string {
  if (!id) return id;
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Shared action-link colour for every "Open verify → / Open reports →
 * / View pipeline → / View all links →" affordance across the Operations
 * cards, with a subtle hover — one consistent accent, never per-card. */
function OpsActionLink({
  href,
  external,
  children,
  extraProps,
  style,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
  extraProps?: Record<string, unknown>;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const merged: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 650,
    // ONE action blue. This was HOME_ACCENT.ink (#6D28D9), so every
    // "Open verify" / "Open reports" / "View intake" on Home was violet while
    // the same affordance on Notifications and Search is blue.
    color: HOME_COLORS.action,
    textDecoration: hover ? "underline" : "none",
    whiteSpace: "nowrap",
    ...style,
  };
  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };
  if (external) {
    return (
      <a href={href} style={merged} {...handlers} {...extraProps}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} style={merged} {...handlers} {...extraProps}>
      {children}
    </Link>
  );
}

/** Equal-height Operations card: SectionCard content laid out as a flex
 * column that fills 100% of a stretched grid cell so all four cards align
 * their headings, summary blocks and bottom edges. Applied via SectionCard's
 * `fill` prop. */
const opsCardFillStyle: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
};

/** Subtle inner-row surface used when an outer card wrapper is made
 * transparent so rows integrate with the page background. */
const innerRowSurfaceStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.64)",
  border: "1px solid rgba(15, 23, 42, 0.05)",
};

// PHASE 4C (2026-08-22) — `HomeSecondaryLink` removed with the operational
// queue, which was its only caller. The queue was built from the caller's
// own notification feed and rendered as workspace state; see
// home-view-model.ts for why that had to go.

// ============================================================================
// Shared primitives
// ============================================================================

function SectionCard({
  title,
  cta,
  children,
  testId,
  fill,
}: {
  title: string;
  cta?: { label: string; href: string } | null;
  children: ReactNode;
  testId?: string;
  /** Equal-height mode: the card fills its stretched grid cell (height:100%)
   * and lays its body out as a growing flex column so siblings align. */
  fill?: boolean;
}) {
  return (
    <section
      className="home-card"
      data-self-serve-section={testId}
      style={fill ? { ...outerCardStyle, ...opsCardFillStyle } : outerCardStyle}
    >
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>{title}</h2>
        {cta ? (
          <Link href={cta.href} style={cardCtaStyle}>
            {cta.label} →
          </Link>
        ) : null}
      </header>
      <div style={fill ? { ...cardBodyStyle, flex: 1, display: "flex", flexDirection: "column" } : cardBodyStyle}>
        {children}
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, padding: "12px 0", color: "#5d6d71", fontSize: 13, lineHeight: 1.6 }}>
      {children}
    </p>
  );
}

/** Future-facing variant for expiry labels ("in 3d", "in 5h"). */
function formatRelativeFuture(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const minutes = Math.round((t - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `in ${days}d`;
  return formatUserDate(new Date(t));
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatUserDate(new Date(t));
}

// ============================================================================
// Hero (the single onboarding/caught-up primary — used by the queue when
// there is no actionable work).
// ============================================================================

export function HeroNextAction({ action }: { action: HeroAction }) {
  const caughtUp = action.kind === "caught_up";
  const bg = caughtUp
    ? "linear-gradient(145deg, rgba(5,150,105,0.08) 0%, rgba(14,116,144,0.05) 100%)"
    : action.tone === "warn"
      ? "#fffaf0"
      : action.tone === "action"
        ? "linear-gradient(145deg, rgba(79,70,229,0.07) 0%, rgba(109,40,217,0.04) 100%)"
        : HOME_COLORS.soft;
  const border = caughtUp
    ? "rgba(5,150,105,0.22)"
    : action.tone === "warn"
      ? "rgba(217,119,6,0.28)"
      : action.tone === "action"
        ? "rgba(79,70,229,0.22)"
        : HOME_COLORS.cardBorder;
  return (
    <div
      data-hero-kind={action.kind}
      style={{ background: bg, border: `1px solid ${border}`, borderRadius: 14, padding: 20 }}
    >
      <div style={{ fontSize: 11, fontWeight: 750, letterSpacing: 0.6, color: caughtUp ? HOME_COLORS.okDeep : HOME_COLORS.slate, textTransform: "uppercase" }}>
        {caughtUp ? "All clear" : "Next step"}
      </div>
      <h1 style={{ margin: "8px 0 6px 0", fontSize: 20, fontWeight: 720, color: HOME_COLORS.ink }}>
        {action.title}
      </h1>
      <p style={{ margin: "0 0 14px 0", fontSize: 14, color: HOME_COLORS.slate, lineHeight: 1.5 }}>
        {action.detail}
      </p>
      <Link href={action.href} data-hero-href={action.href} style={primaryButtonStyle}>
        {action.ctaLabel}
      </Link>
    </div>
  );
}

// ============================================================================
// 1. OPERATIONAL QUEUE — REMOVED (Attention Architecture Phase 4C, 2026-08-22)
// ============================================================================
//
// `OperationalQueue`, `QueueRow` and `severityStyle` rendered the queue that
// `buildOperationalQueue()` produced from the caller's own notification feed.
// Home presented that as the WORKSPACE's operational state, so one person
// archiving a message lowered a shared number and two admins saw two
// different healths over identical work.
//
// The queue authority is gone (see home-view-model.ts), and these had zero
// remaining consumers — verified by search across apps/web before removal.
// Home now consumes `GET /v1/ops/summary` and LINKS to /operations; it does
// not render a second work surface, because a cockpit that is also a queue is
// how the two authorities grow back.

// ============================================================================
// Inline failed-delivery retry — the one real inline mutation flow today.
// POSTs to the communications retry endpoint; degrades to the delivery
// drawer on any error (e.g. permission) rather than dead-ending.
// ============================================================================

function RetryDeliveryButton({
  messageId,
  workspaceId,
  fallbackHref,
  onRetried,
}: {
  messageId: string;
  workspaceId: string | null;
  fallbackHref: string;
  onRetried?: () => void;
}) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");

  async function retry() {
    if (!workspaceId || state === "pending" || state === "done") return;
    setState("pending");
    try {
      await apiFetch(`/v1/communications/messages/${encodeURIComponent(messageId)}/retry`, {
        method: "POST",
        body: JSON.stringify({ teamId: workspaceId }),
      });
      setState("done");
      onRetried?.();
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return <span data-delivery-retry="done" style={{ ...chipStyle, background: "#dcfce7", color: "#166534" }}>Retry scheduled</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        type="button"
        onClick={retry}
        disabled={state === "pending"}
        data-delivery-retry={state}
        style={{
          ...secondaryButtonStyle,
          cursor: state === "pending" ? "default" : "pointer",
          opacity: state === "pending" ? 0.6 : 1,
          borderColor: "#fca5a5",
          color: "#991b1b",
        }}
      >
        {state === "pending" ? "Retrying…" : "Retry delivery"}
      </button>
      {state === "error" ? (
        <Link href={fallbackHref} style={{ ...listItemTimeStyle, color: "#6D28D9", fontWeight: 600 }} data-delivery-retry-fallback>
          Open delivery →
        </Link>
      ) : null}
    </span>
  );
}

// ============================================================================
// 2. ACTIVE MATTERS — the work-centric matter portfolio.
// ============================================================================

export function ActiveMatters({
  rows,
  summary,
}: {
  rows: ActiveMatterRow[];
  summary: CaseHealthSummary;
}) {
  const showBadges =
    summary.gapsCount > 0 ||
    summary.blockersCount > 0 ||
    summary.unlinkedCount > 0 ||
    summary.unreviewedCount > 0;
  return (
    <SectionCard title="Active matters" testId="active-matters">
      {showBadges ? (
        <div data-case-health-summary style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {summary.gapsCount > 0 ? (
            <span data-case-gaps={summary.gapsCount} style={{ ...chipStyle, background: "#fef3c7", color: "#92400e" }}>
              {summary.gapsCount} with evidence gaps
            </span>
          ) : null}
          {summary.blockersCount > 0 ? (
            <span data-case-blockers={summary.blockersCount} style={{ ...chipStyle, background: "#fee2e2", color: "#991b1b" }}>
              {summary.blockersCount} blocked
            </span>
          ) : null}
          {/* Ticket 3A — workspace-level record counters (hidden at 0). */}
          {summary.unlinkedCount > 0 ? (
            <span data-case-unlinked={summary.unlinkedCount} style={{ ...chipStyle, background: "rgba(79,70,229,0.08)", color: "#4338ca" }}>
              {summary.unlinkedCount} unlinked record{summary.unlinkedCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {summary.unreviewedCount > 0 ? (
            <span data-case-unreviewed={summary.unreviewedCount} style={{ ...chipStyle, background: "#fef3c7", color: "#92400e" }}>
              {summary.unreviewedCount} not reviewed
            </span>
          ) : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div>
          <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
            No active matters yet. Group related evidence into a case to track a matter end-to-end.
          </p>
          <Link
            href="/cases"
            data-case-cta="create-case"
            style={{ ...secondaryButtonStyle, marginTop: 12, background: "#0f172a", color: "white", border: "1px solid #0f172a" }}
          >
            Create case
          </Link>
        </div>
      ) : (
        <ul style={listStyle}>
          {rows.slice(0, HOME_PREVIEW_LIMIT).map((r) => {
            // Phase HOME-INTELLIGENCE — verdict chip: Action required /
            // Needs work / Healthy, plus a report-readiness chip from
            // /v1/reports caseIds.
            const verdictChip =
              r.verdict === "action_required"
                ? { label: "Action required", bg: "#fee2e2", fg: "#991b1b" }
                : r.verdict === "needs_work"
                  ? { label: "Needs work", bg: "#fef3c7", fg: "#92400e" }
                  : { label: "Healthy", bg: "#dcfce7", fg: "#166534" };
            return (
              <li key={r.caseId} data-matter-id={r.caseId} data-matter-verdict={r.verdict} data-matter-needs-work={String(r.needsWork)} style={listItemStyle}>
                <Link href={r.href} style={{ ...listItemLinkStyle, ...innerRowSurfaceStyle }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <span style={listItemTitleStyle}>{r.caseName}</span>
                    <span style={listItemTimeStyle}>{formatRelative(r.lastActivityAtUtc)}</span>
                  </div>
                  <span style={listItemMetaStyle}>
                    <span style={{ ...chipStyle, background: verdictChip.bg, color: verdictChip.fg }}>
                      {verdictChip.label}
                    </span>
                    {r.statusLabel !== "On track" ? (
                      <span style={{ ...chipStyle, background: "rgba(15,23,42,0.04)", color: HOME_COLORS.slate }}>
                        {r.statusLabel}
                      </span>
                    ) : null}
                    {/* Phase HOME-DECISIONS — deliverable chain: records
                        with reports / packages / live verify pages. */}
                    {r.evidenceCount > 0 ? (
                      <span
                        data-matter-chain
                        data-matter-verification-status={r.verificationStatus}
                        {...(r.hasReport ? { "data-matter-has-report": true } : {})}
                        style={{ ...chipStyle, background: HOME_TINTS.teal, color: HOME_COLORS.teal, fontVariantNumeric: "tabular-nums" }}
                        title={`${r.evidenceCount} records · ${r.reportsReadyCount} with reports (${Math.max(0, r.evidenceCount - r.reportsReadyCount)} without) · ${r.packagesReadyCount} with packages · ${r.verifyLiveCount} verifiable`}
                      >
                        E {r.evidenceCount} · R {r.reportsReadyCount} · P {r.packagesReadyCount} · V {r.verifyLiveCount}
                      </span>
                    ) : null}
                    {r.hasActiveLegalHold ? <span style={chipStyle}>Legal hold</span> : null}
                    <span style={listItemTimeStyle}>
                      {r.evidenceCount} {r.evidenceCount === 1 ? "record" : "records"}
                    </span>
                  </span>
                  <span
                    style={{
                      marginTop: 8,
                      display: "inline-flex",
                      fontSize: 12,
                      fontWeight: 650,
                      color: HOME_COLORS.action,
                    }}
                  >
                    Open matter →
                  </span>
                </Link>
              </li>
            );
          })}
          {rows.length > HOME_PREVIEW_LIMIT ? (
            <li style={listItemStyle}>
              <Link
                href="/cases"
                data-matter-view-all={rows.length}
                style={{ display: "inline-block", marginTop: 4, fontSize: 12, fontWeight: 600, color: HOME_COLORS.action, textDecoration: "none" }}
              >
                View all {rows.length} →
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 3. INTAKE PIPELINE — the collection lifecycle, not a link count.
// ============================================================================

// Phase HOME-POLISH — stage tiles are coloured ONLY by count: a positive
// "active/ok" stage reads success green, a positive "warn" stage reads amber,
// a positive "danger" stage reads restrained critical; every 0-count stage
// stays quiet neutral (a zero stage never looks active). Labels render in
// FULL (two lines allowed) inside a 3-column × 2-row grid — never clipped.
function StageTile({ label, count, tone }: { label: string; count: number; tone: string }) {
  const active = count > 0;
  // "Active links" is the positive / live intake stage — when it has a live
  // count it must read in the SHARED enterprise success green (same token as
  // "verification pages live" / "Reports ready" / Live badges), not neutral.
  // Every other stage keeps its data-driven tone (amber for awaiting, quiet
  // neutral for delivered/pending/failed/zero — zeros never green).
  const effectiveTone = active && label === "Active links" ? "ok" : tone;
  const sem =
    !active
      ? { fg: HOME_SEMANTIC.neutral.numberInk, bg: HOME_SEMANTIC.neutral.softBg, border: HOME_SEMANTIC.neutral.border }
      : effectiveTone === "danger"
        ? { fg: HOME_SEMANTIC.critical.strong, bg: HOME_SEMANTIC.critical.softBg, border: HOME_SEMANTIC.critical.border }
        : effectiveTone === "warn"
          ? { fg: HOME_SEMANTIC.amber.strong, bg: HOME_SEMANTIC.amber.softBg, border: HOME_SEMANTIC.amber.border }
          : effectiveTone === "ok"
            ? { fg: HOME_SEMANTIC.success.strong, bg: HOME_SEMANTIC.success.softBg, border: HOME_SEMANTIC.success.border }
            : { fg: HOME_SEMANTIC.neutral.numberInk, bg: HOME_SEMANTIC.neutral.softBg, border: HOME_SEMANTIC.neutral.border };
  return (
    <div
      data-intake-stage={label}
      style={{
        minWidth: 0,
        padding: "8px 8px",
        borderRadius: 10,
        background: sem.bg,
        border: `1px solid ${sem.border}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 2,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: sem.fg, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{count}</div>
      <div style={{ fontSize: 10.5, color: active ? sem.fg : HOME_SEMANTIC.neutral.secondary, lineHeight: 1.25, wordBreak: "break-word" }}>{label}</div>
    </div>
  );
}

export function IntakePipelineCard({
  pipeline,
  workspaceId,
  onChanged,
  locked,
}: {
  pipeline: IntakePipeline;
  workspaceId: string | null;
  onChanged?: () => void;
  locked?: boolean;
}) {
  if (locked) {
    return (
      <SectionCard title="Intake status" testId="intake-pipeline" fill>
        <div data-intake-locked>
          <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
            Request evidence securely from a client, witness, source, or contributor — with delivery
            tracking and a review queue. Available on Pro and Team.
          </p>
          <Link
            href="/billing"
            data-intake-upgrade
            style={{ ...secondaryButtonStyle, marginTop: 12, background: "#0f172a", color: "white", border: "1px solid #0f172a" }}
          >
            See plans
          </Link>
        </div>
      </SectionCard>
    );
  }
  if (pipeline.empty) {
    return (
      <SectionCard title="Intake status" testId="intake-pipeline" fill>
        <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          Request evidence securely from a client, witness, source, or contributor — then track
          delivery and review what comes back.
        </p>
        <Link
          href="/intake-links?new=1"
          data-collection-cta="create-intake-link"
          style={{ ...secondaryButtonStyle, marginTop: 12, background: "#0f172a", color: "white", border: "1px solid #0f172a" }}
        >
          Create intake link
        </Link>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Intake status" testId="intake-pipeline" fill>
      {/* Lifecycle visual — every count a real number. A 3-column × 2-row
          tile grid so every stage label stays FULLY readable (no clipping);
          colour is driven by count only (see StageTile). */}
      <div
        data-intake-stages
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 6,
          marginBottom: 12,
        }}
      >
        {pipeline.stages.map((st) => (
          <StageTile key={st.key} label={st.label} count={st.count} tone={st.tone} />
        ))}
      </div>
      {pipeline.links.length > 0 ? (
        <ul style={{ ...listStyle, marginTop: "auto" }}>
          {/* Phase HOME-DENSITY — cap to 3 rows; the stage counts above
              reflect the full pipeline. */}
          {pipeline.links.slice(0, HOME_PREVIEW_LIMIT).map((r) => {
            const failed = r.delivery?.failed === true;
            return (
              <li key={r.id} data-collection-id={r.id} style={{ ...listItemStyle, ...listItemLinkStyle, ...homeOpsRowStyle }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span style={{ ...listItemTitleStyle, minWidth: 0 }} title={r.label}>{r.label}</span>
                  <span style={{ ...listItemTimeStyle, whiteSpace: "nowrap", flexShrink: 0 }}>
                    {r.usedCount}
                    {r.maxUses != null ? ` / ${r.maxUses}` : ""} used
                    {/* Ticket 4 — expiresAtUtc was mapped but never
                        rendered; useful intake metadata. */}
                    {r.expiresAtUtc ? (
                      <span data-link-expires={r.expiresAtUtc}> · expires {formatRelativeFuture(r.expiresAtUtc)}</span>
                    ) : null}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  {r.delivery ? (
                    <span
                      data-delivery-status={r.delivery.status}
                      style={
                        failed
                          ? { ...homeChipStyle, background: HOME_SEMANTIC.critical.softBg, color: HOME_SEMANTIC.critical.strong, border: `1px solid ${HOME_SEMANTIC.critical.border}` }
                          : r.delivery.statusLabel === "Delivered"
                            ? successBadgeStyle
                            : { ...homeChipStyle, background: HOME_SEMANTIC.info.softBg, color: HOME_SEMANTIC.info.strong, border: `1px solid ${HOME_SEMANTIC.info.border}` }
                      }
                    >
                      {r.delivery.channel} · {r.delivery.statusLabel}
                      {/* Ticket 4 — delivery.at was mapped but never
                          rendered; shows when the last attempt happened. */}
                      {r.delivery.at ? ` · ${formatRelative(r.delivery.at)}` : ""}
                    </span>
                  ) : (
                    <span style={{ ...homeChipStyle, background: HOME_SEMANTIC.neutral.softBg, color: HOME_SEMANTIC.neutral.secondary, border: `1px solid ${HOME_SEMANTIC.neutral.border}` }}>Not yet sent</span>
                  )}
                  {failed && r.delivery ? (
                    <RetryDeliveryButton
                      messageId={r.delivery.messageId}
                      workspaceId={workspaceId}
                      fallbackHref={r.href}
                      onRetried={onChanged}
                    />
                  ) : (
                    <OpsActionLink href={r.href} style={{ marginLeft: "auto" }}>
                      Open →
                    </OpsActionLink>
                  )}
                </div>
              </li>
            );
          })}
          {pipeline.links.length > HOME_PREVIEW_LIMIT ? (
            <li style={listItemStyle}>
              <OpsActionLink
                href="/intake-links"
                extraProps={{ "data-collection-view-all": pipeline.links.length }}
                style={{ display: "inline-block", marginTop: 4 }}
              >
                View intake →
              </OpsActionLink>
            </li>
          ) : null}
        </ul>
      ) : null}
    </SectionCard>
  );
}

// ============================================================================
// 4. REPORT PRODUCTION — ready / pending / failed deliverable status.
// ============================================================================

// Phase HOME-POLISH — a summary tile coloured by count using the unified
// semantic system: a positive "ok" tile reads success green, a positive
// "warn" tile reads amber; a "danger"/zero tile stays restrained neutral so
// "0 Failed" never dominates the card in red.
function ProductionStat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" | "ok" }) {
  const active = value > 0;
  const sem =
    active && tone === "ok"
      ? { fg: HOME_SEMANTIC.success.strong, bg: HOME_SEMANTIC.success.softBg, border: HOME_SEMANTIC.success.border, num: HOME_SEMANTIC.success.strong }
      : active && tone === "warn"
        ? { fg: HOME_SEMANTIC.amber.strong, bg: HOME_SEMANTIC.amber.softBg, border: HOME_SEMANTIC.amber.border, num: HOME_SEMANTIC.amber.strong }
        : active && tone === "danger"
          ? { fg: HOME_SEMANTIC.critical.strong, bg: HOME_SEMANTIC.critical.softBg, border: HOME_SEMANTIC.critical.border, num: HOME_SEMANTIC.critical.strong }
          : { fg: HOME_SEMANTIC.neutral.secondary, bg: HOME_SEMANTIC.neutral.softBg, border: HOME_SEMANTIC.neutral.border, num: HOME_SEMANTIC.neutral.numberInk };
  return (
    <div
      data-report-stat={label}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        padding: "8px 8px",
        borderRadius: 10,
        background: sem.bg,
        border: `1px solid ${sem.border}`,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: sem.num, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: sem.fg, lineHeight: 1.2 }}>{label}</div>
    </div>
  );
}

export function ReportProductionCard({
  production,
  isFreePlan,
}: {
  production: ReportProduction;
  isFreePlan: boolean;
}) {
  const emptyCopy = isFreePlan
    ? "Reports are included with Pay-Per-Evidence, Pro, and Team."
    : "Complete an evidence record to generate your first report.";
  const hasAny =
    production.reportsReady + production.packagesReady + production.reportsPending + production.packagesPending + production.reportsFailed + production.packagesFailed > 0 ||
    production.recent.length > 0;
  // Phase IA-home-findings — the generic "Open reports" header CTA was
  // removed: it only navigated to the bare /reports route, duplicating the
  // sidebar. Report actions remain available contextually (row/stat level)
  // and via the sidebar.
  return (
    <SectionCard title="Report production" testId="report-production" fill>
      <div data-report-production-stats style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <ProductionStat label="Reports ready" value={production.reportsReady} tone="ok" />
        <ProductionStat label="Packages ready" value={production.packagesReady} tone="ok" />
        <ProductionStat label="Pending" value={production.reportsPending + production.packagesPending} tone="warn" />
        <ProductionStat label="Failed" value={production.reportsFailed + production.packagesFailed} tone="danger" />
      </div>
      {/* Phase HOME-INTELLIGENCE — deliverable issues that need the
          user (failures, package gaps, unpublished verification). */}
      {production.needsAction.length > 0 ? (
        <ul data-report-needs-action style={{ ...listStyle, marginBottom: 10, gap: 5 }}>
          {production.needsAction.map((i) => {
            const c = toneColor(i.tone === "action" ? "neutral" : i.tone);
            return (
              <li key={i.key} data-report-issue={i.key} style={{ ...listItemStyle, display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, background: c.bg }}>
                <span style={{ flex: 1, fontSize: 12.5, color: c.fg, fontWeight: 600 }}>
                  {i.count} · {i.label}
                </span>
                <Link href={i.href} style={{ fontSize: 12, fontWeight: 650, color: HOME_COLORS.action, textDecoration: "none" }}>
                  {i.actionLabel} →
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!hasAny ? (
        <EmptyState>{emptyCopy}</EmptyState>
      ) : production.recent.length === 0 ? (
        <EmptyState>No reports generated yet — the counts above update as production runs.</EmptyState>
      ) : (
        <>
          {/* Phase HOME-DENSITY — cap to 3 preview items; the counts above
              already reflect the full totals. */}
          <ul style={{ ...listStyle, marginTop: "auto" }}>
            {production.recent.slice(0, HOME_PREVIEW_LIMIT).map((r) => {
              const hasTitle = Boolean(r.evidenceTitle && r.evidenceTitle !== r.evidenceId);
              const displayLabel = hasTitle ? (r.evidenceTitle as string) : middleTruncate(r.evidenceId);
              return (
                <li key={r.evidenceId} style={{ ...listItemStyle, padding: "8px 10px", borderRadius: 8, ...homeOpsRowStyle }} data-report-evidence-id={r.evidenceId}>
                  <Link
                    href={r.actions.open}
                    style={{ ...listItemTitleStyle, minWidth: 0, textDecoration: "none", fontFamily: hasTitle ? undefined : "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                    title={r.evidenceId}
                    data-report-action="open"
                  >
                    {displayLabel}
                  </Link>
                  <span style={listItemMetaStyle}>
                    <span style={infoBadgeStyle}>Report{r.version != null ? ` v${r.version}` : ""}</span>
                    {r.packageReady ? (
                      <span style={successBadgeStyle}>Package ready</span>
                    ) : (
                      <span style={{ ...homeChipStyle, background: HOME_SEMANTIC.neutral.softBg, color: HOME_SEMANTIC.neutral.secondary, border: `1px solid ${HOME_SEMANTIC.neutral.border}` }}>
                        No package
                      </span>
                    )}
                    <span style={listItemTimeStyle}>{formatRelative(r.generatedAtUtc)}</span>
                  </span>
                  <ReportRowActions row={r} />
                </li>
              );
            })}
          </ul>
          {production.recent.length > HOME_PREVIEW_LIMIT ? (
            <OpsActionLink
              href="/reports"
              extraProps={{ "data-report-view-all": production.recent.length }}
              style={{ display: "inline-block", marginTop: 8 }}
            >
              Open reports →
            </OpsActionLink>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

/**
 * Phase HOME-PROOF — Download PDF/Package action row.
 *
 * The earlier implementation rendered the API URLs (e.g.
 * `/v1/evidence/:id/report/latest`) as plain <a href> targets, which
 * meant the browser navigated directly to the API host with no
 * Authorization header → 404. The Reports page solves this by calling
 * `apiFetch` and opening the returned presigned URL in a new tab; we
 * use the exact same flow here so Home and the Reports page share one
 * authoritative download path.
 */
function ReportRowActions({ row }: { row: import("./home-view-model").RecentReportRow }) {
  const [busy, setBusy] = useState<"pdf" | "package" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  async function trigger(kind: "pdf" | "package", path: string) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const resp = (await apiFetch(path, { method: "GET" })) as
        | { url?: string; code?: string; message?: string }
        | null;
      if (resp?.url) {
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else if (resp?.code === "verification_package_pending") {
        setError("Package is still generating.");
      } else {
        setError(kind === "pdf" ? "Report URL is unavailable." : "Package URL is unavailable.");
      }
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      if (err.statusCode === 202) {
        setError(kind === "pdf" ? "Report is still generating." : "Package is still generating.");
      } else if (err.statusCode === 403) {
        setError("You don't have permission to download this.");
      } else if (err.statusCode === 409) {
        setError(toSafeUserError(err, { message: "Download blocked by workspace policy." }).message);
      } else if (err.statusCode === 404) {
        setError("File not found.");
      } else {
        setError(toSafeUserError(err, { message: "Could not start download." }).message);
      }
    } finally {
      setBusy(null);
    }
  }

  const pdfPath = row.actions.reportPdfApiPath;
  const pkgPath = row.actions.packageZipApiPath;
  const hasOverflow = Boolean(pdfPath || pkgPath || row.actions.verify);

  // Phase HOME-DENSITY — one primary "Open" action stays inline; the
  // secondary download/verify actions collapse into a compact "⋯" overflow
  // menu so the row is no longer four side-by-side buttons. Every href,
  // onClick and data-testid is preserved, just relocated.
  const overflowItemStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    color: HOME_COLORS.ink,
    fontSize: 12.5,
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }} data-report-actions>
        <Link href={row.actions.open} style={secondaryButtonStyle} data-report-action="open-evidence">
          Open
        </Link>
        {hasOverflow ? (
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
              data-report-overflow-toggle={String(menuOpen)}
              style={{
                ...secondaryButtonStyle,
                padding: "5px 10px",
                lineHeight: 1,
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              ⋯
            </button>
            {menuOpen ? (
              <div
                role="menu"
                data-report-overflow-menu
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 20,
                  minWidth: 168,
                  padding: "4px 0",
                  background: "#fff",
                  border: "1px solid rgba(15,23,42,0.10)",
                  borderRadius: 10,
                  boxShadow: "0 12px 32px rgba(15,23,42,0.14)",
                  overflow: "hidden",
                }}
              >
                {pdfPath ? (
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuOpen(false);
                      void trigger("pdf", pdfPath);
                    }}
                    disabled={busy !== null}
                    style={{ ...overflowItemStyle, cursor: busy ? "wait" : "pointer" }}
                    data-report-action="download-pdf"
                  >
                    {busy === "pdf" ? "Opening…" : "Download PDF"}
                  </button>
                ) : null}
                {pkgPath ? (
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuOpen(false);
                      void trigger("package", pkgPath);
                    }}
                    disabled={busy !== null}
                    style={{ ...overflowItemStyle, cursor: busy ? "wait" : "pointer" }}
                    data-report-action="download-package"
                  >
                    {busy === "package" ? "Opening…" : "Download package"}
                  </button>
                ) : null}
                {row.actions.verify ? (
                  <a
                    href={row.actions.verify}
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setMenuOpen(false)}
                    style={overflowItemStyle}
                    data-report-action="open-verify"
                  >
                    Verify page
                  </a>
                ) : null}
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
      {error ? (
        <div data-report-action-error style={{ marginTop: 6, fontSize: 12, color: "#991b1b" }}>
          {error}
        </div>
      ) : null}
    </>
  );
}

// ============================================================================
// 5. VERIFICATION HEALTH — can others verify my evidence?
// ============================================================================

// Phase HOME-POLISH — the "Not published" / "Suspended" tiles stay QUIET
// NEUTRAL: a zero (or non-live) value is never coloured green or loud red on
// this card; only the live count (rendered as the hero tile) earns success.
function VerifyStat({ label, value }: { label: string; value: number; tone?: "danger" | "ok" }) {
  return (
    <div
      data-verify-stat={label}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        padding: "8px 8px",
        borderRadius: 10,
        background: HOME_SEMANTIC.neutral.softBg,
        border: `1px solid ${HOME_SEMANTIC.neutral.border}`,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: HOME_SEMANTIC.neutral.numberInk, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: HOME_SEMANTIC.neutral.secondary, lineHeight: 1.2 }}>{label}</div>
    </div>
  );
}

export function VerificationHealthCard({ health }: { health: VerificationHealth }) {
  const liveActive = health.live > 0;
  return (
    <SectionCard title="Public verification links" testId="verification-health" fill>
      {health.empty ? (
        <p data-verify-empty style={{ margin: "0 0 10px 0", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          Public verification links appear once you publish a record — letting anyone independently
          confirm your evidence.
        </p>
      ) : null}
      {/* Phase HOME-POLISH — Live verification is PROOVRA's public face: it
          gets the hero treatment in the UNIFIED success green (only when live
          > 0; a zero count stays neutral, never green). */}
      <div data-verify-stats style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div
          data-verify-stat="Live"
          style={{
            flex: "1.4 1 0",
            minWidth: 0,
            padding: "10px 12px",
            borderRadius: 12,
            background: liveActive ? HOME_SEMANTIC.success.softBg : HOME_SEMANTIC.neutral.softBg,
            border: `1px solid ${liveActive ? HOME_SEMANTIC.success.border : HOME_SEMANTIC.neutral.border}`,
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 780, color: liveActive ? HOME_SEMANTIC.success.strong : HOME_SEMANTIC.neutral.numberInk, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {health.live}
          </div>
          <div style={{ fontSize: 11, color: "#526071", marginTop: 4 }}>
            verification page{health.live === 1 ? "" : "s"} live
          </div>
        </div>
        <VerifyStat label="Not published" value={health.unpublished} />
        <VerifyStat label="Suspended" value={health.suspended} />
      </div>
      {health.unpublished > 0 ? (
        <Link
          href="/evidence"
          data-verify-publish
          style={{ ...secondaryButtonStyle, marginTop: 10, background: "#6D28D9", color: "white", border: "1px solid #6D28D9" }}
        >
          Publish verification
        </Link>
      ) : null}
      {/* Phase HOME-DECISIONS — recently published verification pages
          (real publish timestamps from the timeline projection). */}
      {health.recentPublications.length > 0 ? (
        <div data-verify-recent-publications style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: HOME_COLORS.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
            Recently published
          </div>
          <ul style={{ ...listStyle, gap: 4 }}>
            {health.recentPublications.map((pub) => (
              <li key={pub.href + pub.occurredAt} style={{ ...listItemStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: HOME_SEMANTIC.success.subtleBg }}>
                <Link href={pub.href} style={{ ...listItemTitleStyle, minWidth: 0, textDecoration: "none", color: HOME_SEMANTIC.success.text, fontSize: 12.5 }} title={pub.label}>
                  {pub.label}
                </Link>
                <span style={{ ...listItemTimeStyle, flexShrink: 0 }}>{formatRelative(pub.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Phase HOME-DENSITY — cap to 3 verify rows; each row is a compact
          shortened id + status + "Open verify →" instead of a wall of raw
          UUIDs. The full list stays one click away via "View all". */}
      {health.verifiable.length > 0 ? (
        <div style={{ marginTop: "auto" }}>
          <ul style={{ ...listStyle, marginTop: 10, gap: 4 }}>
            {health.verifiable.slice(0, HOME_PREVIEW_LIMIT).map((v) => {
              const hasTitle = Boolean(v.title && v.title !== v.evidenceId);
              const displayLabel = hasTitle ? (v.title as string) : middleTruncate(v.evidenceId);
              return (
                <li
                  key={v.evidenceId}
                  data-verifiable-id={v.evidenceId}
                  style={{
                    ...listItemStyle,
                    padding: "6px 8px",
                    borderRadius: 8,
                    ...homeOpsRowStyle,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span
                      style={{ ...listItemTitleStyle, minWidth: 0, fontFamily: hasTitle ? undefined : "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                      title={v.evidenceId}
                    >
                      {displayLabel}
                    </span>
                    <span style={{ ...successBadgeStyle, flexShrink: 0 }}>Live</span>
                  </span>
                  <OpsActionLink href={v.verifyHref} external extraProps={{ "data-verify-open": true }} style={{ flexShrink: 0 }}>
                    Open verify →
                  </OpsActionLink>
                </li>
              );
            })}
          </ul>
          {health.verifiable.length > HOME_PREVIEW_LIMIT ? (
            <OpsActionLink
              href="/evidence"
              extraProps={{ "data-verify-view-all": health.verifiable.length }}
              style={{ display: "inline-block", marginTop: 8 }}
            >
              View all links →
            </OpsActionLink>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

// ============================================================================
// 6. WORKSPACE HEALTH — one work-state overview with verdicts.
// ============================================================================

const HEALTH_OVERALL: Record<
  "healthy" | "needs_attention" | "action_required",
  { label: string; tone: HomeTone }
> = {
  healthy: { label: "Healthy", tone: "ok" },
  needs_attention: { label: "Needs attention", tone: "warn" },
  action_required: { label: "Action required", tone: "danger" },
};

/**
 * WORKSPACE HEALTH — a list of figures, not a board of tiles.
 *
 * Every metric used to sit in its own tinted, rounded cell in a two-column
 * grid: eight little cards, eight fills, eight borders, for eight numbers.
 * The tint carried the tone, so a healthy workspace was a patchwork of
 * green and grey boxes and nothing read as a list.
 *
 * The card is the container now and the metrics are its rows —
 * LABEL ....... VALUE — with the tone in the VALUE's colour, where a
 * number's meaning belongs. The one filled row left is the overall
 * verdict, which is a single statement about the whole card.
 *
 * Nothing about the metrics themselves changes: same source, same order,
 * same tones, same `data-health-metric` / `data-health-tone` contract.
 */
export function WorkspaceHealthCard({
  metrics,
  overall,
}: {
  metrics: WorkspaceHealthMetric[];
  overall: "healthy" | "needs_attention" | "action_required";
}) {
  const verdict = HEALTH_OVERALL[overall];
  return (
    <SectionCard title="Workspace health" testId="workspace-health" fill>
      <div
        className="home-verdict"
        data-health-overall={overall}
        data-tone={HEALTH_ROW_TONE[verdict.tone] ?? "warn"}
      >
        <span
          aria-hidden
          style={{ width: 9, height: 9, borderRadius: 999, background: "currentColor" }}
        />
        <span>{verdict.label}</span>
      </div>

      <div className="home-rows">
        {metrics.map((m) => (
          <div
            key={m.key}
            className="home-row"
            data-health-metric={m.key}
            data-health-tone={m.tone}
          >
            <span className="home-row__label">{m.label}</span>
            <span
              className="home-row__value"
              data-tone={HEALTH_ROW_TONE[m.tone] ?? "neutral"}
            >
              {m.value}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * The view-model's tone vocabulary, mapped to the three the stylesheet
 * paints. Anything unrecognised stays neutral dark rather than guessing a
 * colour for a state this file does not know.
 */
const HEALTH_ROW_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = {
  ok: "ok",
  good: "ok",
  positive: "ok",
  warn: "warn",
  warning: "warn",
  pending: "warn",
  danger: "bad",
  critical: "bad",
  bad: "bad",
  neutral: "neutral",
  info: "neutral",
};

// ============================================================================
// 7. TRUST STATE — live integrity counts + zero scaffold.
// ============================================================================

function trustRows(
  trust: TrustState,
): Array<{ key: string; label: string; value: string; tone: "ok" | "warn" | "danger" | "neutral" }> {
  const rows: Array<{ key: string; label: string; value: string; tone: "ok" | "warn" | "danger" | "neutral" }> = [
    {
      key: "tsa",
      // Phase HOME-COPY — "Trusted timestamps" implied a legal trust
      // claim PROOVRA does not assert. The plain description of what
      // TSA actually does (a third-party time-stamp on the file hash)
      // is safer and clearer for a non-technical reader.
      label: "Time-stamp proof (TSA)",
      // Ticket 3B — "not stamped" is a NEUTRAL bucket (no attempt yet),
      // appended only when > 0; it never changes the row tone.
      value: `${trust.tsaStamped} stamped${trust.tsaPending ? ` · ${trust.tsaPending} pending` : ""}${trust.tsaFailed ? ` · ${trust.tsaFailed} failed` : ""}${trust.tsaNone ? ` · ${trust.tsaNone} not stamped` : ""}`,
      tone: trust.tsaFailed > 0 ? "danger" : trust.tsaPending > 0 ? "warn" : trust.empty ? "neutral" : "ok",
    },
    {
      key: "ots",
      label: "OpenTimestamps (OTS)",
      value: `${trust.otsAnchored} anchored${trust.otsPending ? ` · ${trust.otsPending} pending` : ""}${trust.otsFailed ? ` · ${trust.otsFailed} failed` : ""}${trust.otsNone ? ` · ${trust.otsNone} not anchored yet` : ""}`,
      tone: trust.otsFailed > 0 ? "danger" : trust.otsPending > 0 ? "warn" : trust.empty ? "neutral" : "ok",
    },
    { key: "signed", label: "Signed records", value: `${trust.signed} of ${trust.totalEvidence}`, tone: "neutral" },
    { key: "verify", label: "Public verification links live", value: `${trust.verifyPublished}`, tone: "neutral" },
  ];
  if (trust.verifySuspended > 0) {
    rows.push({ key: "verify-suspended", label: "Public verification links paused", value: `${trust.verifySuspended}`, tone: "danger" });
  }
  if (trust.needingAttention > 0) {
    rows.push({ key: "attention", label: "Records needing attention", value: `${trust.needingAttention}`, tone: "danger" });
  }
  return rows;
}

// Phase HOME-POLISH — trust-row surface + text resolved through the UNIFIED
// semantic system (ok→success, warn→amber, danger→critical, else neutral).
function trustToneStyle(tone: "ok" | "warn" | "danger" | "neutral"): { bg: string; border: string; value: string } {
  if (tone === "danger") return { bg: HOME_SEMANTIC.critical.softBg, border: HOME_SEMANTIC.critical.border, value: HOME_SEMANTIC.critical.strong };
  if (tone === "warn") return { bg: HOME_SEMANTIC.amber.softBg, border: HOME_SEMANTIC.amber.border, value: HOME_SEMANTIC.amber.strong };
  if (tone === "ok") return { bg: HOME_SEMANTIC.success.softBg, border: HOME_SEMANTIC.success.border, value: HOME_SEMANTIC.success.strong };
  return { bg: HOME_SEMANTIC.neutral.softBg, border: HOME_SEMANTIC.neutral.border, value: HOME_SEMANTIC.neutral.numberInk };
}

export function TrustStateCard({ trust }: { trust: TrustState }) {
  const rows = trustRows(trust);
  return (
    <SectionCard title="Verification summary" testId="trust-state" fill>
      {trust.empty ? (
        <p data-trust-empty style={{ margin: "0 0 10px 0", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          No evidence captured yet — these are the integrity signals each record will earn once
          captured.
        </p>
      ) : null}
      {/*
        A TABLE OF ROWS, and the colour is in the VALUE.

        Every row carried a full tinted fill and a matching border, so a
        workspace with two imperfect signals showed two wide pink slabs and
        the card read as an alert rather than a summary. The tone now lives
        where the meaning is — "34 failed" is red, the row is not — and the
        rows are separated by a hairline instead of by five backgrounds.
      */}
      <ul className="home-rows" style={{ ...listStyle, gap: 0 }}>
        {rows.map((r) => {
          const ts = trustToneStyle(r.tone);
          return (
            <li key={r.key} className="home-row" data-trust-key={r.key} style={listItemStyle}>
              <span className="home-row__label">{r.label}</span>
              <span className="home-row__value" style={{ color: ts.value }}>
                {r.value}
              </span>
            </li>
          );
        })}
      </ul>
      {trust.empty ? (
        <Link
          href="/capture"
          data-trust-cta="capture-first"
          style={{ ...secondaryButtonStyle, marginTop: 12, background: "#0f172a", color: "white", border: "1px solid #0f172a" }}
        >
          Capture first evidence
        </Link>
      ) : null}
      {/* The legal boundary, in the quiet cool strip it belongs in — the
          wording is untouched and is never dressed up as a finding. */}
      <p className="home-note" style={{ marginTop: "auto" }}>
        PROOVRA records integrity signals; it does not determine factual truth or legal admissibility.
      </p>
    </SectionCard>
  );
}

// ============================================================================
// 8. RECENT ACTIVITY — grouped by Today / Yesterday / Earlier.
// ============================================================================

function activityDot(kind: string): string {
  const map: Record<string, string> = {
    evidence_finalized: "#6D28D9",
    report_generated: "#16a34a",
    package_generated: "#0d9488",
    verification_published: "#0e7490",
    request_more_sent: "#b45309",
    lifecycle_transition: "#0891b2",
    destruction_review: "#b45309",
    hold_placed: "#9333ea",
    hold_released: "#7c3aed",
    escalation_opened: "#d97706",
    incident_opened: "#dc2626",
    intake_link_created: "#0891b2",
    intake_delivered: "#16a34a",
    intake_failed: "#dc2626",
    submission_received: "#7c3aed",
  };
  return map[kind] ?? "#475569";
}

export function ActivityFeed({ groups }: { groups: ActivityGroup[] }) {
  if (groups.length === 0) {
    return (
      <SectionCard title="Recent activity" testId="activity">
        <EmptyState>Activity appears when evidence is captured, reports are generated, or intake submissions are received.</EmptyState>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Recent activity" testId="activity">
      {/*
        EVERY ROW SAID THE SAME THING IN THE SAME COLOUR.

        The feed was a 2px rail with an identical 9px dot on each row, so a
        report generated, an evidence capture and an intake submission were
        visually indistinguishable and the label was clipped to one line with
        an ellipsis. The marker now carries the event's TYPE — its own colour,
        drawn from the same `activityDot` table the dot already used, so no
        new vocabulary is invented — and the label is allowed to wrap.
      */}
      {groups.map((g) => (
        <div key={g.key} className="home-act__group" data-activity-group={g.key}>
          <div className="home-act__label">{g.label}</div>
          <ul style={{ ...listStyle, gap: 0 }}>
            {g.events.map((e) => {
              const tone = activityDot(e.kind);
              return (
                <li key={e.id} className="home-act__row" data-activity-kind={e.kind} style={listItemStyle}>
                  <Link
                    href={e.href}
                    style={{ display: "contents", textDecoration: "none", color: "inherit" }}
                  >
                    <span className="home-act__icon" aria-hidden style={{ color: tone }}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: "currentColor",
                        }}
                      />
                    </span>
                    <span className="home-act__text">
                      {e.label}
                      {/* Phase HOME-INTELLIGENCE — collapsed repeats. */}
                      {e.repeatCount && e.repeatCount > 1 ? (
                        <span className="home-act__count" data-activity-repeat={e.repeatCount}>
                          ×{e.repeatCount}
                        </span>
                      ) : null}
                    </span>
                    <span className="home-act__time">{formatRelative(e.occurredAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </SectionCard>
  );
}

// ============================================================================
// 9. STORAGE — usage + honest capacity forecast.
// ============================================================================

export function StorageUsageCard({ usage }: { usage: StorageUsage | null }) {
  return (
    <SectionCard title="Storage" testId="storage-usage">
      {!usage ? (
        <EmptyState>Storage details will appear once your billing is set up.</EmptyState>
      ) : (
        // Phase HOME-POLISH (#10/#11) — this card now sits in a FULL-WIDTH
        // row, so its content is distributed horizontally instead of hugging
        // the left edge: LEFT = usage figure + percentage; CENTER = a long
        // progress bar; RIGHT = capacity forecast + "Manage plan" action.
        // Collapses to a stacked column on narrow viewports. Real values only.
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 24,
          }}
        >
          {/* LEFT — headline usage + percentage. */}
          <div style={{ flex: "0 0 auto", minWidth: 160 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{usage.usedLabel ?? "—"}</span>
              <span style={{ fontSize: 13, color: "#5d6d71" }}>of {usage.limitLabel ?? "—"}</span>
            </div>
            {usage.usagePercent != null ? (
              <div style={{ marginTop: 4, fontSize: 12.5, fontWeight: 600, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
                {usage.usagePercent}% used
              </div>
            ) : null}
          </div>

          {/* CENTER — long usage progress bar, grows to fill the wide card. */}
          <div style={{ flex: "1 1 260px", minWidth: 200 }}>
            <div
              data-storage-bar
              data-storage-near-limit={String(usage.nearLimit)}
              data-storage-limit-reached={String(usage.limitReached)}
              style={{ width: "100%", height: 10, borderRadius: 5, background: ANALYTICS_PALETTE.storageTrack, overflow: "hidden" }}
            >
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, usage.usagePercent ?? 0))}%`,
                  height: "100%",
                  background: usage.limitReached
                    ? HOME_SEMANTIC.critical.strong
                    : usage.nearLimit
                      ? HOME_SEMANTIC.amber.strong
                      : ANALYTICS_PALETTE.storageBar,
                  borderRadius: 5,
                  transition: "width 200ms ease",
                }}
              />
            </div>
          </div>

          {/* RIGHT — capacity forecast / limit status + the manage action. */}
          <div style={{ flex: "1 1 200px", minWidth: 180 }}>
            {usage.forecastRecords != null && !usage.limitReached ? (
              <p data-storage-forecast={usage.forecastRecords} style={{ margin: 0, fontSize: 12.5, color: "#5d6d71", lineHeight: 1.5 }}>
                Room for ≈ {usage.forecastRecords.toLocaleString()} more record
                {usage.forecastRecords === 1 ? "" : "s"} at your current average size.
              </p>
            ) : null}
            {usage.nearLimit || usage.limitReached ? (
              <p style={{ margin: usage.forecastRecords != null && !usage.limitReached ? "8px 0 0 0" : 0, fontSize: 13, color: usage.limitReached ? HOME_SEMANTIC.critical.strong : "#9a3412", lineHeight: 1.5 }}>
                {usage.limitReached
                  ? "Storage limit reached — top up or upgrade to keep capturing."
                  : "Approaching your storage limit."}{" "}
                <Link href={usage.upgradeHref} data-storage-upgrade style={{ color: usage.limitReached ? HOME_SEMANTIC.critical.strong : "#9a3412", fontWeight: 600 }}>
                  Manage plan →
                </Link>
              </p>
            ) : (
              <div style={{ marginTop: usage.forecastRecords != null ? 8 : 0 }}>
                <Link href={usage.upgradeHref} data-storage-upgrade style={{ ...homeSecondaryButtonStyle }}>
                  View storage →
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 10. TEAM WORK (org workspaces only) — work-centric, not a roster.
// ============================================================================

export function TeamWorkCard({ team }: { team: TeamWork | null }) {
  if (!team) return null;
  return (
    // Ticket 4 — manageHref was computed but never rendered; it now
    // drives the card CTA (the /teams landing is a verified-working
    // self-serve surface).
    <SectionCard
      title="Team work"
      testId="team-work"
      cta={{ label: "Manage team", href: team.manageHref }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <Stat label="Awaiting review" value={team.submissionsAwaitingReview} />
        <Stat label="Reports today" value={team.reportsToday} />
        <Stat label="Members" value={team.members} />
        <Stat label="Pending invites" value={team.pendingInvites} />
      </div>
    </SectionCard>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: 8, borderRadius: 8, background: "#f8fafc", textAlign: "center" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#5d6d71" }}>{label}</div>
    </div>
  );
}

// ============================================================================
// 11. GETTING STARTED — only for truly new users (auto-collapses).
// ============================================================================

export function GettingStartedChecklist({
  steps,
  complete,
}: {
  steps: ChecklistStep[];
  complete: boolean;
}) {
  const visible = steps.filter((s) => s.visible);
  if (visible.length === 0) return null;
  if (complete) return null;
  return (
    <SectionCard title="Start your first evidence workflow" testId="getting-started">
      <ul style={{ ...listStyle, gap: 4 }}>
        {visible.map((s) => (
          <li key={s.key} data-checklist-step={s.key} data-checklist-done={String(s.done)} style={{ ...listItemStyle, padding: "8px 10px" }}>
            <Link href={s.href} style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "inherit" }}>
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 4,
                  background: s.done ? "#16a34a" : "transparent",
                  border: s.done ? "1px solid #16a34a" : "1px solid #cbd5e1",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontSize: 12,
                  flex: "0 0 auto",
                }}
              >
                {s.done ? "✓" : ""}
              </span>
              <span style={{ fontSize: 13, color: s.done ? "#5d6d71" : "#0f172a", textDecoration: s.done ? "line-through" : "none" }}>
                {s.label}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

export function HomeSkeleton() {
  return (
    <div data-self-serve-home-skeleton aria-busy style={{ display: "grid", gap: 14 }}>
      <div style={{ ...skeletonRowStyle, height: 120 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={skeletonRowStyle} />
        <div style={skeletonRowStyle} />
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

// Phase HOME-POLISH — every SectionCard now uses the shared premium
// card vocabulary from home-theme.ts (glassy white, soft depth).
// PHASE 4C (2026-08-22) — the `cardStyle` alias is gone. The comment below
// still describes it because it explains why `outerCardStyle` is the
// translucent one; the near-solid surface it names backed the Action-needed
// queue module, which no longer exists.
// Phase HOME-POLISH (#2/#12) — the shared SectionCard OUTER surface is the
// translucent glass module (~0.48 white + blur) so large modules integrate
// with the branded page background instead of stacking "white card inside
// white card". Inner rows/tiles keep their stronger ~0.72 surfaces for
// readability; the near-solid `cardStyle` still backs the distinct
// Action-needed queue module (not a SectionCard).
const outerCardStyle: React.CSSProperties = homeOuterCardStyle;
const cardHeaderStyle: React.CSSProperties = homeCardHeaderStyle;
const cardTitleStyle: React.CSSProperties = homeCardTitleStyle;
const cardCtaStyle: React.CSSProperties = homeCardCtaStyle;
const cardBodyStyle: React.CSSProperties = { margin: 0 };

const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 };
const listItemStyle: React.CSSProperties = { padding: 0 };
const listItemLinkStyle: React.CSSProperties = { display: "block", padding: "8px 10px", borderRadius: 8, background: "rgba(15, 23, 42, 0.02)", textDecoration: "none", color: "inherit" };
const listItemTitleStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const listItemMetaStyle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" };
const listItemTimeStyle: React.CSSProperties = { fontSize: 11, color: "#94a3b8" };
const chipStyle: React.CSSProperties = { display: "inline-block", padding: "2px 8px", borderRadius: 999, background: "rgba(124, 58, 237, 0.08)", color: "#4338ca", fontSize: 11, fontWeight: 600 };

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 10,
  background: `linear-gradient(135deg, ${HOME_COLORS.wineDeep} 0%, ${HOME_COLORS.wine} 100%)`,
  color: "white",
  fontWeight: 650,
  fontSize: 14,
  textDecoration: "none",
  boxShadow: "0 2px 8px rgba(122, 22, 56, 0.25)",
};
const secondaryButtonStyle: React.CSSProperties = { display: "inline-block", padding: "5px 11px", borderRadius: 8, background: "white", border: "1px solid rgba(15,23,42,0.14)", color: HOME_COLORS.ink, fontWeight: 600, fontSize: 12, textDecoration: "none", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" };

const skeletonRowStyle: React.CSSProperties = { height: 180, borderRadius: 12, background: "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)" };
