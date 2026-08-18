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
  EvidenceActivitySeries,
  EvidenceTypeDistribution,
  ExecutiveSummary,
  HeroAction,
  HomeKpi,
  HomeViewModel,
  RichRecentEvidenceRow,
  WorkspacePriority,
} from "./home-view-model";
import {
  ANALYTICS_PALETTE,
  HOME_ACCENT,
  HOME_COLORS,
  HOME_SEMANTIC,
  HOME_TINTS,
  homeCardCtaStyle,
  homeCardHeaderStyle,
  homeCardStyle,
  homeCardTitleStyle,
  homeChipStyle,
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

const EXEC_STATE: Record<
  ExecutiveSummary["overallStatus"],
  { tone: "ok" | "warn" | "danger" | "neutral"; accent: string; tint: string }
> = {
  healthy: { tone: "ok", accent: HOME_COLORS.ok, tint: HOME_TINTS.ok },
  needs_attention: { tone: "warn", accent: HOME_COLORS.warn, tint: HOME_TINTS.warn },
  action_required: { tone: "danger", accent: HOME_COLORS.danger, tint: HOME_TINTS.danger },
  critical: { tone: "danger", accent: HOME_COLORS.dangerDeep, tint: "rgba(220, 38, 38, 0.12)" },
  onboarding: { tone: "neutral", accent: HOME_COLORS.indigo, tint: HOME_TINTS.indigo },
};

export function ExecutiveSummaryBand({ summary }: { summary: ExecutiveSummary }) {
  const s = EXEC_STATE[summary.overallStatus];
  return (
    <section
      className="home-card ops-banner-card"
      data-self-serve-section="executive-summary"
      data-exec-status={summary.overallStatus}
      // Phase HOME-ENTERPRISE — the "command center" bar now renders on the
      // SHARED `.ops-banner-card` shell (dark-navy surface + icon-card
      // artwork + shadow + [content | action] row). Only the dynamic,
      // status-coloured left rail stays inline so the shell can be reused
      // by the Case detail header with a neutral accent instead.
      style={{ borderLeft: `4px solid ${s.accent}` }}
    >
      <span
        data-exec-status-chip
        style={{
          ...homeChipStyle,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(255, 255, 255, 0.06)",
          border: `1px solid ${s.accent}`,
          color: "#f8fafc",
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: s.accent,
            boxShadow: `0 0 0 3px ${s.accent}33`,
          }}
        />
        {summary.statusLabel}
      </span>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div
          data-exec-title
          style={{ fontSize: 15, fontWeight: 750, color: "#ffffff", letterSpacing: -0.2 }}
        >
          {summary.summaryTitle}
        </div>
        <p
          data-exec-sentence
          style={{ margin: "3px 0 0 0", fontSize: 12.5, lineHeight: 1.5, color: "rgba(226, 232, 240, 0.78)" }}
        >
          {summary.summarySentence}
        </p>
        {summary.secondarySignals.length > 0 ? (
          <p
            data-exec-secondary
            style={{ margin: "5px 0 0 0", fontSize: 11, color: "rgba(226, 232, 240, 0.52)" }}
          >
            Also: {summary.secondarySignals.join(" · ")}
          </p>
        ) : null}
      </div>
      {summary.actionHref && summary.actionLabel ? (
        // Glass button — reads as PART of the dark card, not a heavy
        // floating red block. Styling + hover live in `.home-exec-action`
        // (app-shell-v2.css) so the hover state works.
        <Link
          href={summary.actionHref}
          data-exec-action
          className="home-exec-action"
          title={summary.recommendedAction ?? undefined}
        >
          <span>{summary.actionLabel}</span>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
            style={{ opacity: 0.9, flexShrink: 0 }}
          >
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      ) : null}
      {/* Artwork column — reserves the right zone for the PROOVRA hexagon
          background so the action button sits BETWEEN the alert copy and the
          artwork (not flush to the far-right edge, not floating over the
          mark). It shrinks toward zero and wraps on narrow screens so the
          layout stacks naturally: text, then button, then artwork. */}
      <div
        aria-hidden
        style={{ flex: "0 1 clamp(120px, 20%, 260px)", minWidth: 0 }}
      />
    </section>
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
      {kpis.map((k) => {
        const surface = KPI_SURFACE[k.key];
        const tone = toneColor(k.tone);
        return (
          <Link
            key={k.key}
            href={k.href}
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

export function WorkspacePrioritiesCard({
  priorities,
  operationalQueue,
}: {
  priorities: WorkspacePriority[];
  /**
   * Phase HOME-OVERVIEW-MERGE — the former standalone "Action needed"
   * card was removed; its "Verification packages to complete / N reports
   * missing a package" item now merges in here as the last attention
   * row. Real operational-queue items only; the packages item is found
   * by its `complete_package` type. Absent/empty → nothing extra renders.
   */
  operationalQueue?: HomeViewModel["operationalQueue"];
}) {
  // Phase HOME-INTELLIGENCE — ranked executive summary: top 3 with
  // severity chip, plain-language reason, and a direct action.
  const top = priorities.slice(0, 3);
  const more = priorities.length - top.length;

  // Phase HOME-OVERVIEW-MERGE — the real "packages missing a package"
  // operational-queue item (type "complete_package"), rendered as the
  // last attention row. Its title carries the real count ("N reports
  // missing a package"); we surface that count exactly, never invented.
  const packagesItem = operationalQueue?.find(
    (q) => q.type === "complete_package",
  );
  const packagesCount = packagesItem
    ? Number.parseInt(packagesItem.title, 10)
    : 0;
  const showPackages =
    !!packagesItem && Number.isFinite(packagesCount) && packagesCount > 0;
  const packagesTone = toneColor("warn");
  return (
    <section className="home-card" style={homeCardStyle} data-self-serve-section="workspace-priorities">
      <header style={homeCardHeaderStyle}>
        {/* Phase HOME-COPY — "What needs attention" reads more
            directly than "Workspace priorities" (which sounded like
            an enterprise OKR list). Same ordered priority items;
            clearer title for individuals and journalists alike. */}
        <h2 style={homeCardTitleStyle}>What needs attention</h2>
      </header>
      {top.length === 0 && !showPackages ? (
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
          <ul style={priorityListStyle}>
            {top.map((p) => {
              const sev = PRIORITY_SEVERITY[p.severity];
              const tone = toneColor(sev.tone);
              return (
                <li key={p.key} style={{ margin: 0 }}>
                  <div style={priorityRowV2Style} data-priority={p.key} data-priority-severity={p.severity}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span
                        data-priority-chip={p.severity}
                        style={{ ...homeChipStyle, background: tone.bg, color: tone.fg, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
                      >
                        {sev.label}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 650, color: HOME_COLORS.ink, minWidth: 0 }}>
                        {p.label}
                      </span>
                    </div>
                    {/* Phase HOME-DECISIONS — what it means + what to do. */}
                    <p style={priorityReasonStyle} data-priority-why>
                      {p.whyItMatters}
                    </p>
                    <Link
                      href={p.href}
                      style={priorityActionStyle}
                      data-priority-action={p.key}
                      title={p.recommendedAction}
                    >
                      {p.actionLabel} →
                    </Link>
                  </div>
                </li>
              );
            })}
            {/* Phase HOME-OVERVIEW-MERGE — the merged operational-queue
                "packages missing a package" item, always rendered LAST
                (after Critical / integrity / OTS pending), same row
                structure/density as the priorities above: a restrained
                amber "Needs attention" badge, plain title, real-count
                detail, and an indigo action link. */}
            {showPackages && packagesItem ? (
              <li key="op:complete_package" style={{ margin: 0 }}>
                <div
                  style={priorityRowV2Style}
                  data-priority="complete_package"
                  data-priority-severity="warning"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span
                      data-priority-chip="warning"
                      style={{ ...homeChipStyle, background: packagesTone.bg, color: packagesTone.fg, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
                    >
                      Needs attention
                    </span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 650, color: HOME_COLORS.ink, minWidth: 0 }}>
                      Verification packages to complete
                    </span>
                  </div>
                  <p style={priorityReasonStyle} data-priority-why>
                    {packagesCount} report{packagesCount === 1 ? "" : "s"} missing a package
                  </p>
                  <Link
                    href={packagesItem.action.href}
                    style={priorityActionStyle}
                    data-priority-action="complete_package"
                  >
                    Complete packages →
                  </Link>
                </div>
              </li>
            ) : null}
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
  series,
}: {
  series: EvidenceActivitySeries;
}) {
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
            Last 14 days{series.sampled ? " · latest 100 records" : ""}
          </span>
        </div>
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
                  <span style={{ ...homeChipStyle, background: chip.bg, color: chip.fg }}>
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

function donutColorForKey(key: string): string {
  return DONUT_COLOR_BY_KEY[key.toLowerCase()] ?? ANALYTICS_PALETTE.archives;
}

// Per-segment premium linear-gradient stops for the donut ring — a subtle
// two-stop sheen per category that flows red → magenta-purple → violet →
// blue → deep navy. Mapped by category KEY; unrecognised keys (folders,
// other, …) fall back to the archives navy so the ring never breaks the
// progression. No glow/neon — just a restrained light→dark within-hue
// gradient. The LEGEND dots stay on the flat ANALYTICS_PALETTE base
// colours so each dot maps exactly to its segment.
const DONUT_GRADIENT_BY_KEY: Record<string, readonly [string, string]> = {
  // Images — elegant wine rose, less bright and less alert-like
  images: ["#D56A84", "#A83A5B"],
  image: ["#D56A84", "#A83A5B"],
  photo: ["#D56A84", "#A83A5B"],
  photos: ["#D56A84", "#A83A5B"],

  // Documents — premium indigo
  documents: ["#9582FF", "#6654E8"],
  document: ["#9582FF", "#6654E8"],
  docs: ["#9582FF", "#6654E8"],

  // Videos — enterprise blue
  videos: ["#6FA1F7", "#3974DC"],
  video: ["#6FA1F7", "#3974DC"],

  // Audio — soft periwinkle blue, no green or cyan
  audio: ["#A9A7FF", "#746FE8"],

  // Archives — deep slate navy
  archives: ["#536581", "#293A58"],
  archive: ["#536581", "#293A58"],
};

const DONUT_ARCHIVES_GRADIENT: readonly [string, string] = [
  "#536581",
  "#293A58",
];

function donutGradientForKey(key: string): readonly [string, string] {
  return DONUT_GRADIENT_BY_KEY[key.toLowerCase()] ?? DONUT_ARCHIVES_GRADIENT;
}

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
      className="home-card"
      style={{
        ...homeOuterCardStyle,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        // Indigo & Rose enterprise palette — glass card surface (this card
        // only) so it blends with the dashboard rather than reading as a
        // solid white rectangle.
        background: "rgba(255, 255, 255, 0.34)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: "1px solid rgba(255, 255, 255, 0.52)",
        boxShadow: "0 10px 28px rgba(15, 23, 42, 0.035)",
        borderRadius: 20,
        padding: 20,
      }}
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
                  e.currentTarget.style.background = "#F8FAFC";
              }}
              onMouseLeave={(e) => {
                if (mode !== "records")
                  e.currentTarget.style.background = "transparent";
              }}
              style={{
                ...segmentedButtonStyle,
                background: mode === "records" ? "#111827" : "transparent",
                color: mode === "records" ? "#fff" : HOME_COLORS.slate,
                border:
                  mode === "records" ? "1px solid transparent" : "1px solid #E5E7EB",
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
                  e.currentTarget.style.background = "#F8FAFC";
              }}
              onMouseLeave={(e) => {
                if (mode !== "files")
                  e.currentTarget.style.background = "transparent";
              }}
              style={{
                ...segmentedButtonStyle,
                background: mode === "files" ? "#111827" : "transparent",
                color: mode === "files" ? "#fff" : HOME_COLORS.slate,
                border:
                  mode === "files" ? "1px solid transparent" : "1px solid #E5E7EB",
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
        <div style={donutWrapStyle}>
          <div style={donutChartColStyle}>
            <Donut slices={slices} total={sampleSize} files={isFilesMode} />
          </div>
          <ul style={donutLegendStyle}>
            {slices.map((s) => (
              <li key={s.key} style={donutLegendItemStyle}>
                <span
                  style={{ ...legendSwatchStyle, borderRadius: 999, background: donutColorForKey(s.key) }}
                />
                <span style={donutLegendLabelStyle}>{s.label}</span>
                <span style={donutLegendCountStyle}>{s.count}</span>
                <span style={donutLegendPercentStyle}>
                  {s.percent}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Donut({
  slices,
  total,
  files,
}: {
  slices: EvidenceTypeDistribution["slices"];
  total: number;
  files?: boolean;
}) {
  // ~9% larger ring, lighter stroke + a hairline gap between slices for a
  // premium, continuous enterprise donut (still pure stroke-dasharray SVG).
  const R = 48;
  const C = 2 * Math.PI * R;
  const GAP = 1.6;
  let offset = 0;
  // Stable, collision-free gradient id per segment key so multiple donuts
  // (Records / Preserved files) on the page keep distinct <defs>.
  const gradId = (key: string) =>
    `donut-grad-${files ? "files" : "records"}-${key.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  return (
    <svg
      width="128"
      height="128"
      viewBox="0 0 128 128"
      shapeRendering="geometricPrecision"
      role="img"
      aria-label={
        files
          ? `Preserved files by type across ${total} files.`
          : `Evidence type distribution across ${total} records.`
      }
    >
      <defs>
        {slices.map((s) => {
          const [from, to] = donutGradientForKey(s.key);
          return (
            <linearGradient
              key={s.key}
              id={gradId(s.key)}
              x1="0"
              y1="0"
              x2="1"
              y2="1"
            >
              <stop offset="0%" stopColor={from} />
              <stop offset="100%" stopColor={to} />
            </linearGradient>
          );
        })}
      </defs>
      <circle cx="64" cy="64" r={R} fill="none" stroke="#E1E6EF" strokeWidth="11.5" />
      {slices.map((s) => {
        const frac = total > 0 ? s.count / total : 0;
        const seg = frac * C;
        // Hairline gap after each slice so the ring reads as separated but
        // still continuous; clamped so tiny slices never vanish.
        const dash = slices.length > 1 ? Math.max(seg - GAP, 0.5) : seg;
        const el = (
          <circle
            key={s.key}
            cx="64"
            cy="64"
            r={R}
            fill="none"
            stroke={`url(#${gradId(s.key)})`}
            strokeWidth="11.5"
            strokeLinecap={slices.length > 1 ? "butt" : "round"}
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 64 64)"
          >
            <title>{`${s.label}: ${s.count} (${s.percent}%)`}</title>
          </circle>
        );
        offset += seg;
        return el;
      })}
      <text
        x="64"
        y="59"
        textAnchor="middle"
        fontSize="20"
        fontWeight="750"
        fill={HOME_COLORS.ink}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {total}
      </text>
      <text
        x="64"
        y="78"
        textAnchor="middle"
        fontSize="9"
        fill="#7A8699"
        letterSpacing="0.35"
      >
        {files ? "files" : "records"}
      </text>
    </svg>
  );
}

// ============================================================================
// Styles
// ============================================================================

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
const donutWrapStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "160px minmax(0, 1fr)",
  alignItems: "center",
  gap: 22,
  flex: 1,
  minHeight: 220,
};
const donutChartColStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
const donutLegendStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flex: 1,
  minWidth: 200,
};
const donutLegendItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
};
const donutLegendLabelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: HOME_SEMANTIC.neutral.secondary,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const donutLegendCountStyle: React.CSSProperties = {
  color: HOME_SEMANTIC.neutral.numberInk,
  fontWeight: 650,
  fontVariantNumeric: "tabular-nums",
  minWidth: 38,
  textAlign: "right",
};
const donutLegendPercentStyle: React.CSSProperties = {
  color: "#8A94A6",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 600,
  width: 40,
  textAlign: "right",
};

const priorityListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const priorityRowV2Style: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "10px 12px",
  borderRadius: 10,
  background: HOME_COLORS.soft,
};
const priorityReasonStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 11.5,
  lineHeight: 1.45,
  color: HOME_COLORS.slate,
};
const priorityActionStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  fontSize: 12,
  fontWeight: 650,
  color: HOME_COLORS.indigo,
  textDecoration: "none",
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
