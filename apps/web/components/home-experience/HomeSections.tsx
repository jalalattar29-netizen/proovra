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

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { apiFetch } from "../../lib/api";

import type {
  ActiveMatterRow,
  ActivityGroup,
  CaseHealthSummary,
  ChecklistStep,
  HeroAction,
  IntakePipeline,
  OperationalQueueItem,
  ReportProduction,
  StorageUsage,
  TeamWork,
  TrustState,
  VerificationHealth,
  WorkspaceHealthMetric,
} from "./home-view-model";
import {
  HOME_COLORS,
  HOME_TINTS,
  homeCardCtaStyle,
  homeCardHeaderStyle,
  homeCardStyle,
  homeCardTitleStyle,
  toneColor,
  type HomeTone,
} from "./home-theme";

// ============================================================================
// Shared primitives
// ============================================================================

function SectionCard({
  title,
  cta,
  children,
  testId,
}: {
  title: string;
  cta?: { label: string; href: string } | null;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="home-card" data-self-serve-section={testId} style={cardStyle}>
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>{title}</h2>
        {cta ? (
          <Link href={cta.href} style={cardCtaStyle}>
            {cta.label} →
          </Link>
        ) : null}
      </header>
      <div style={cardBodyStyle}>{children}</div>
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
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
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
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
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
// 1. OPERATIONAL QUEUE — the most important widget. What needs action now.
// ============================================================================

function severityStyle(sev: OperationalQueueItem["severity"]): {
  bg: string;
  border: string;
  fg: string;
  chipLabel: string;
} {
  if (sev === "critical")
    return { bg: "#fef2f2", border: "rgba(220,38,38,0.28)", fg: HOME_COLORS.dangerDeep, chipLabel: "Critical" };
  if (sev === "warn")
    return { bg: "#fffaf0", border: "rgba(217,119,6,0.28)", fg: HOME_COLORS.warnDeep, chipLabel: "Needs attention" };
  return { bg: "rgba(79,70,229,0.05)", border: "rgba(79,70,229,0.22)", fg: "#4338ca", chipLabel: "Action" };
}

function QueueRow({
  item,
  prominent,
  workspaceId,
  onChanged,
}: {
  item: OperationalQueueItem;
  prominent: boolean;
  workspaceId: string | null;
  onChanged?: () => void;
}) {
  const s = severityStyle(item.severity);
  return (
    <li
      data-queue-item={item.id}
      data-queue-type={item.type}
      data-queue-severity={item.severity}
      data-queue-fallback={String(item.fallback)}
      style={{
        listStyle: "none",
        padding: prominent ? "14px 16px" : "10px 12px",
        borderRadius: 12,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderLeft: `4px solid ${s.fg}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            data-queue-priority-chip={item.severity}
            style={{ ...chipStyle, background: s.fg, color: "white", fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }}
          >
            {s.chipLabel}
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, color: s.fg, textTransform: "uppercase" }}>
            {item.label}
          </span>
        </span>
        <span style={listItemTimeStyle}>{item.occurredAt ? formatRelative(item.occurredAt) : ""}</span>
      </div>
      <div style={{ fontSize: prominent ? 16 : 14, fontWeight: 650, color: HOME_COLORS.ink, margin: "5px 0 8px 0" }}>
        {item.title}
      </div>
      {item.breakdown && item.breakdown.length > 0 ? (
        <div data-queue-breakdown style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 9px 0" }}>
          {item.breakdown.map((b) => (
            <span key={b} style={{ ...chipStyle, background: "rgba(255,255,255,0.75)", color: s.fg, border: `1px solid ${s.border}` }}>
              {b}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {item.action.kind === "retry_delivery" && item.action.messageId ? (
          <RetryDeliveryButton
            messageId={item.action.messageId}
            workspaceId={workspaceId}
            fallbackHref={item.action.href}
            onRetried={onChanged}
          />
        ) : (
          <Link
            href={item.action.href}
            data-queue-action={item.fallback ? "navigate-fallback" : "navigate"}
            style={{ ...secondaryButtonStyle, background: s.fg, color: "white", border: `1px solid ${s.fg}` }}
          >
            {item.action.label}
          </Link>
        )}
      </div>
    </li>
  );
}

export function OperationalQueue({
  items,
  hero,
  workspaceId,
  onChanged,
}: {
  items: OperationalQueueItem[];
  hero: HeroAction;
  workspaceId: string | null;
  onChanged?: () => void;
}) {
  return (
    <section
      data-self-serve-section="operational-queue"
      data-queue-count={items.length}
      style={{ ...cardStyle, padding: 18 }}
    >
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>
          {items.length > 0 ? `Operational queue · ${items.length}` : "Operational queue"}
        </h2>
      </header>
      {items.length === 0 ? (
        // Nothing needs action — show the onboarding/caught-up primary.
        <HeroNextAction action={hero} />
      ) : (
        <>
          {/* Phase HOME-POLISH — top 3 only; the queue stays scannable. */}
          <ul style={{ ...listStyle, gap: 8 }}>
            {items.slice(0, 3).map((item, i) => (
              <QueueRow
                key={item.id}
                item={item}
                prominent={i === 0}
                workspaceId={workspaceId}
                onChanged={onChanged}
              />
            ))}
          </ul>
          {items.length > 3 ? (
            <Link
              href="/inbox"
              data-queue-more={items.length - 3}
              style={{ display: "inline-block", marginTop: 10, fontSize: 12, fontWeight: 600, color: HOME_COLORS.indigo, textDecoration: "none" }}
            >
              +{items.length - 3} more in your inbox →
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}

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
        <Link href={fallbackHref} style={{ ...listItemTimeStyle, color: "#4f46e5", fontWeight: 600 }} data-delivery-retry-fallback>
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
          {rows.map((r) => {
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
                <Link href={r.href} style={listItemLinkStyle}>
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
                        title={`${r.reportsReadyCount} with reports · ${r.packagesReadyCount} with packages · ${r.verifyLiveCount} verifiable`}
                      >
                        R {r.reportsReadyCount} · P {r.packagesReadyCount} · V {r.verifyLiveCount}
                      </span>
                    ) : null}
                    {r.hasActiveLegalHold ? <span style={chipStyle}>Legal hold</span> : null}
                    <span style={listItemTimeStyle}>
                      {r.evidenceCount} {r.evidenceCount === 1 ? "record" : "records"}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 3. INTAKE PIPELINE — the collection lifecycle, not a link count.
// ============================================================================

function StageChip({ label, count, tone, last }: { label: string; count: number; tone: string; last: boolean }) {
  const fg = tone === "danger" ? "#991b1b" : tone === "warn" ? "#9a3412" : tone === "ok" ? "#166534" : "#0f172a";
  const bg = tone === "danger" ? "#fef2f2" : tone === "warn" ? "#fffbeb" : tone === "ok" ? "#f0fdf4" : "#f8fafc";
  return (
    <>
      <div data-intake-stage={label} style={{ flex: "1 1 0", minWidth: 0, padding: "6px 6px", borderRadius: 8, background: bg, textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: fg }}>{count}</div>
        <div style={{ fontSize: 10, color: "#5d6d71", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      </div>
      {!last ? <span aria-hidden style={{ color: "#cbd5e1", alignSelf: "center", fontSize: 12 }}>→</span> : null}
    </>
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
      <SectionCard title="Intake pipeline" testId="intake-pipeline">
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
      <SectionCard title="Intake pipeline" testId="intake-pipeline">
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
    <SectionCard title="Intake pipeline" testId="intake-pipeline">
      {/* Lifecycle visual — every count a real number. */}
      <div data-intake-stages style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {pipeline.stages.map((st, i) => (
          <StageChip key={st.key} label={st.label} count={st.count} tone={st.tone} last={i === pipeline.stages.length - 1} />
        ))}
      </div>
      {pipeline.links.length > 0 ? (
        <ul style={listStyle}>
          {pipeline.links.map((r) => {
            const failed = r.delivery?.failed === true;
            return (
              <li key={r.id} data-collection-id={r.id} style={{ ...listItemStyle, ...listItemLinkStyle }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span style={listItemTitleStyle}>{r.label}</span>
                  <span style={listItemTimeStyle}>
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
                      style={{
                        ...chipStyle,
                        background: failed ? "#fee2e2" : r.delivery.statusLabel === "Delivered" ? "#dcfce7" : "rgba(79,70,229,0.08)",
                        color: failed ? "#991b1b" : r.delivery.statusLabel === "Delivered" ? "#166534" : "#4338ca",
                      }}
                    >
                      {r.delivery.channel} · {r.delivery.statusLabel}
                      {/* Ticket 4 — delivery.at was mapped but never
                          rendered; shows when the last attempt happened. */}
                      {r.delivery.at ? ` · ${formatRelative(r.delivery.at)}` : ""}
                    </span>
                  ) : (
                    <span style={chipStyle}>Not yet sent</span>
                  )}
                  {failed && r.delivery ? (
                    <RetryDeliveryButton
                      messageId={r.delivery.messageId}
                      workspaceId={workspaceId}
                      fallbackHref={r.href}
                      onRetried={onChanged}
                    />
                  ) : (
                    <Link href={r.href} style={{ ...listItemTimeStyle, color: "#4f46e5", fontWeight: 600 }}>
                      Open →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SectionCard>
  );
}

// ============================================================================
// 4. REPORT PRODUCTION — ready / pending / failed deliverable status.
// ============================================================================

function ProductionStat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "ok" }) {
  const active = value > 0;
  const fg = tone === "danger" && active ? "#991b1b" : tone === "ok" && active ? "#166534" : "#0f172a";
  const bg = tone === "danger" && active ? "#fef2f2" : tone === "ok" && active ? "#f0fdf4" : "#f8fafc";
  return (
    <div data-report-stat={label} style={{ flex: "1 1 0", minWidth: 0, padding: "6px 8px", borderRadius: 8, background: bg, textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: fg }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "#5d6d71", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
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
  return (
    <SectionCard title="Report production" testId="report-production">
      <div data-report-production-stats style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <ProductionStat label="Reports ready" value={production.reportsReady} tone="ok" />
        <ProductionStat label="Packages ready" value={production.packagesReady} tone="ok" />
        <ProductionStat label="Pending" value={production.reportsPending + production.packagesPending} />
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
                <Link href={i.href} style={{ fontSize: 12, fontWeight: 650, color: HOME_COLORS.indigo, textDecoration: "none" }}>
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
        <ul style={listStyle}>
          {production.recent.map((r) => (
            <li key={r.evidenceId} style={{ ...listItemStyle, ...listItemLinkStyle }} data-report-evidence-id={r.evidenceId}>
              <Link href={r.actions.open} style={{ ...listItemTitleStyle, textDecoration: "none" }} data-report-action="open">
                {r.evidenceTitle}
              </Link>
              <span style={listItemMetaStyle}>
                <span style={chipStyle}>Report{r.version != null ? ` v${r.version}` : ""}</span>
                {r.packageReady ? <span style={chipStyle}>Package</span> : null}
                <span style={listItemTimeStyle}>{formatRelative(r.generatedAtUtc)}</span>
              </span>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }} data-report-actions>
                <Link href={r.actions.open} style={secondaryButtonStyle} data-report-action="open-evidence">
                  Open
                </Link>
                {r.actions.reportPdf ? (
                  <a href={r.actions.reportPdf} style={secondaryButtonStyle} data-report-action="download-pdf">
                    Download PDF
                  </a>
                ) : null}
                {r.actions.packageZip ? (
                  <a href={r.actions.packageZip} style={secondaryButtonStyle} data-report-action="download-package">
                    Download package
                  </a>
                ) : null}
                {r.actions.verify ? (
                  <a href={r.actions.verify} style={secondaryButtonStyle} data-report-action="open-verify">
                    Verify page
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 5. VERIFICATION HEALTH — can others verify my evidence?
// ============================================================================

function VerifyStat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "ok" }) {
  const active = value > 0;
  const fg = tone === "danger" && active ? "#991b1b" : tone === "ok" && active ? "#166534" : "#0f172a";
  const bg = tone === "danger" && active ? "#fef2f2" : tone === "ok" && active ? "#f0fdf4" : "#f8fafc";
  return (
    <div data-verify-stat={label} style={{ flex: "1 1 0", minWidth: 0, padding: "6px 8px", borderRadius: 8, background: bg, textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: fg }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "#5d6d71", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
    </div>
  );
}

export function VerificationHealthCard({ health }: { health: VerificationHealth }) {
  return (
    <SectionCard title="Verification health" testId="verification-health">
      {health.empty ? (
        <p data-verify-empty style={{ margin: "0 0 10px 0", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          Public verification links appear once you publish a record — letting anyone independently
          confirm your evidence.
        </p>
      ) : null}
      {/* Phase HOME-POLISH — Live verification is PROOVRA's public
          face: it gets the hero treatment, not a flat tile. */}
      <div data-verify-stats style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div
          data-verify-stat="Live"
          style={{
            flex: "1.4 1 0",
            minWidth: 0,
            padding: "10px 12px",
            borderRadius: 12,
            background: `linear-gradient(145deg, ${HOME_TINTS.teal} 0%, rgba(14,116,144,0.03) 100%)`,
            border: "1px solid rgba(14,116,144,0.18)",
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 780, color: HOME_COLORS.teal, lineHeight: 1 }}>
            {health.live}
          </div>
          <div style={{ fontSize: 11, color: HOME_COLORS.slate, marginTop: 4 }}>
            verification page{health.live === 1 ? "" : "s"} live
          </div>
        </div>
        <VerifyStat label="Not published" value={health.unpublished} />
        <VerifyStat label="Suspended" value={health.suspended} tone="danger" />
      </div>
      {/* Phase HOME-INTELLIGENCE — cross-signal verification issues
          (package↔publish and report↔package gaps), real counts only. */}
      {health.issues.length > 0 ? (
        <ul data-verify-issues style={{ ...listStyle, marginTop: 10, gap: 5 }}>
          {health.issues.map((i) => {
            const c = toneColor(i.tone === "action" ? "neutral" : i.tone);
            return (
              <li key={i.key} data-verify-issue={i.key} style={{ ...listItemStyle, display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, background: c.bg }}>
                <span style={{ flex: 1, fontSize: 12.5, color: c.fg, fontWeight: 600 }}>
                  {i.count} · {i.label}
                </span>
                <Link href={i.href} style={{ fontSize: 12, fontWeight: 650, color: HOME_COLORS.indigo, textDecoration: "none" }}>
                  {i.actionLabel} →
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {health.unpublished > 0 ? (
        <Link
          href="/evidence"
          data-verify-publish
          style={{ ...secondaryButtonStyle, marginTop: 10, background: "#4f46e5", color: "white", border: "1px solid #4f46e5" }}
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
              <li key={pub.href + pub.occurredAt} style={{ ...listItemStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: HOME_TINTS.teal }}>
                <Link href={pub.href} style={{ ...listItemTitleStyle, textDecoration: "none", color: HOME_COLORS.teal, fontSize: 12.5 }}>
                  {pub.label}
                </Link>
                <span style={listItemTimeStyle}>{formatRelative(pub.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {health.verifiable.length > 0 ? (
        <ul style={{ ...listStyle, marginTop: 10, gap: 4 }}>
          {health.verifiable.map((v) => (
            <li key={v.evidenceId} data-verifiable-id={v.evidenceId} style={{ ...listItemStyle, padding: "6px 8px", borderRadius: 6, background: "#f8fafc", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={listItemTitleStyle}>{v.title}</span>
              <a href={v.verifyHref} data-verify-open style={{ ...listItemTimeStyle, color: "#4f46e5", fontWeight: 600 }}>
                Open verify →
              </a>
            </li>
          ))}
        </ul>
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

export function WorkspaceHealthCard({
  metrics,
  overall,
}: {
  metrics: WorkspaceHealthMetric[];
  overall: "healthy" | "needs_attention" | "action_required";
}) {
  const verdict = HEALTH_OVERALL[overall];
  const vc = toneColor(verdict.tone);
  return (
    <SectionCard title="Workspace health" testId="workspace-health">
      {/* Phase HOME-POLISH — one overall verdict derived from the
          metric tones, then the health board. */}
      <div
        data-health-overall={overall}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 10,
          background: vc.bg,
          marginBottom: 10,
        }}
      >
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: 999, background: vc.dot }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: vc.fg }}>{verdict.label}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {metrics.map((m) => {
          const c = toneColor(m.tone);
          return (
            <div key={m.key} data-health-metric={m.key} data-health-tone={m.tone} style={{ padding: "8px 10px", borderRadius: 10, background: c.bg, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: HOME_COLORS.slate }}>{m.label}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: c.fg }}>{m.value}</span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ============================================================================
// 7. TRUST STATE — live integrity counts + zero scaffold.
// ============================================================================

function trustRows(
  trust: TrustState,
): Array<{ key: string; label: string; value: string; tone: "ok" | "warn" | "danger" | "neutral" }> {
  const rows: Array<{ key: string; label: string; value: string; tone: "ok" | "warn" | "danger" | "neutral" }> = [
    {
      key: "tsa",
      label: "Trusted timestamps (TSA)",
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
    { key: "verify", label: "Public verification live", value: `${trust.verifyPublished}`, tone: "neutral" },
  ];
  if (trust.verifySuspended > 0) {
    rows.push({ key: "verify-suspended", label: "Public verification suspended", value: `${trust.verifySuspended}`, tone: "danger" });
  }
  if (trust.needingAttention > 0) {
    rows.push({ key: "attention", label: "Records needing attention", value: `${trust.needingAttention}`, tone: "danger" });
  }
  return rows;
}

export function TrustStateCard({ trust }: { trust: TrustState }) {
  const rows = trustRows(trust);
  return (
    <SectionCard title="Trust state" testId="trust-state">
      {trust.empty ? (
        <p data-trust-empty style={{ margin: "0 0 10px 0", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          No evidence captured yet — these are the integrity signals each record will earn once
          captured.
        </p>
      ) : null}
      <ul style={{ ...listStyle, gap: 4 }}>
        {rows.map((r) => (
          <li
            key={r.key}
            data-trust-key={r.key}
            style={{
              ...listItemStyle,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 10px",
              borderRadius: 6,
              background: r.tone === "danger" ? "#fef2f2" : r.tone === "warn" ? "#fffbeb" : r.tone === "ok" ? "#f0fdf4" : "#f8fafc",
            }}
          >
            <span style={{ fontSize: 13, color: "#0f172a" }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: r.tone === "danger" ? "#991b1b" : r.tone === "warn" ? "#9a3412" : r.tone === "ok" ? "#166534" : "#0f172a" }}>
              {r.value}
            </span>
          </li>
        ))}
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
      <p style={{ marginTop: 10, fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
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
    evidence_finalized: "#4f46e5",
    report_generated: "#16a34a",
    package_generated: "#0d9488",
    verification_published: "#0e7490",
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
      {groups.map((g) => (
        <div key={g.key} data-activity-group={g.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.4, margin: "4px 0" }}>
            {g.label}
          </div>
          {/* Phase HOME-POLISH — timeline treatment: dot column with a
              connecting rail, not a flat list. */}
          <ul style={{ ...listStyle, gap: 0, borderLeft: "2px solid rgba(15,23,42,0.07)", marginLeft: 4, paddingLeft: 0 }}>
            {g.events.map((e) => (
              <li key={e.id} data-activity-kind={e.kind} style={{ ...listItemStyle, padding: "5px 8px 5px 0" }}>
                <Link href={e.href} style={{ display: "flex", gap: 10, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                  <span
                    aria-hidden
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      background: activityDot(e.kind),
                      flex: "0 0 auto",
                      marginLeft: -5.5,
                      border: "2px solid white",
                      boxShadow: "0 0 0 1px rgba(15,23,42,0.06)",
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 13, color: HOME_COLORS.ink, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {e.label}
                    {/* Phase HOME-INTELLIGENCE — collapsed repeats. */}
                    {e.repeatCount && e.repeatCount > 1 ? (
                      <span data-activity-repeat={e.repeatCount} style={{ color: HOME_COLORS.muted, fontWeight: 600 }}>
                        {" "}×{e.repeatCount}
                      </span>
                    ) : null}
                  </span>
                  <span style={listItemTimeStyle}>{formatRelative(e.occurredAt)}</span>
                </Link>
              </li>
            ))}
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
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: "#0f172a" }}>{usage.usedLabel ?? "—"}</span>
            <span style={{ fontSize: 13, color: "#5d6d71" }}>
              of {usage.limitLabel ?? "—"} {usage.usagePercent != null ? `· ${usage.usagePercent}%` : ""}
            </span>
          </div>
          <div
            data-storage-bar
            data-storage-near-limit={String(usage.nearLimit)}
            data-storage-limit-reached={String(usage.limitReached)}
            style={{ width: "100%", height: 8, borderRadius: 4, background: "#e2e8f0", overflow: "hidden" }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, usage.usagePercent ?? 0))}%`,
                height: "100%",
                background: usage.limitReached ? "#dc2626" : usage.nearLimit ? "#d97706" : "#4f46e5",
                transition: "width 200ms ease",
              }}
            />
          </div>
          {usage.forecastRecords != null && !usage.limitReached ? (
            <p data-storage-forecast={usage.forecastRecords} style={{ margin: "10px 0 0 0", fontSize: 12, color: "#5d6d71" }}>
              Room for ≈ {usage.forecastRecords.toLocaleString()} more record
              {usage.forecastRecords === 1 ? "" : "s"} at your current average size.
            </p>
          ) : null}
          {usage.nearLimit || usage.limitReached ? (
            <p style={{ margin: "12px 0 0 0", fontSize: 13, color: usage.limitReached ? "#991b1b" : "#9a3412" }}>
              {usage.limitReached
                ? "Storage limit reached — top up or upgrade to keep capturing."
                : "Approaching your storage limit."}{" "}
              <Link href={usage.upgradeHref} data-storage-upgrade style={{ color: usage.limitReached ? "#991b1b" : "#9a3412", fontWeight: 600 }}>
                Manage plan →
              </Link>
            </p>
          ) : null}
        </>
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
const cardStyle: React.CSSProperties = homeCardStyle;
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
const chipStyle: React.CSSProperties = { display: "inline-block", padding: "2px 8px", borderRadius: 999, background: "rgba(79, 70, 229, 0.08)", color: "#4338ca", fontSize: 11, fontWeight: 600 };

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
