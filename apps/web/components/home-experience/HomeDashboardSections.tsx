/**
 * PROOVRA Home — premium dashboard surfaces (Phase HOME-KPI).
 *
 * Top KPI row, evidence-activity chart, recent-evidence list and the
 * evidence-type distribution. Pure presentation over the view-model:
 * every number on these cards is real backend data; sampled series are
 * labelled as samples. SVG/CSS only — no chart library.
 *
 * Visual tone: PROOVRA evidence-operations — light surface, dark slate
 * text, restrained indigo accent. Serious, legal-grade, not playful.
 */

"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type {
  EvidenceActivitySeries,
  EvidenceTypeDistribution,
  HeroAction,
  HomeKpi,
  RichRecentEvidenceRow,
} from "./home-view-model";

// ============================================================================
// Header — greeting, search, inbox indicator, ONE primary action.
// ============================================================================

export function HomeHeader({
  workspaceName,
  inboxCount,
  hero,
}: {
  workspaceName: string | null;
  inboxCount: number;
  hero: HeroAction;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  // One primary action only: the contextual hero action when it is
  // operational work, otherwise Capture evidence.
  const primary =
    hero.kind !== "caught_up" && hero.href
      ? { label: hero.ctaLabel || "Open", href: hero.href }
      : { label: "Capture evidence", href: "/capture" };

  return (
    <header style={headerWrapStyle} data-home-header>
      <div style={{ minWidth: 0 }}>
        <h1 style={headerTitleStyle}>
          {workspaceName?.trim() || "Your evidence operation"}
        </h1>
        <p style={headerSubtitleStyle}>
          Evidence, intake, reports, and verification in one operational view.
        </p>
      </div>
      <div style={headerActionsStyle}>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
          }}
          style={{ margin: 0 }}
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search evidence, cases, reports…"
            aria-label="Search evidence, cases, reports"
            style={searchInputStyle}
            data-home-search
          />
        </form>
        <Link
          href="/inbox"
          aria-label={
            inboxCount > 0 ? `Inbox — ${inboxCount} items` : "Inbox"
          }
          style={bellWrapStyle}
          data-home-inbox-indicator
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 3a6 6 0 0 0-6 6v3.5l-1.6 3.2a.7.7 0 0 0 .63 1.01h13.94a.7.7 0 0 0 .63-1.01L18 12.5V9a6 6 0 0 0-6-6Zm-2.2 15a2.4 2.4 0 0 0 4.4 0"
              stroke="#334155"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {inboxCount > 0 ? <span style={bellDotStyle} data-home-inbox-dot /> : null}
        </Link>
        <Link href={primary.href} style={headerPrimaryCtaStyle} data-home-primary-cta>
          {primary.label}
        </Link>
      </div>
    </header>
  );
}

// ============================================================================
// KPI row
// ============================================================================

const TONE_COLORS: Record<HomeKpi["tone"], { dot: string; text: string }> = {
  ok: { dot: "#059669", text: "#065f46" },
  warn: { dot: "#d97706", text: "#92400e" },
  danger: { dot: "#dc2626", text: "#991b1b" },
  neutral: { dot: "#94a3b8", text: "#475569" },
};

function Sparkline({ values }: { values: number[] }) {
  const w = 72;
  const h = 24;
  const max = Math.max(...values, 1);
  const step = w / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ display: "block" }}>
      <polyline
        points={points}
        fill="none"
        stroke="#4f46e5"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
    </svg>
  );
}

export function KpiRow({ kpis }: { kpis: HomeKpi[] }) {
  return (
    <div style={kpiRowStyle} data-home-kpi-row>
      {kpis.map((k) => (
        <Link key={k.key} href={k.href} style={kpiCardStyle} data-home-kpi={k.key}>
          <div style={kpiTopStyle}>
            <span style={kpiLabelStyle}>{k.label}</span>
            <span
              aria-hidden
              style={{ ...kpiToneDotStyle, background: TONE_COLORS[k.tone].dot }}
            />
          </div>
          <div style={kpiValueRowStyle}>
            <span style={kpiValueStyle}>{k.locked ? "—" : k.value}</span>
            {k.spark && k.spark.some((v) => v > 0) ? <Sparkline values={k.spark} /> : null}
          </div>
          <span style={{ ...kpiSubtitleStyle, color: TONE_COLORS[k.tone].text }}>
            {k.subtitle}
          </span>
        </Link>
      ))}
    </div>
  );
}

// ============================================================================
// Evidence Activity chart — 14-day dual-series bar chart, pure SVG.
// ============================================================================

export function EvidenceActivityChart({
  series,
}: {
  series: EvidenceActivitySeries;
}) {
  const hasData = series.totalEvidence > 0 || series.totalReports > 0;

  return (
    <section className="home-card" style={chartCardStyle} data-self-serve-section="evidence-activity">
      <header style={chartHeaderStyle}>
        <div>
          <h2 style={cardTitleStyle}>Evidence activity</h2>
          <span style={chartSubtitleStyle}>
            Last 14 days{series.sampled ? " · latest 100 records" : ""}
          </span>
        </div>
        {hasData ? (
          <div style={legendStyle}>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: "#4f46e5" }} />
              Evidence captured ({series.totalEvidence})
            </span>
            <span style={legendItemStyle}>
              <span style={{ ...legendSwatchStyle, background: "#0e7490" }} />
              Reports generated ({series.totalReports})
            </span>
          </div>
        ) : null}
      </header>
      {hasData ? <ActivityBars series={series} /> : (
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
  const H = 180;
  const PAD_L = 26;
  const PAD_B = 22;
  const PAD_T = 8;
  const innerW = W - PAD_L - 6;
  const innerH = H - PAD_B - PAD_T;
  const n = series.points.length;
  const group = innerW / n;
  const barW = Math.min(11, group / 2.6);
  const max = Math.max(
    1,
    ...series.points.map((p) => Math.max(p.evidence, p.reports)),
  );
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  // Up to 4 horizontal gridlines on integer ticks.
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
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={PAD_L - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">
            {t}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 4} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />
      {series.points.map((p, i) => {
        const cx = PAD_L + i * group + group / 2;
        return (
          <g key={p.dayLabel + i}>
            {p.evidence > 0 ? (
              <rect
                x={cx - barW - 1}
                y={y(p.evidence)}
                width={barW}
                height={Math.max(1.5, y(0) - y(p.evidence))}
                rx={2}
                fill="#4f46e5"
                opacity={0.9}
              />
            ) : null}
            {p.reports > 0 ? (
              <rect
                x={cx + 1}
                y={y(p.reports)}
                width={barW}
                height={Math.max(1.5, y(0) - y(p.reports))}
                rx={2}
                fill="#0e7490"
                opacity={0.85}
              />
            ) : null}
            {i % 2 === 0 ? (
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="9" fill="#64748b">
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

const CHIP_TONES: Record<string, React.CSSProperties> = {
  ok: { background: "rgba(5, 150, 105, 0.09)", color: "#065f46" },
  warn: { background: "rgba(217, 119, 6, 0.10)", color: "#92400e" },
  danger: { background: "rgba(220, 38, 38, 0.09)", color: "#991b1b" },
  neutral: { background: "rgba(100, 116, 139, 0.10)", color: "#475569" },
};

export function RecentEvidenceCard({
  rows,
}: {
  rows: RichRecentEvidenceRow[];
}) {
  return (
    <section className="home-card" style={cardStyle} data-self-serve-section="recent-evidence">
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>Recent evidence</h2>
        <Link href="/evidence" style={cardCtaStyle}>
          All evidence →
        </Link>
      </header>
      {rows.length === 0 ? (
        <p style={chartEmptyStyle}>
          Your newest records appear here after the first capture.
        </p>
      ) : (
        <ul style={recentListStyle}>
          {rows.map((r) => (
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
                <span
                  style={{ ...recentChipStyle, ...(CHIP_TONES[r.trustChip.tone] ?? CHIP_TONES.neutral) }}
                >
                  {r.trustChip.label}
                </span>
              </Link>
            </li>
          ))}
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
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

// ============================================================================
// Evidence by type — SVG donut + legend (sample-labelled).
// ============================================================================

const DONUT_COLORS = ["#4f46e5", "#0e7490", "#b45309", "#475569", "#94a3b8", "#64748b"];

export function EvidenceTypeDonutCard({
  distribution,
}: {
  distribution: EvidenceTypeDistribution;
}) {
  const { slices, sampleSize, sampled } = distribution;
  return (
    <section className="home-card" style={cardStyle} data-self-serve-section="evidence-types">
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>Evidence by type</h2>
        <span style={chartSubtitleStyle}>
          {sampleSize > 0
            ? sampled
              ? `latest ${sampleSize} records`
              : `${sampleSize} record${sampleSize === 1 ? "" : "s"}`
            : ""}
        </span>
      </header>
      {sampleSize === 0 ? (
        <p style={chartEmptyStyle}>
          The distribution of your evidence types appears after the first
          capture.
        </p>
      ) : (
        <div style={donutWrapStyle}>
          <Donut slices={slices} total={sampleSize} />
          <ul style={donutLegendStyle}>
            {slices.map((s, i) => (
              <li key={s.key} style={donutLegendItemStyle}>
                <span
                  style={{ ...legendSwatchStyle, background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                />
                <span style={{ flex: 1, color: "#334155" }}>{s.label}</span>
                <span style={{ color: "#0f172a", fontWeight: 600 }}>{s.count}</span>
                <span style={{ color: "#94a3b8", width: 38, textAlign: "right" }}>
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
}: {
  slices: EvidenceTypeDistribution["slices"];
  total: number;
}) {
  const R = 40;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      role="img"
      aria-label={`Evidence type distribution across ${total} records.`}
    >
      <circle cx="60" cy="60" r={R} fill="none" stroke="#f1f5f9" strokeWidth="16" />
      {slices.map((s, i) => {
        const frac = total > 0 ? s.count / total : 0;
        const dash = frac * C;
        const el = (
          <circle
            key={s.key}
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="16"
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 60 60)"
          />
        );
        offset += dash;
        return el;
      })}
      <text x="60" y="57" textAnchor="middle" fontSize="20" fontWeight="700" fill="#0f172a">
        {total}
      </text>
      <text x="60" y="73" textAnchor="middle" fontSize="9" fill="#64748b">
        records
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
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
  color: "#0f172a",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const headerSubtitleStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 14,
  color: "#5d6d71",
};
const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};
const searchInputStyle: React.CSSProperties = {
  width: 250,
  padding: "9px 13px",
  borderRadius: 9,
  border: "1px solid #cbd5e1",
  background: "white",
  fontSize: 13,
  color: "#0f172a",
  outline: "none",
};
const bellWrapStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 38,
  height: 38,
  borderRadius: 9,
  border: "1px solid #cbd5e1",
  background: "white",
  textDecoration: "none",
};
const bellDotStyle: React.CSSProperties = {
  position: "absolute",
  top: 7,
  right: 8,
  width: 8,
  height: 8,
  borderRadius: 999,
  background: "#dc2626",
  border: "1.5px solid white",
};
const headerPrimaryCtaStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 9,
  background: "#1e293b",
  color: "white",
  fontWeight: 600,
  fontSize: 13.5,
  textDecoration: "none",
  whiteSpace: "nowrap",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.18)",
};

const kpiRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
  gap: 12,
};
const kpiCardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "14px 16px",
  textDecoration: "none",
  color: "inherit",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
  minWidth: 0,
};
const kpiTopStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const kpiLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: "#64748b",
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
  minHeight: 30,
};
const kpiValueStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 750,
  lineHeight: 1,
  color: "#0f172a",
  fontVariantNumeric: "tabular-nums",
};
const kpiSubtitleStyle: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.45,
};

const cardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: 16,
  margin: 0,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};
const chartCardStyle: React.CSSProperties = { ...cardStyle };
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: 10,
  gap: 10,
};
const chartHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  marginBottom: 12,
  gap: 10,
  flexWrap: "wrap",
};
const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const cardCtaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#4f46e5",
  textDecoration: "none",
  fontWeight: 600,
};
const chartSubtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
};
const chartEmptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "14px 0",
  color: "#5d6d71",
  fontSize: 13,
  lineHeight: 1.6,
};
const legendStyle: React.CSSProperties = {
  display: "flex",
  gap: 14,
  flexWrap: "wrap",
};
const legendItemStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11.5,
  color: "#475569",
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
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(15, 23, 42, 0.02)",
  textDecoration: "none",
  color: "inherit",
};
const typeBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 30,
  borderRadius: 7,
  background: "rgba(79, 70, 229, 0.08)",
  color: "#4338ca",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  flexShrink: 0,
};
const recentTitleStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const recentMetaStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 11,
  color: "#94a3b8",
};
const recentChipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "3px 9px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
  flexShrink: 0,
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
