/**
 * PROOVRA Home — premium dashboard surfaces (Phase HOME-KPI, polished
 * in Phase HOME-POLISH).
 *
 * Top KPI row, evidence-activity chart, recent-evidence list and the
 * evidence-type distribution. Pure presentation over the view-model:
 * every number on these cards is real backend data; sampled series are
 * labelled as samples. SVG/CSS only — no chart library.
 *
 * Visual system: home-theme.ts — pearl surface, glassy cards, icon
 * blocks, wine/indigo/teal accents. Legal-grade, not consumer-toy.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatUserDate } from "../../lib/date";
import { usePlatformContext } from "../../lib/platform-context";

import type {
  EvidenceActivityRangeId,
  EvidenceActivitySeries,
  EvidenceTypeDistribution,
  ExecutiveSummary,
  HeroAction,
  HomeKpi,
  HomeViewModel,
  RichRecentEvidenceRow,
  WorkspacePriority,
} from "./home-view-model";
import { ACTIVITY_RANGES } from "./home-view-model";
import { AnnotatedDonut, DonutReadout } from "./AnnotatedDonut";
import {
  ANALYTICS_PALETTE,
  HOME_ACCENT,
  HOME_COLORS,
  HOME_TINTS,
  homeCardCtaStyle,
  homeCardHeaderStyle,
  homeCardStyle,
  homeCardTitleStyle,
  plainStatusTextStyle,
  homeOuterCardStyle,
  iconBlockStyle,
  toneColor,
} from "./home-theme";

// ============================================================================
// Inline icon set — small, serious, stroke-based. No emoji.
// ============================================================================

function Icon({ d, color, size = 18 }: { d: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={d} stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  evidence: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h5M10 17h5",
  matters: "M4 7h5l2 2h9v10H4zM4 7V5h6",
  shield: "M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6zM9.5 12l2 2 3.5-3.5",
  report: "M6 3h9l4 4v14H6zM14 3v5h5M9.5 12h6M9.5 16h6",
  inboxIcon: "M4 13l3-8h10l3 8v6H4zM4 13h5l1.5 2.5h3L15 13h5",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20",
  bell: "M12 3a6 6 0 0 0-6 6v3.5l-1.6 3.2a.7.7 0 0 0 .63 1.01h13.94a.7.7 0 0 0 .63-1.01L18 12.5V9a6 6 0 0 0-6-6Zm-2.2 15a2.4 2.4 0 0 0 4.4 0",
  spark: "M13 3L5 14h6l-1 7 8-11h-6z",
} as const;

// Phase HOME-ENTERPRISE — colours SAMPLED PIXEL-FOR-PIXEL from the
// reference dashboard. The cards are DEEP and dark: a hue-tinted, lighter
// top-left flowing into a near-navy bottom-right (135deg). The icon sits
// in a near-white frosted block and takes the DARK card hue. `chart` is
// the light sparkline tint. `bottomAccent` (intake only) reproduces the
// reference's amber bottom glow. Do NOT brighten these — the reference is
// intentionally low-brightness and premium.
const KPI_SURFACE: Record<
  HomeKpi["key"],
  {
    d: string;
    grad: string;
    icon: string;
    iconBg: string;
    iconBorder: string;
    chart: string;
    bottomAccent?: string;
  }
> = {
  evidence: {
    d: ICONS.evidence,
    grad: "linear-gradient(135deg, #3A2D91 0%, #2A2A78 52%, #1E2665 100%)",
    icon: "#D6BEFF",
    iconBg: "rgba(182, 145, 255, 0.12)",
    iconBorder: "rgba(182, 145, 255, 0.20)",
    chart: "#B88EFB",
  },
  matters: {
    d: ICONS.matters,
    grad: "linear-gradient(135deg, #3157A4 0%, #234080 52%, #1D366D 100%)",
    icon: "#8CCBFF",
    iconBg: "rgba(90, 170, 255, 0.12)",
    iconBorder: "rgba(90, 170, 255, 0.20)",
    chart: "#6EB6FF",
  },
  trust: {
    d: ICONS.shield,
    grad: "linear-gradient(135deg, #17516E 0%, #0D4459 52%, #083F52 100%)",
    icon: "#98FFF0",
    iconBg: "rgba(100, 255, 220, 0.10)",
    iconBorder: "rgba(100, 255, 220, 0.18)",
    chart: "#5FD6C8",
  },
  deliverables: {
    d: ICONS.report,
    grad: "linear-gradient(135deg, #5345A2 0%, #36337B 52%, #2C2C6C 100%)",
    icon: "#D7BEFF",
    iconBg: "rgba(192, 150, 255, 0.12)",
    iconBorder: "rgba(192, 150, 255, 0.20)",
    chart: "#B49CFF",
  },
  intake: {
    d: ICONS.inboxIcon,
    grad: "linear-gradient(135deg, #514235 0%, #44382E 52%, #372C25 100%)",
    icon: "#FFD48A",
    iconBg: "rgba(255, 200, 120, 0.12)",
    iconBorder: "rgba(255, 200, 120, 0.20)",
    chart: "#F7A64B",
    bottomAccent: "rgba(247, 166, 75, 0.55)",
  },
};

// ============================================================================
// Header — greeting, search, inbox indicator, ONE primary action.
// ============================================================================

export function HomeHeader({ hero }: { hero: HeroAction }) {
  // Phase HOME-GREETING — the Home page owns its own identity via a
  // time-of-day greeting. The global header owns Search / Workspace /
  // Notifications / Language / Profile, so those controls are NOT
  // duplicated here (no page search box, no inbox bell). The one
  // retained page action is a neutral navigation CTA (NOT derived from
  // hero.ctaLabel — see home-polish CTA-NORM): a true onboarding user
  // (capture_first) gets "Capture evidence"; everyone else gets the
  // plain "All evidence" list.
  const ctx = usePlatformContext();
  const user = ctx.envelope?.user;
  const firstName =
    user?.firstName?.trim() ||
    user?.displayName?.trim().split(/\s+/)[0] ||
    "";

  // Compute the greeting after mount so server/client render agree
  // (the hour is only known on the client → avoids hydration mismatch).
  const [greeting, setGreeting] = useState("Welcome");
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(
      h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening",
    );
  }, []);

  // Neutral navigation target — NOT a duplicate of the queue/priorities
  // decision surfaces, and never derived from hero.ctaLabel (which once
  // double-rendered "Review Integrity"). "All evidence" reads plainly
  // across all user types; a brand-new user is nudged to capture first.
  const primary =
    hero.kind === "capture_first"
      ? { label: "Capture evidence", href: "/capture" }
      : { label: "All evidence", href: "/evidence" };

  return (
    <header style={headerWrapStyle} data-home-header>
      <div style={{ minWidth: 0 }}>
        <h1 style={headerTitleStyle}>
          {greeting}
          {firstName ? `, ${firstName}` : ""}{" "}
          <span aria-hidden="true">👋</span>
        </h1>
        <p style={headerSubtitleStyle}>
          Here&apos;s what&apos;s happening across your digital evidence
          operations today.
        </p>
      </div>
      <Link href={primary.href} style={headerPrimaryCtaStyle} data-home-primary-cta>
        {primary.label}
      </Link>
    </header>
  );
}

const headerPrimaryCtaStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 10,
  background: "linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)",
  color: "white",
  fontWeight: 650,
  fontSize: 13.5,
  textDecoration: "none",
  whiteSpace: "nowrap",
  boxShadow: "0 2px 8px rgba(109, 40, 217, 0.30)",
};

// ============================================================================
// Executive Summary — one-glance workspace state (Phase HOME-EXEC).
// Compact band, never duplicates the queue: one state, one sentence,
// one action. All values come from vm.executiveSummary (decision
// engine + trust floors); nothing here invents copy.
// ============================================================================

// EXEC_STATE (the dark band's per-status accent/tint table) was removed
// with the band itself: a white alert takes its severity from the rail, the
// badge and the action, all of which are CSS.

/**
 * THE CRITICAL BANNER — a white card with a red edge.
 *
 * It was a dark navy slab carrying the PROOVRA mark as artwork, with a
 * glass button and a reserved column for the graphic. The single most
 * urgent statement on the page was the one rendered as a marketing panel:
 * the title sat at 15px on a dark ground, the explanation at 12.5px in
 * 78%-opacity slate, and a decorative hexagon took a fifth of the width.
 *
 * The severity now lives where it can be read — a coloured rail, a
 * semantic badge, and an OUTLINED action. Nothing about the decision is
 * changed: the status, the sentence, the secondary signals and the action
 * all still come from `vm.executiveSummary`.
 */
export function ExecutiveSummaryBand({ summary }: { summary: ExecutiveSummary }) {
  return (
    <section
      className="home-alert"
      data-self-serve-section="executive-summary"
      data-exec-status={summary.overallStatus}
    >
      <span className="home-alert__badge" data-exec-status-chip>
        {summary.statusLabel}
      </span>

      <div className="home-alert__body">
        <div className="home-alert__title" data-exec-title>
          {summary.summaryTitle}
        </div>
        <p className="home-alert__text" data-exec-sentence>
          {summary.summarySentence}
        </p>
        {summary.secondarySignals.length > 0 ? (
          <p className="home-alert__also" data-exec-secondary>
            Also: {summary.secondarySignals.join(" · ")}
          </p>
        ) : null}
      </div>

      {summary.actionHref && summary.actionLabel ? (
        <Link
          href={summary.actionHref}
          data-exec-action
          className="home-alert__action"
          title={summary.recommendedAction ?? undefined}
        >
          <span>{summary.actionLabel}</span>
          <ArrowRight />
        </Link>
      ) : null}
    </section>
  );
}

/** The one right-facing arrow every inline Home action uses. */
export function ArrowRight({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ============================================================================
// KPI row — reference-grade cards: icon block, big number, trend,
// sparkline, status dot, soft per-key gradient.
// ============================================================================

function Sparkline({ values, color, uid }: { values: number[]; color: string; uid: string }) {
  const w = 84;
  const h = 30;
  const max = Math.max(...values, 1);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map(
    (v, i) =>
      [i * step, h - 4 - (v / max) * (h - 9)] as const,
  );
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const gid = `spark-${uid}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ display: "block" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function KpiRow({ kpis }: { kpis: HomeKpi[] }) {
  return (
    <div className="home-kpi-grid" data-home-kpi-row>
      {kpis.map((k, index) => {
        const surface = KPI_SURFACE[k.key];
        const tone = toneColor(k.tone);
        return (
          <Link
            key={k.key}
            href={k.href}
            className="home-kpi"
            data-home-kpi-index={index}
            style={{
              ...kpiCardStyle,
              // Reference-accurate: the deep diagonal gradient IS the
              // surface (bright hue top-left → deep navy bottom-right).
              // A hair of top gloss + a soft outer shadow; intake adds
              // the amber bottom glow. No brightening, no heavy inner
              // shadow — the reference is intentionally dark.
              background: surface.bottomAccent
                ? `linear-gradient(0deg, ${surface.bottomAccent} 0%, rgba(0,0,0,0) 14%), ${surface.grad}`
                : surface.grad,
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 18px rgba(15,23,42,0.14)",
            }}
            data-home-kpi={k.key}
          >
            <div style={kpiTopStyle}>
              <span
                style={{
                  ...kpiIconBlockStyle,
                  background: surface.iconBg,
                  border: `1px solid ${surface.iconBorder}`,
                }}
              >
                <Icon d={surface.d} color={surface.icon} size={19} />
              </span>
              <span style={kpiLabelStyle}>{k.label}</span>
              <span
                aria-hidden
                title={k.tone}
                style={{
                  ...kpiToneDotStyle,
                  background: tone.dot,
                  boxShadow: "0 0 0 2px rgba(255, 255, 255, 0.30)",
                }}
              />
            </div>
            <div style={kpiValueRowStyle}>
              <span style={kpiValueStyle}>{k.locked ? "—" : k.value}</span>
              {k.spark && k.spark.some((v) => v > 0) ? (
                <Sparkline values={k.spark} color={surface.chart} uid={k.key} />
              ) : null}
              {/* chart colour = surface.chart (sampled from reference) */}
            </div>
            <span style={kpiSubtitleStyle}>{k.subtitle}</span>
          </Link>
        );
      })}
    </div>
  );
}

// ============================================================================
// Workspace Priorities — the active-user replacement for onboarding.
// Every row is a real operational counter.
// ============================================================================

const PRIORITY_SEVERITY: Record<
  WorkspacePriority["severity"],
  { label: string; tone: "danger" | "warn" | "neutral" }
> = {
  critical: { label: "Critical", tone: "danger" },
  warning: { label: "Warning", tone: "warn" },
  info: { label: "Info", tone: "neutral" },
};

/** Severity tone -> the three pill fills the stylesheet paints. */
const PRIORITY_PILL_TONE: Record<"danger" | "warn" | "neutral", "bad" | "warn" | "info"> = {
  danger: "bad",
  warn: "warn",
  neutral: "info",
};

export function WorkspacePrioritiesCard({
  priorities,
  operations,
}: {
  priorities: WorkspacePriority[];
  /**
   * ATTENTION ARCHITECTURE PHASE 4C (2026-08-22).
   *
   * This prop was `operationalQueue`, and the card used it to render an extra
   * "N reports missing a package" row. Two things were wrong with that:
   *
   *   1. The queue was built from the caller's own notification feed, so a
   *      shared workspace fact was being read out of one person's mailbox.
   *   2. The row DUPLICATED the `complete_packages` priority, which is
   *      derived from the pipeline projection and already appears in the list
   *      above it. The same fact could therefore render twice, from two
   *      sources, with two different counts.
   *
   * The prop is now the canonical workspace Operations summary, and the card
   * uses it for ONE thing: deciding whether it is entitled to say "All clear".
   */
  operations?: HomeViewModel["operations"];
}) {
  // Phase HOME-INTELLIGENCE — ranked executive summary: top 3 with
  // severity chip, plain-language reason, and a direct action.
  const top = priorities.slice(0, 3);
  const more = priorities.length - top.length;

  // PHASE 2.3 / 4C — MAY THIS CARD SAY "ALL CLEAR"?
  //
  // Only when the workspace's Operations summary was read completely. An
  // empty priorities list over an unavailable or bounded read means "we could
  // not see", and printing "All clear" there is the most damaging sentence an
  // operations surface can produce: it is indistinguishable from good news
  // and it is not news at all.
  const mayAssertAllClear = operations ? operations.mayAssertAllClear : false;
  const operationsUnavailable = operations != null && !operations.available;
  return (
    <section className="home-card" style={homeCardStyle} data-self-serve-section="workspace-priorities">
      <header style={homeCardHeaderStyle}>
        {/* Phase HOME-COPY — "What needs attention" reads more
            directly than "Workspace priorities" (which sounded like
            an enterprise OKR list). Same ordered priority items;
            clearer title for individuals and journalists alike. */}
        <h2 style={homeCardTitleStyle}>What needs attention</h2>
      </header>
      {top.length === 0 && !mayAssertAllClear ? (
        <div style={allClearStyle} data-priorities-unknown>
          <span style={iconBlockStyle(HOME_TINTS.warn, 34)}>
            <Icon d={ICONS.shield} color={HOME_COLORS.warn} size={17} />
          </span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: HOME_COLORS.slate }}>
              {operationsUnavailable
                ? "Operations status unavailable"
                : "Operations status incomplete"}
            </div>
            <div style={{ fontSize: 12, color: HOME_COLORS.slate }}>
              {operationsUnavailable
                ? "This workspace's shared operational status could not be loaded, so we can't tell you it's clear."
                : "Not every source could be read, so this may not be the full picture."}
            </div>
          </div>
        </div>
      ) : top.length === 0 ? (
        <div style={allClearStyle} data-priorities-clear>
          <span style={iconBlockStyle(HOME_TINTS.ok, 34)}>
            <Icon d={ICONS.shield} color={HOME_COLORS.ok} size={17} />
          </span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: HOME_COLORS.okDeep }}>
              All clear
            </div>
            <div style={{ fontSize: 12, color: HOME_COLORS.slate }}>
              No workspace priorities need attention right now.
            </div>
          </div>
        </div>
      ) : (
        <>
          {/*
            A LIST, not four grey slabs.

            Each item carried its own filled, rounded container, so the card
            read as a stack of cards and the severity chip — the one thing
            that ranks them — sat inside that container to the LEFT of the
            title, competing with it for the start of the line.

            The item is now rows in one white card: title and description on
            the left, the severity pill on the right where the eye can scan
            straight down it, and the action underneath. Same order, same
            severities, same links, same data-* contract.
          */}
          <ul className="home-attn" style={priorityListStyle}>
            {top.map((p) => {
              const sev = PRIORITY_SEVERITY[p.severity];
              return (
                <li
                  key={p.key}
                  className="home-attn__item"
                  data-priority={p.key}
                  data-priority-severity={p.severity}
                >
                  <span className="home-attn__title">{p.label}</span>
                  <span
                    className="home-attn__pill"
                    data-priority-chip={p.severity}
                    data-tone={PRIORITY_PILL_TONE[sev.tone]}
                  >
                    {sev.label}
                  </span>
                  {/* Phase HOME-DECISIONS — what it means + what to do. */}
                  <p className="home-attn__text" data-priority-why>
                    {p.whyItMatters}
                  </p>
                  <Link
                    href={p.href}
                    className="home-link"
                    style={{ gridColumn: 1 }}
                    data-priority-action={p.key}
                    title={p.recommendedAction}
                  >
                    {p.actionLabel}
                    <ArrowRight size={14} />
                  </Link>
                </li>
              );
            })}
            {/*
              ATTENTION ARCHITECTURE PHASE 4C (2026-08-22) — the extra
              "Verification packages to complete" row was REMOVED from here.

              It was built from the notification-feed-derived operational
              queue, and it duplicated the `complete_packages` workspace
              priority already rendered in the list above — same fact, two
              sources, two counts that could disagree. The priority is derived
              from the pipeline projection, which is the domain authority for
              it, so that is the one that stays.
            */}
          </ul>
          {more > 0 ? (
            <span data-priorities-more={more} style={{ display: "block", marginTop: 8, fontSize: 11.5, color: HOME_COLORS.muted }}>
              +{more} lower-priority item{more === 1 ? "" : "s"} tracked
            </span>
          ) : null}
        </>
      )}
    </section>
  );
}

// ============================================================================
// Evidence Activity chart — 14-day dual-series, gradient bars, hover
// titles, legend. Pure SVG.
// ============================================================================

export function EvidenceActivityChart({
  seriesByRange,
}: {
  /** Every range, built from the records already loaded. */
  seriesByRange: Record<EvidenceActivityRangeId, EvidenceActivitySeries>;
}) {
  const [rangeId, setRangeId] = useState<EvidenceActivityRangeId>("14d");
  const range = ACTIVITY_RANGES.find((r) => r.id === rangeId) ?? ACTIVITY_RANGES[0];
  const series = seriesByRange[rangeId] ?? seriesByRange["14d"];
  const hasData = series.totalEvidence > 0 || series.totalReports > 0;

  return (
    <section
      className="home-card"
      style={{ ...homeOuterCardStyle, height: "100%", display: "flex", flexDirection: "column" }}
      data-self-serve-section="evidence-activity"
    >
      <header style={chartHeaderStyle}>
        {/* Header is title + subtitle stacked left, no decorative icon. */}
        <div style={{ minWidth: 0 }}>
          <h2 style={activityTitleStyle}>Evidence activity</h2>
          <span style={activitySubtitleStyle}>
            {range.label}
            {series.bucketDays > 1
              ? ` · ${series.bucketDays === 7 ? "weekly" : "fortnightly"} totals`
              : ""}
            {series.sampled ? " · latest 100 records" : ""}
          </span>
        </div>
        {/*
          THE RANGE IS THE READER'S CHOICE, and it is a secondary one.

          A row of four buttons would take the top of the card and compete with
          the chart for attention; a select states the same four options in the
          space of one control. Every range reads the records already loaded, so
          switching costs no request and has no loading state.
        */}
        <label style={rangeSelectWrapStyle}>
          <span className="app-visually-hidden">Activity period</span>
          <select
            value={rangeId}
            onChange={(e) => setRangeId(e.target.value as EvidenceActivityRangeId)}
            data-activity-range
            style={rangeSelectStyle}
          >
            {ACTIVITY_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {hasData ? (
          <div style={legendStyle}>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: ANALYTICS_PALETTE.evidenceSeries }} />
              Evidence ({series.totalEvidence})
            </span>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: ANALYTICS_PALETTE.reportsSeries }} />
              Reports ({series.totalReports})
            </span>
          </div>
        ) : null}
      </header>
      {hasData ? (
        <div style={activityChartAreaStyle}>
          <ActivityBars series={series} />
        </div>
      ) : (
        <p style={chartEmptyStyle}>
          Activity appears here as evidence is captured and reports are
          generated.
        </p>
      )}
    </section>
  );
}

function ActivityBars({ series }: { series: EvidenceActivitySeries }) {
  const W = 760;
  const H = 240;
  const PAD_L = 24;
  const PAD_B = 22;
  const PAD_T = 8;
  const innerW = W - PAD_L - 6;
  const innerH = H - PAD_B - PAD_T;
  const n = series.points.length;
  const group = innerW / n;
  const barW = Math.min(14, group / 2.6);
  // Add y-axis headroom so the tallest bar occupies ~45–65% of the usable
  // plot height instead of touching the top grid line. The DATA is
  // unchanged — only the domain max grows (dataMax 12 → ~18-20), which
  // shortens every bar proportionally and leaves calm space above.
  const dataMax = Math.max(
    1,
    ...series.points.map((p) => Math.max(p.evidence, p.reports)),
  );
  const max = Math.max(dataMax + 1, Math.ceil(dataMax * 1.7));
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const tickCount = Math.min(4, max);
  const ticks = Array.from({ length: tickCount }, (_, i) =>
    Math.round(((i + 1) / tickCount) * max),
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block" }}
      role="img"
      aria-label={`Evidence activity over the last 14 days: ${series.totalEvidence} evidence records, ${series.totalReports} reports.`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke={ANALYTICS_PALETTE.gridLine} strokeWidth="1" />
          <text x={PAD_L - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9" fill={ANALYTICS_PALETTE.axisText}>
            {t}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 4} y1={y(0)} y2={y(0)} stroke={ANALYTICS_PALETTE.gridLine} strokeWidth="1" />
      {series.points.map((p, i) => {
        const cx = PAD_L + i * group + group / 2;
        return (
          <g key={p.dayLabel + i}>
            {/* Baseline marker at EVERY one of the 14 day positions — so
                zero-activity days are visibly present on a continuous
                14-day axis rather than reading as empty gaps. */}
            <circle cx={cx} cy={y(0)} r={1} fill={ANALYTICS_PALETTE.axisText} opacity={0.32} />
            {p.evidence > 0 ? (
              <rect
                x={cx - barW - 1}
                y={y(p.evidence)}
                width={barW}
                height={Math.max(2, y(0) - y(p.evidence))}
                rx={1.5}
                fill={ANALYTICS_PALETTE.evidenceSeries}
              >
                <title>{`${p.dayLabel}: ${p.evidence} evidence record${p.evidence === 1 ? "" : "s"}`}</title>
              </rect>
            ) : null}
            {p.reports > 0 ? (
              <rect
                x={cx + 1}
                y={y(p.reports)}
                width={barW}
                height={Math.max(2, y(0) - y(p.reports))}
                rx={1.5}
                fill={ANALYTICS_PALETTE.reportsSeries}
              >
                <title>{`${p.dayLabel}: ${p.reports} report${p.reports === 1 ? "" : "s"} generated`}</title>
              </rect>
            ) : null}
            {i % 2 === 0 ? (
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="9" fill={ANALYTICS_PALETTE.axisText}>
                {p.dayLabel}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ============================================================================
// Recent Evidence — list card with per-row trust chip.
// ============================================================================

const TYPE_GLYPHS: Record<string, string> = {
  PHOTO: "IMG",
  VIDEO: "VID",
  AUDIO: "AUD",
  DOCUMENT: "DOC",
  SCREEN: "SCR",
};

export function RecentEvidenceCard({ rows }: { rows: RichRecentEvidenceRow[] }) {
  return (
    <section className="home-card" style={homeCardStyle} data-self-serve-section="recent-evidence">
      <header style={homeCardHeaderStyle}>
        <h2 style={homeCardTitleStyle}>Recent evidence</h2>
        <Link href="/evidence" style={homeCardCtaStyle}>
          All evidence →
        </Link>
      </header>
      {rows.length === 0 ? (
        <p style={chartEmptyStyle}>
          Your newest records appear here after the first capture.
        </p>
      ) : (
        <ul style={recentListStyle}>
          {rows.slice(0, 3).map((r) => {
            const chip = toneColor(r.trustChip.tone);
            return (
              <li key={r.id} style={{ margin: 0, padding: 0 }}>
                <Link href={r.href} style={recentRowStyle} data-recent-evidence-id={r.id}>
                  <span style={typeBadgeStyle} aria-hidden>
                    {TYPE_GLYPHS[r.typeKey] ?? "EVD"}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={recentTitleStyle}>{r.title}</span>
                    <span style={recentMetaStyle}>
                      {r.typeLabel}
                      {r.caseId ? " · in case" : ""} · {formatRelativeShort(r.createdAt)}
                    </span>
                  </span>
                  {/* "Report ready" is a fact about the record, not a control.
                      It was a filled capsule beside the file name; it is the
                      same word in the same tone, without the pill. */}
                  <span
                    style={{ ...plainStatusTextStyle(chip.fg), flexShrink: 0 }}
                    data-recent-trust={r.trustChip.tone}
                  >
                    {r.trustChip.label}
                  </span>
                  <span aria-hidden style={{ color: HOME_COLORS.muted, fontSize: 13 }}>→</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatRelativeShort(iso: string): string {
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
// Evidence by type — SVG donut + legend (sample-labelled).
// ============================================================================

// Records-by-type donut colours — mapped by the category KEY so each
// evidence type keeps a stable, cohesive analytics hue. Falls back to a
// quiet neutral for any unrecognised key.
const DONUT_COLOR_BY_KEY: Record<string, string> = {
  images: ANALYTICS_PALETTE.images,
  image: ANALYTICS_PALETTE.images,
  photo: ANALYTICS_PALETTE.images,
  photos: ANALYTICS_PALETTE.images,
  documents: ANALYTICS_PALETTE.documents,
  document: ANALYTICS_PALETTE.documents,
  docs: ANALYTICS_PALETTE.documents,
  videos: ANALYTICS_PALETTE.videos,
  video: ANALYTICS_PALETTE.videos,
  audio: ANALYTICS_PALETTE.audio,
  archives: ANALYTICS_PALETTE.archives,
  archive: ANALYTICS_PALETTE.archives,
};

/**
 * A category's colour, by NAME.
 *
 * Never by index: a workspace with no audio must not slide documents onto the
 * videos colour, or the same chart means two different things on two accounts.
 * An unrecognised key takes a neutral slate rather than borrowing the archives
 * orange, which would put two different categories in one colour.
 */
function donutColorForKey(key: string): string {
  return DONUT_COLOR_BY_KEY[key.toLowerCase()] ?? "#94A3B8";
}

// Per-segment premium linear-gradient stops for the donut ring — a subtle
// two-stop sheen per category that flows red → magenta-purple → violet →
// blue → deep navy. Mapped by category KEY; unrecognised keys (folders,
// other, …) fall back to the archives navy so the ring never breaks the
// progression. No glow/neon — just a restrained light→dark within-hue
// gradient. The LEGEND dots stay on the flat ANALYTICS_PALETTE base
// colours so each dot maps exactly to its segment.
export function EvidenceTypeDonutCard({
  distribution,
  preservedFiles,
}: {
  distribution: EvidenceTypeDistribution;
  /**
   * Phase HOME-RECORDS-BY-TYPE — "Preserved files by type" view (one
   * count per EvidencePart). When present, the card renders a Records
   * / Files toggle. Null when the backend aggregate endpoint is
   * unavailable — the toggle is hidden rather than mixing concepts.
   */
  preservedFiles?: EvidenceTypeDistribution | null;
}) {
  const hasFilesView =
    !!preservedFiles && preservedFiles.sampleSize >= 0;
  const [mode, setMode] = useState<"records" | "files">("records");
  const active =
    mode === "files" && preservedFiles ? preservedFiles : distribution;
  const { slices, sampleSize, source } = active;
  const isFilesMode = mode === "files" && !!preservedFiles;
  const isAggregate = source === "workspace-aggregate";
  // Subtitle is provenance-honest: workspace-aggregate counts every
  // active non-deleted row; latest-sample reflects the latest-100 list
  // and is labelled as a sample so users don't mistake it for the
  // whole workspace.
  const subtitle =
    sampleSize > 0
      ? isFilesMode
        ? `${sampleSize} file${sampleSize === 1 ? "" : "s"} preserved · inside evidence records`
        : isAggregate
          ? `${sampleSize} record${sampleSize === 1 ? "" : "s"} · by primary type`
          : `latest ${sampleSize} records sampled · by primary type`
      : "";
  const subtitleTitle = isFilesMode
    ? "Counts each preserved file inside multipart evidence packages."
    : "Counts primary evidence records, not files inside packages.";
  return (
    <section
      className="home-card home-analytics-card"
      style={{ ...homeOuterCardStyle, height: "100%" }}
      data-self-serve-section="evidence-types"
    >
      <header style={donutHeaderStyle}>
        {/* Phase HOME-RECORDS-BY-TYPE — record-level by default. When
            the backend aggregate endpoint is reachable, a Files toggle
            exposes the EvidencePart-level view ("Preserved files by
            type") side-by-side without mixing the two concepts. The
            old "Evidence by type" wording implied a file-level count;
            the truthful rename + provenance subtitle make the contract
            explicit. */}
        <div style={{ minWidth: 0 }}>
          <h2 style={donutTitleStyle}>Records by type</h2>
          <span
            style={donutSubtitleStyle}
            data-evidence-types-subtitle
            title={subtitleTitle}
          >
            {subtitle}
          </span>
        </div>
        {hasFilesView ? (
          <div
            role="tablist"
            aria-label="Records or preserved files"
            data-evidence-types-toggle
            style={segmentedControlStyle}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "records"}
              data-evidence-types-tab="records"
              onClick={() => setMode("records")}
              onMouseEnter={(e) => {
                if (mode !== "records")
                  e.currentTarget.style.background = "rgba(124, 58, 237, 0.06)";
              }}
              onMouseLeave={(e) => {
                if (mode !== "records")
                  e.currentTarget.style.background = "transparent";
              }}
              style={{
                ...segmentedButtonStyle,
                background: mode === "records" ? "var(--accent-050, #F2ECFE)" : "transparent",
                color: mode === "records" ? "var(--accent-600, #6D28D9)" : HOME_COLORS.slate,
                border: "1px solid transparent",
              }}
            >
              Records
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "files"}
              data-evidence-types-tab="files"
              onClick={() => setMode("files")}
              onMouseEnter={(e) => {
                if (mode !== "files")
                  e.currentTarget.style.background = "rgba(124, 58, 237, 0.06)";
              }}
              onMouseLeave={(e) => {
                if (mode !== "files")
                  e.currentTarget.style.background = "transparent";
              }}
              style={{
                ...segmentedButtonStyle,
                background: mode === "files" ? "var(--accent-050, #F2ECFE)" : "transparent",
                color: mode === "files" ? "var(--accent-600, #6D28D9)" : HOME_COLORS.slate,
                border: "1px solid transparent",
              }}
            >
              Preserved files
            </button>
          </div>
        ) : null}
      </header>
      {sampleSize === 0 ? (
        <p style={chartEmptyStyle}>
          {isFilesMode
            ? "No files have been preserved yet."
            : "The distribution of your evidence types appears after the first capture."}
        </p>
      ) : (
        <div style={donutWrapStyle} className="home-donut-wrap">
          <div style={donutChartColStyle} className="home-donut-col">
            <AnnotatedDonut
              slices={slices}
              total={sampleSize}
              colourFor={donutColorForKey}
              centreLabel={isFilesMode ? "Files" : "Records"}
              ariaLabel={
                isFilesMode
                  ? `Preserved files by type across ${sampleSize} files.`
                  : `Evidence type distribution across ${sampleSize} records.`
              }
              idPrefix={isFilesMode ? "files" : "records"}
            />
            {/* The same numbers as words. Hidden from sight on a wide screen —
                the annotations already say them — and shown on a phone, where
                labels around a ring cannot be read at a usable size. */}
            <DonutReadout
              slices={slices}
              colourFor={donutColorForKey}
              unit={isFilesMode ? "files" : "records"}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ============================================================================
// Styles
// ============================================================================

/* The period control: secondary by construction. It sits in the header beside
   the legend and is sized to its longest option, not to the card. */
const rangeSelectWrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
};
const rangeSelectStyle: React.CSSProperties = {
  appearance: "auto",
  font: "inherit",
  fontSize: 12,
  color: HOME_COLORS.slate,
  background: "#fff",
  border: "1px solid var(--border-default, rgba(15, 23, 42, 0.09))",
  borderRadius: 8,
  padding: "4px 8px",
  cursor: "pointer",
  maxWidth: 150,
};

const headerWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  flexWrap: "wrap",
};
const headerTitleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 780,
  lineHeight: 1.15,
  margin: 0,
  color: HOME_COLORS.ink,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  letterSpacing: -0.5,
};
const headerSubtitleStyle: React.CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: 14,
  lineHeight: 1.5,
  color: HOME_COLORS.slate,
};
const kpiCardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 16,
  padding: "18px 20px 16px",
  textDecoration: "none",
  color: "#ffffff",
  minHeight: 140,
  minWidth: 0,
};
const kpiTopStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
};
// Icon block — subtle, integrated into the card's own colour family
// (per-card bg/border supplied at render). No white, no solid fill, no
// shadow — just soft transparency so the icon melts into the card.
const kpiIconBlockStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 42,
  height: 42,
  borderRadius: 12,
  flexShrink: 0,
};
const kpiLabelStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "rgba(255, 255, 255, 0.82)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const kpiToneDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0,
};
const kpiValueRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 8,
  minHeight: 40,
};
const kpiValueStyle: React.CSSProperties = {
  fontSize: 34,
  fontWeight: 700,
  lineHeight: 1,
  color: "#ffffff",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: -0.6,
};
const kpiSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  fontWeight: 500,
  color: "rgba(255, 255, 255, 0.66)",
};

const chartHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  marginBottom: 12,
  gap: 10,
  flexWrap: "wrap",
};
// Evidence Activity — refined title/subtitle (no decorative icon block).
const activityTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15.5,
  fontWeight: 680,
  color: "#172033",
  letterSpacing: -0.1,
};
const activitySubtitleStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 12.5,
  color: "#718096",
};
// Chart-area region — flexes to fill the card so the plot is large, not a
// tiny graphic in a big rectangle.
const activityChartAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 220,
  display: "flex",
};
const chartEmptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "14px 0",
  color: HOME_COLORS.slate,
  fontSize: 13,
  lineHeight: 1.6,
};
const legendStyle: React.CSSProperties = { display: "flex", gap: 14, flexWrap: "wrap" };
const legendItemStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11.5,
  color: HOME_COLORS.slate,
};
const legendSwatchStyle: React.CSSProperties = {
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: 3,
  flexShrink: 0,
};

const recentListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const recentRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 11px",
  borderRadius: 10,
  background: HOME_COLORS.soft,
  textDecoration: "none",
  color: "inherit",
};
const typeBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 38,
  height: 32,
  borderRadius: 9,
  background: HOME_ACCENT.bg,
  color: HOME_ACCENT.ink,
  border: `1px solid ${HOME_ACCENT.border}`,
  fontSize: 10,
  fontWeight: 750,
  letterSpacing: 0.4,
  flexShrink: 0,
};
const recentTitleStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 620,
  color: HOME_COLORS.ink,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const recentMetaStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 11,
  color: HOME_COLORS.muted,
};

// Records-by-type header — stacked title/subtitle left, segmented control
// right; aligned to the top so a two-line title never pushes the control.
const donutHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  marginBottom: 18,
  gap: 12,
  flexWrap: "wrap",
};
const donutTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15.5,
  fontWeight: 700,
  color: "#172033",
  letterSpacing: -0.1,
};
const donutSubtitleStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 12.5,
  fontWeight: 500,
  color: "#94A3B8",
};
// Equal-width two-button segmented control. Fixed per-button min-width so
// "Preserved files" always sits on one line and both buttons match width.
const segmentedControlStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: 6,
  flexShrink: 0,
  borderRadius: 999,
  border: 0,
  padding: 0,
  fontSize: 11.5,
  fontWeight: 600,
  background: "transparent",
  boxShadow: "none",
};
const segmentedButtonStyle: React.CSSProperties = {
  minWidth: 104,
  padding: "5px 12px",
  borderRadius: 999,
  border: 0,
  cursor: "pointer",
  whiteSpace: "nowrap",
  textAlign: "center",
  lineHeight: 1.2,
  transition: "background 120ms ease, color 120ms ease",
};
// Balanced two-column body: donut left (with breathing room), legend right.
/* ONE COLUMN, ALL OF IT.

   This was `160px minmax(0, 1fr)` — a fixed-width chart column beside the
   legend. The legend is gone (each segment carries its own annotation now), so
   the second track held nothing and the donut was pinned to 160px inside a
   600px card: a thumbnail with five categories in it.

   The chart takes the card. */
const donutWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  flex: 1,
  minHeight: 300,
};
const donutChartColStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

const priorityListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const allClearStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 12px",
  borderRadius: 12,
  background: HOME_TINTS.ok,
  border: "1px solid rgba(5, 150, 105, 0.18)",
};
