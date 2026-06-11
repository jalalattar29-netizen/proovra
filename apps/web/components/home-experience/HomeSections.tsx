/**
 * Phase IA-home-v2 — workflow-centric Home section components.
 *
 * Every section is wired to a real view-model slice. No static trust
 * copy, no nav-duplicating quick actions, no invented metrics. Each
 * component renders an honest empty state when its slice is genuinely
 * empty.
 */

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type {
  ActivityGroup,
  CaseHealthRow,
  ChecklistStep,
  CollectionRow,
  HeroAction,
  RecentEvidenceRow,
  RecentReportRow,
  StorageUsage,
  SubmissionRow,
  TeamWork,
  TrustState,
  WorkflowLauncher,
} from "./home-view-model";

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

function humanize(raw: string): string {
  return raw.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================================
// 0. Workflow launchers (replaces nav-duplicating Quick Actions)
// ============================================================================

export function WorkflowLaunchers({ launchers }: { launchers: WorkflowLauncher[] }) {
  const visible = launchers.filter((l) => l.visible);
  if (visible.length === 0) return null;
  return (
    <nav data-self-serve-section="workflow-launchers" aria-label="Start a workflow" style={launcherRowStyle}>
      {visible.map((l) => (
        <Link key={l.key} href={l.href} data-launcher-key={l.key} style={launcherStyle}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

// ============================================================================
// 1. Hero — Next Action (expanded)
// ============================================================================

export function HeroNextAction({ action }: { action: HeroAction }) {
  const bg =
    action.tone === "warn" ? "#fffbeb" : action.tone === "action" ? "#eef2ff" : "#f8fafc";
  const border =
    action.tone === "warn" ? "#fcd34d" : action.tone === "action" ? "#c7d2fe" : "#e2e8f0";
  return (
    <section
      data-self-serve-section="hero-next-action"
      data-hero-kind={action.kind}
      style={{ ...cardStyle, background: bg, border: `1px solid ${border}`, padding: 24 }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "#475569", textTransform: "uppercase" }}>
        {action.kind === "caught_up" ? "All caught up" : "What needs you"}
      </div>
      <h1 style={{ margin: "8px 0 6px 0", fontSize: 22, fontWeight: 700, color: "#0f172a" }}>
        {action.title}
      </h1>
      <p style={{ margin: "0 0 16px 0", fontSize: 14, color: "#475569", lineHeight: 1.5 }}>
        {action.detail}
      </p>
      <Link href={action.href} data-hero-href={action.href} style={primaryButtonStyle}>
        {action.ctaLabel}
      </Link>
    </section>
  );
}

// ============================================================================
// 2. Submissions needing review
// ============================================================================

export function SubmissionsToReview({ rows }: { rows: SubmissionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <SectionCard
      title={`Submissions needing review · ${rows.length}`}
      cta={{ label: "All requests", href: "/evidence-requests" }}
      testId="submissions-to-review"
    >
      <ul style={listStyle}>
        {rows.map((r) => (
          <li
            key={r.id}
            data-submission-id={r.id}
            data-submission-overdue={String(r.overdue)}
            style={{ ...listItemStyle, ...listItemLinkStyle, borderLeft: `3px solid ${r.overdue ? "#dc2626" : "#4f46e5"}` }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={listItemTitleStyle}>{r.title}</span>
              <span style={listItemTimeStyle}>{formatRelative(r.receivedAt)}</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <span style={chipStyle}>{r.statusLabel}</span>
              {r.overdue ? <span style={{ ...chipStyle, background: "#fee2e2", color: "#991b1b" }}>Overdue</span> : null}
              <Link href={r.href} style={secondaryButtonStyle} data-submission-action="review">
                Review
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ============================================================================
// 3. Request & Collect
// ============================================================================

export function RequestAndCollect({ rows }: { rows: CollectionRow[] }) {
  return (
    <SectionCard
      title="Request & collect"
      cta={{ label: "Manage intake links", href: "/intake-links" }}
      testId="request-and-collect"
    >
      {rows.length === 0 ? (
        <EmptyState>
          No active intake links. Create one to request evidence from a client, source,
          witness, or contributor.
        </EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li key={r.id} data-collection-id={r.id} style={{ ...listItemStyle, ...listItemLinkStyle }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={listItemTitleStyle}>{r.label}</span>
                <span style={listItemTimeStyle}>
                  {r.usedCount}
                  {r.maxUses != null ? ` / ${r.maxUses}` : ""} used
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                {r.delivery ? (
                  <span
                    data-delivery-status={r.delivery.status}
                    style={{
                      ...chipStyle,
                      background:
                        r.delivery.statusLabel === "Delivered"
                          ? "#dcfce7"
                          : r.delivery.statusLabel === "Failed"
                            ? "#fee2e2"
                            : "rgba(79,70,229,0.08)",
                      color:
                        r.delivery.statusLabel === "Delivered"
                          ? "#166534"
                          : r.delivery.statusLabel === "Failed"
                            ? "#991b1b"
                            : "#4338ca",
                    }}
                  >
                    {r.delivery.channel} · {r.delivery.statusLabel}
                  </span>
                ) : (
                  <span style={chipStyle}>Not yet sent</span>
                )}
                <Link href={r.href} style={{ ...listItemTimeStyle, color: "#4f46e5", fontWeight: 600 }}>
                  Open →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 4. Recent Evidence — with REAL integrity verdict chip
// ============================================================================

function verificationChip(v: string | null, needsAttention: boolean): { label: string; bg: string; fg: string } {
  if (needsAttention) return { label: "Needs attention", bg: "#fef3c7", fg: "#92400e" };
  const u = (v ?? "").toUpperCase();
  if (u === "VERIFIED" || u === "OK") return { label: "Verified", bg: "#dcfce7", fg: "#166534" };
  if (u === "REVIEW_REQUIRED") return { label: "Review required", bg: "#fef3c7", fg: "#92400e" };
  if (u === "FAILED") return { label: "Integrity failed", bg: "#fee2e2", fg: "#991b1b" };
  if (u === "PENDING") return { label: "Pending", bg: "#e0e7ff", fg: "#3730a3" };
  return { label: "—", bg: "#f1f5f9", fg: "#475569" };
}

export function RecentEvidence({ rows }: { rows: RecentEvidenceRow[] }) {
  return (
    <SectionCard title="Recent evidence" cta={{ label: "View all evidence", href: "/evidence" }} testId="recent-evidence">
      {rows.length === 0 ? (
        <EmptyState>Upload or capture your first evidence record.</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => {
            const chip = verificationChip(r.verificationStatus, r.needsAttention);
            return (
              <li key={r.id} style={listItemStyle}>
                <Link href={r.href} style={listItemLinkStyle} data-evidence-id={r.id}>
                  <span style={listItemTitleStyle}>{r.title}</span>
                  <span style={listItemMetaStyle}>
                    <span style={chipStyle}>{humanize(r.status)}</span>
                    <span
                      data-evidence-verification={chip.label}
                      style={{ ...chipStyle, background: chip.bg, color: chip.fg }}
                    >
                      {chip.label}
                    </span>
                    <span style={listItemTimeStyle}>{formatRelative(r.createdAt)}</span>
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
// 5. Case Health
// ============================================================================

export function CaseHealthCard({ rows }: { rows: CaseHealthRow[] }) {
  return (
    <SectionCard title="Case health" cta={{ label: "All cases", href: "/cases" }} testId="case-health">
      {rows.length === 0 ? (
        <EmptyState>No cases need attention. Incomplete matters will appear here.</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li key={r.caseId} style={listItemStyle}>
              <Link href={r.href} style={listItemLinkStyle} data-case-id={r.caseId}>
                <span style={listItemTitleStyle}>{r.caseName}</span>
                <span style={listItemMetaStyle}>
                  <span style={{ ...chipStyle, background: "#fef3c7", color: "#92400e" }}>{r.reason}</span>
                  {r.hasActiveLegalHold ? <span style={chipStyle}>Legal hold</span> : null}
                  <span style={listItemTimeStyle}>
                    {r.evidenceCount} {r.evidenceCount === 1 ? "record" : "records"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 6. Recent Reports
// ============================================================================

export function RecentReports({ rows, isFreePlan }: { rows: RecentReportRow[]; isFreePlan: boolean }) {
  const emptyCopy = isFreePlan
    ? "Reports are included with Pay-Per-Evidence, Pro, and Team."
    : "Complete an evidence record to generate your first report.";
  return (
    <SectionCard title="Recent reports" cta={{ label: "Open Reports", href: "/reports" }} testId="recent-reports">
      {rows.length === 0 ? (
        <EmptyState>{emptyCopy}</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
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
// 7. Trust State — LIVE counts (merged Health + Trust)
// ============================================================================

export function TrustStateCard({ trust }: { trust: TrustState }) {
  if (trust.empty) {
    return (
      <SectionCard title="Trust state" testId="trust-state">
        <EmptyState>
          Once you capture evidence, this card shows live trust posture — trusted
          timestamps, on-chain anchors, signatures and public verification.
        </EmptyState>
      </SectionCard>
    );
  }
  const rows: Array<{ key: string; label: string; value: string; tone: "ok" | "warn" | "danger" | "neutral" }> = [
    {
      key: "tsa",
      label: "Trusted timestamps (TSA)",
      value: `${trust.tsaStamped} stamped${trust.tsaPending ? ` · ${trust.tsaPending} pending` : ""}${trust.tsaFailed ? ` · ${trust.tsaFailed} failed` : ""}`,
      tone: trust.tsaFailed > 0 ? "danger" : trust.tsaPending > 0 ? "warn" : "ok",
    },
    {
      key: "ots",
      label: "OpenTimestamps (OTS)",
      value: `${trust.otsAnchored} anchored${trust.otsPending ? ` · ${trust.otsPending} pending` : ""}${trust.otsFailed ? ` · ${trust.otsFailed} failed` : ""}`,
      tone: trust.otsFailed > 0 ? "danger" : trust.otsPending > 0 ? "warn" : "ok",
    },
    { key: "signed", label: "Signed records", value: `${trust.signed} of ${trust.totalEvidence}`, tone: "neutral" },
    { key: "verify", label: "Public verification live", value: `${trust.verifyPublished}`, tone: "neutral" },
  ];
  if (trust.needingAttention > 0) {
    rows.push({
      key: "attention",
      label: "Records needing attention",
      value: `${trust.needingAttention}`,
      tone: "danger",
    });
  }
  return (
    <SectionCard title="Trust state" cta={{ label: "View evidence", href: "/evidence" }} testId="trust-state">
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
              background:
                r.tone === "danger" ? "#fef2f2" : r.tone === "warn" ? "#fffbeb" : r.tone === "ok" ? "#f0fdf4" : "#f8fafc",
            }}
          >
            <span style={{ fontSize: 13, color: "#0f172a" }}>{r.label}</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: r.tone === "danger" ? "#991b1b" : r.tone === "warn" ? "#9a3412" : r.tone === "ok" ? "#166534" : "#0f172a",
              }}
            >
              {r.value}
            </span>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: 10, fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
        PROOVRA records integrity signals; it does not determine factual truth or legal
        admissibility.
      </p>
    </SectionCard>
  );
}

// ============================================================================
// 8. Activity — grouped by Today / Yesterday / Earlier
// ============================================================================

function activityDot(kind: string): string {
  const map: Record<string, string> = {
    evidence_finalized: "#4f46e5",
    report_generated: "#16a34a",
    package_generated: "#0d9488",
    hold_placed: "#9333ea",
    hold_released: "#7c3aed",
    escalation_opened: "#d97706",
    incident_opened: "#dc2626",
    intake_link_created: "#0891b2",
    intake_delivered: "#16a34a",
    intake_failed: "#dc2626",
  };
  return map[kind] ?? "#475569";
}

export function ActivityFeed({ groups }: { groups: ActivityGroup[] }) {
  if (groups.length === 0) {
    return (
      <SectionCard title="Activity" testId="activity">
        <EmptyState>Activity appears here as you capture evidence, generate reports, and collect submissions.</EmptyState>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Activity" testId="activity">
      {groups.map((g) => (
        <div key={g.key} data-activity-group={g.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.4, margin: "4px 0" }}>
            {g.label}
          </div>
          <ul style={{ ...listStyle, gap: 4 }}>
            {g.events.map((e) => (
              <li key={e.id} data-activity-kind={e.kind} style={{ ...listItemStyle, padding: "6px 8px" }}>
                <Link href={e.href} style={{ display: "flex", gap: 10, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: activityDot(e.kind), flex: "0 0 auto" }} />
                  <span style={{ flex: 1, fontSize: 13, color: "#0f172a" }}>{e.label}</span>
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
// 9. Storage
// ============================================================================

export function StorageUsageCard({ usage }: { usage: StorageUsage | null }) {
  return (
    <SectionCard title="Storage" cta={{ label: "Manage in Billing", href: "/billing" }} testId="storage-usage">
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
          {usage.nearLimit || usage.limitReached ? (
            <p style={{ margin: "12px 0 0 0", fontSize: 13, color: usage.limitReached ? "#991b1b" : "#9a3412" }}>
              {usage.limitReached
                ? "Storage limit reached — top up or upgrade to keep capturing."
                : "Approaching your storage limit."}
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

// ============================================================================
// 10. Team work (PRO/TEAM) — work-centric, not roster
// ============================================================================

export function TeamWorkCard({ team }: { team: TeamWork | null }) {
  if (!team) return null;
  return (
    <SectionCard title="Team work" cta={{ label: "Manage teams", href: "/teams" }} testId="team-work">
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
// 11. Getting Started — auto-collapses when complete
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
  // Auto-collapse: when every visible step is done, the whole widget
  // disappears (no permanent "100% complete" clutter).
  if (complete) return null;
  const completedCount = visible.filter((s) => s.done).length;
  return (
    <SectionCard title={`Getting started · ${completedCount}/${visible.length}`} testId="getting-started">
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

const cardStyle: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, margin: 0 };
const cardHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 };
const cardTitleStyle: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: "#0f172a", textTransform: "uppercase", letterSpacing: 0.4 };
const cardCtaStyle: React.CSSProperties = { fontSize: 12, color: "#4f46e5", textDecoration: "none", fontWeight: 600 };
const cardBodyStyle: React.CSSProperties = { margin: 0 };

const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 };
const listItemStyle: React.CSSProperties = { padding: 0 };
const listItemLinkStyle: React.CSSProperties = { display: "block", padding: "8px 10px", borderRadius: 8, background: "rgba(15, 23, 42, 0.02)", textDecoration: "none", color: "inherit" };
const listItemTitleStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const listItemMetaStyle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" };
const listItemTimeStyle: React.CSSProperties = { fontSize: 11, color: "#94a3b8" };
const chipStyle: React.CSSProperties = { display: "inline-block", padding: "2px 8px", borderRadius: 999, background: "rgba(79, 70, 229, 0.08)", color: "#4338ca", fontSize: 11, fontWeight: 600 };

const primaryButtonStyle: React.CSSProperties = { display: "inline-block", padding: "10px 18px", borderRadius: 8, background: "#4f46e5", color: "white", fontWeight: 600, fontSize: 14, textDecoration: "none" };
const secondaryButtonStyle: React.CSSProperties = { display: "inline-block", padding: "5px 10px", borderRadius: 6, background: "white", border: "1px solid #cbd5e1", color: "#0f172a", fontWeight: 600, fontSize: 12, textDecoration: "none" };

const launcherRowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, margin: 0 };
const launcherStyle: React.CSSProperties = { display: "inline-block", padding: "8px 14px", borderRadius: 8, background: "#0f172a", color: "white", fontWeight: 600, fontSize: 13, textDecoration: "none" };

const skeletonRowStyle: React.CSSProperties = { height: 180, borderRadius: 12, background: "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)" };
