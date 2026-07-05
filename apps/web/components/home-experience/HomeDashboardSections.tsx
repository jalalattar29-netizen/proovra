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
  RichRecentEvidenceRow,
  WorkspacePriority,
} from "./home-view-model";
import {
  HOME_COLORS,
  HOME_TINTS,
  homeCardCtaStyle,
  homeCardHeaderStyle,
  homeCardStyle,
  homeCardTitleStyle,
  homeChipStyle,
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
  background: "linear-gradient(135deg, #6b5bff 0%, #5949e4 100%)",
  color: "white",
  fontWeight: 650,
  fontSize: 13.5,
  textDecoration: "none",
  whiteSpace: "nowrap",
  boxShadow: "0 2px 8px rgba(89, 73, 228, 0.30)",
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
      className="home-card"
      data-self-serve-section="executive-summary"
      data-exec-status={summary.overallStatus}
      style={{
        // Phase HOME-ENTERPRISE — the "command center" bar. A premium
        // dark-navy surface backed by the PROOVRA icon-card asset (the
        // 3D hexagon glows on the right; text sits in the dark space on
        // the left). A status-colored left rail + chip + action carry
        // the severity signal; the surface itself stays enterprise-dark
        // in every state. White ink over a strong navy overlay keeps
        // contrast well above AA.
        position: "relative",
        overflow: "hidden",
        border: "1px solid rgba(255, 255, 255, 0.06)",
        borderLeft: `4px solid ${s.accent}`,
        borderRadius: 16,
        padding: "16px 20px",
        margin: 0,
        color: "#f8fafc",
        background:
          // Dark navy base; the icon-card artwork is scaled DOWN to a
          // decorative hexagon anchored on the right (no longer a
          // dominant full-bleed cover). The gradient keeps the left ~⅔
          // solid for text contrast and lets the mark glow on the right.
          "linear-gradient(90deg, #0b1024 0%, #0b1024 42%, rgba(13, 18, 42, 0.55) 74%, rgba(16, 20, 46, 0.15) 100%)," +
          'url("/assets/cards/icon-card.png") right center / auto 260% no-repeat,' +
          "#0b1024",
        boxShadow:
          "0 1px 2px rgba(8, 11, 26, 0.20), 0 14px 34px rgba(8, 11, 26, 0.28)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
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
    <div style={kpiRowStyle} data-home-kpi-row>
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
}: {
  priorities: WorkspacePriority[];
}) {
  // Phase HOME-INTELLIGENCE — ranked executive summary: top 3 with
  // severity chip, plain-language reason, and a direct action.
  const top = priorities.slice(0, 3);
  const more = priorities.length - top.length;
  return (
    <section className="home-card" style={homeCardStyle} data-self-serve-section="workspace-priorities">
      <header style={homeCardHeaderStyle}>
        {/* Phase HOME-COPY — "What needs attention" reads more
            directly than "Workspace priorities" (which sounded like
            an enterprise OKR list). Same ordered priority items;
            clearer title for individuals and journalists alike. */}
        <h2 style={homeCardTitleStyle}>What needs attention</h2>
      </header>
      {top.length === 0 ? (
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
    <section className="home-card" style={homeCardStyle} data-self-serve-section="evidence-activity">
      <header style={chartHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={iconBlockStyle(HOME_TINTS.indigo, 32)}>
            <Icon d={ICONS.spark} color={HOME_COLORS.indigo} size={16} />
          </span>
          <div>
            <h2 style={homeCardTitleStyle}>Evidence activity</h2>
            <span style={chartSubtitleStyle}>
              Last 14 days{series.sampled ? " · latest 100 records" : ""}
            </span>
          </div>
        </div>
        {hasData ? (
          <div style={legendStyle}>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: HOME_COLORS.wine }} />
              Evidence ({series.totalEvidence})
            </span>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: HOME_COLORS.teal }} />
              Reports ({series.totalReports})
            </span>
          </div>
        ) : null}
      </header>
      {hasData ? (
        <ActivityBars series={series} />
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
  const W = 720;
  const H = 190;
  const PAD_L = 26;
  const PAD_B = 22;
  const PAD_T = 10;
  const innerW = W - PAD_L - 6;
  const innerH = H - PAD_B - PAD_T;
  const n = series.points.length;
  const group = innerW / n;
  const barW = Math.min(12, group / 2.6);
  const max = Math.max(1, ...series.points.map((p) => Math.max(p.evidence, p.reports)));
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const tickCount = Math.min(4, max);
  const ticks = Array.from({ length: tickCount }, (_, i) =>
    Math.round(((i + 1) / tickCount) * max),
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={`Evidence activity over the last 14 days: ${series.totalEvidence} evidence records, ${series.totalReports} reports.`}
    >
      <defs>
        <linearGradient id="ha-ev" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={HOME_COLORS.wine} />
          <stop offset="100%" stopColor="#a8345f" />
        </linearGradient>
        <linearGradient id="ha-rp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={HOME_COLORS.teal} />
          <stop offset="100%" stopColor="#38b6c9" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="rgba(15,23,42,0.06)" strokeWidth="1" />
          <text x={PAD_L - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9" fill={HOME_COLORS.muted}>
            {t}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 4} y1={y(0)} y2={y(0)} stroke="rgba(15,23,42,0.14)" strokeWidth="1" />
      {series.points.map((p, i) => {
        const cx = PAD_L + i * group + group / 2;
        return (
          <g key={p.dayLabel + i}>
            {p.evidence > 0 ? (
              <rect
                x={cx - barW - 1}
                y={y(p.evidence)}
                width={barW}
                height={Math.max(2, y(0) - y(p.evidence))}
                rx={2.5}
                fill="url(#ha-ev)"
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
                rx={2.5}
                fill="url(#ha-rp)"
              >
                <title>{`${p.dayLabel}: ${p.reports} report${p.reports === 1 ? "" : "s"} generated`}</title>
              </rect>
            ) : null}
            {i % 2 === 0 ? (
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="9" fill={HOME_COLORS.muted}>
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
          {rows.map((r) => {
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

const DONUT_COLORS = [
  HOME_COLORS.wine,
  HOME_COLORS.indigo,
  HOME_COLORS.teal,
  HOME_COLORS.violet,
  "#64748b",
  "#94a3b8",
];

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
    <section className="home-card" style={homeCardStyle} data-self-serve-section="evidence-types">
      <header style={homeCardHeaderStyle}>
        {/* Phase HOME-RECORDS-BY-TYPE — record-level by default. When
            the backend aggregate endpoint is reachable, a Files toggle
            exposes the EvidencePart-level view ("Preserved files by
            type") side-by-side without mixing the two concepts. The
            old "Evidence by type" wording implied a file-level count;
            the truthful rename + provenance subtitle make the contract
            explicit. */}
        <h2 style={homeCardTitleStyle}>Records by type</h2>
        <span
          style={chartSubtitleStyle}
          data-evidence-types-subtitle
          title={subtitleTitle}
        >
          {subtitle}
        </span>
        {hasFilesView ? (
          <div
            role="tablist"
            aria-label="Records or preserved files"
            data-evidence-types-toggle
            style={{
              display: "inline-flex",
              gap: 0,
              marginTop: 4,
              borderRadius: 999,
              border: `1px solid ${HOME_COLORS.cardBorder}`,
              padding: 2,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "records"}
              data-evidence-types-tab="records"
              onClick={() => setMode("records")}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: 0,
                cursor: "pointer",
                background:
                  mode === "records" ? HOME_COLORS.ink : "transparent",
                color:
                  mode === "records" ? "#fff" : HOME_COLORS.slate,
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
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: 0,
                cursor: "pointer",
                background:
                  mode === "files" ? HOME_COLORS.ink : "transparent",
                color:
                  mode === "files" ? "#fff" : HOME_COLORS.slate,
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
          <Donut slices={slices} total={sampleSize} files={isFilesMode} />
          <ul style={donutLegendStyle}>
            {slices.map((s, i) => (
              <li key={s.key} style={donutLegendItemStyle}>
                <span
                  style={{ ...legendSwatchStyle, background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                />
                <span style={{ flex: 1, color: HOME_COLORS.slate }}>{s.label}</span>
                <span style={{ color: HOME_COLORS.ink, fontWeight: 650 }}>{s.count}</span>
                <span style={{ color: HOME_COLORS.muted, width: 38, textAlign: "right" }}>
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
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg
      width="128"
      height="128"
      viewBox="0 0 128 128"
      role="img"
      aria-label={
        files
          ? `Preserved files by type across ${total} files.`
          : `Evidence type distribution across ${total} records.`
      }
    >
      <circle cx="64" cy="64" r={R} fill="none" stroke="#eef0f5" strokeWidth="15" />
      {slices.map((s, i) => {
        const frac = total > 0 ? s.count / total : 0;
        const dash = frac * C;
        const el = (
          <circle
            key={s.key}
            cx="64"
            cy="64"
            r={R}
            fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="15"
            strokeLinecap={slices.length > 1 ? "butt" : "round"}
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 64 64)"
          >
            <title>{`${s.label}: ${s.count} (${s.percent}%)`}</title>
          </circle>
        );
        offset += dash;
        return el;
      })}
      <text x="64" y="61" textAnchor="middle" fontSize="22" fontWeight="750" fill={HOME_COLORS.ink}>
        {total}
      </text>
      <text x="64" y="77" textAnchor="middle" fontSize="9.5" fill={HOME_COLORS.muted}>
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
const kpiRowStyle: React.CSSProperties = {
  display: "grid",
  // Wider KPI tiles so the first row feels balanced and the five cards
  // span naturally across the container instead of floating narrow.
  // min(100%, …) guarantees a single tile never overflows the narrowest
  // mobile viewport (no horizontal scroll).
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 248px), 1fr))",
  gap: 16,
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
const chartSubtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: HOME_COLORS.muted,
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
  background: HOME_TINTS.wine,
  color: HOME_COLORS.wine,
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

const donutWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 18,
  flexWrap: "wrap",
};
const donutLegendStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 7,
  flex: 1,
  minWidth: 170,
};
const donutLegendItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
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
