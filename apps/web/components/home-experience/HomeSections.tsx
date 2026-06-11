/**
 * Phase IA-self-serve-home-rebuild + Phase IA-home-polish — Home section
 * components.
 *
 * All sections of the self-serve Home live in this file so the
 * presentation tree is reviewable in one place. Each section is a
 * pure presentational component that takes its slice of
 * `HomeViewModel`. Data fetching is upstream in `useHomeData`.
 */

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type {
  ActivityEvent,
  ChecklistStep,
  EvidenceHealth,
  IntegrityAlert,
  NextAction,
  PipelineStageTile,
  QuickAction,
  RecentCaseRow,
  RecentEvidenceRow,
  RecentReportRow,
  SnapshotTile,
  StorageUsage,
  TeamActivity,
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
    <section
      className="home-card"
      data-self-serve-section={testId}
      style={cardStyle}
    >
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
    <p
      style={{
        margin: 0,
        padding: "12px 0",
        color: "#5d6d71",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {children}
    </p>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const deltaMs = Date.now() - t;
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

function humanizeStatus(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================================
// 0. Compact Quick Actions (top of Home)
// ============================================================================

export function CompactQuickActions({ actions }: { actions: QuickAction[] }) {
  const visible = actions.filter((a) => a.visible);
  if (visible.length === 0) return null;
  return (
    <nav
      data-self-serve-section="quick-actions"
      aria-label="Quick actions"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        margin: 0,
      }}
    >
      {visible.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          data-quick-action-key={a.key}
          style={quickActionStyle}
        >
          {a.label}
        </Link>
      ))}
    </nav>
  );
}

// ============================================================================
// 1. Workspace Snapshot — 5 tiles
// ============================================================================

export function WorkspaceSnapshot({ tiles }: { tiles: SnapshotTile[] }) {
  return (
    <section
      className="home-snapshot"
      data-self-serve-section="workspace-snapshot"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
      }}
    >
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          href={tile.href ?? "#"}
          data-snapshot-key={tile.key}
          style={tileLinkStyle}
        >
          <div style={tileValueStyle}>{tile.value}</div>
          <div style={tileLabelStyle}>{tile.label}</div>
          {tile.hint ? <div style={tileHintStyle}>{tile.hint}</div> : null}
        </Link>
      ))}
    </section>
  );
}

// ============================================================================
// 2. Next Action Card
// ============================================================================

export function NextActionCard({ action }: { action: NextAction }) {
  const isCaughtUp = action.kind === "caught_up";
  return (
    <section
      className="home-card home-next-action"
      data-self-serve-section="next-action"
      data-next-action-kind={action.kind}
      style={{
        ...cardStyle,
        background: isCaughtUp ? "#f8fafc" : "#eef2ff",
        border: isCaughtUp ? "1px solid #e2e8f0" : "1px solid #c7d2fe",
      }}
    >
      <header style={cardHeaderStyle}>
        <h2 style={cardTitleStyle}>{isCaughtUp ? "All caught up" : "Next"}</h2>
      </header>
      <div style={cardBodyStyle}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#0f172a" }}>
          {action.label}
        </p>
        <p style={{ margin: "6px 0 14px 0", fontSize: 13, color: "#475569" }}>
          {action.hint}
        </p>
        <Link
          href={action.href}
          data-next-action-href={action.href}
          style={primaryButtonStyle}
        >
          {isCaughtUp ? "Capture something new" : "Open"}
        </Link>
      </div>
    </section>
  );
}

// ============================================================================
// 3. Recent Evidence
// ============================================================================

export function RecentEvidence({ rows }: { rows: RecentEvidenceRow[] }) {
  return (
    <SectionCard
      title="Recent evidence"
      cta={{ label: "View all evidence", href: "/evidence" }}
      testId="recent-evidence"
    >
      {rows.length === 0 ? (
        <EmptyState>Upload or capture your first evidence record.</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li key={r.id} style={listItemStyle}>
              <Link
                href={r.href}
                style={listItemLinkStyle}
                data-evidence-id={r.id}
              >
                <span style={listItemTitleStyle}>{r.title}</span>
                <span style={listItemMetaStyle}>
                  <span style={chipStyle}>{humanizeStatus(r.status)}</span>
                  <span style={listItemTimeStyle}>
                    {formatRelative(r.createdAt)}
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
// 4. Recent Cases
// ============================================================================

export function RecentCases({ rows }: { rows: RecentCaseRow[] }) {
  return (
    <SectionCard
      title="Cases"
      cta={{ label: "View all cases", href: "/cases" }}
      testId="recent-cases"
    >
      {rows.length === 0 ? (
        <EmptyState>Create a case to group related evidence.</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li key={r.caseId} style={listItemStyle}>
              <Link
                href={r.href}
                style={listItemLinkStyle}
                data-case-id={r.caseId}
              >
                <span style={listItemTitleStyle}>{r.caseName}</span>
                <span style={listItemMetaStyle}>
                  <span style={chipStyle}>
                    {r.evidenceCount}{" "}
                    {r.evidenceCount === 1 ? "record" : "records"}
                  </span>
                  <span style={listItemTimeStyle}>
                    {formatRelative(r.lastActivityAtUtc)}
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
// 5. Recent Reports — with per-row actions
// ============================================================================

export function RecentReports({
  rows,
  isFreePlan,
}: {
  rows: RecentReportRow[];
  isFreePlan: boolean;
}) {
  const emptyCopy = isFreePlan
    ? "Reports are included with Pay-Per-Evidence, Pro, and Team."
    : "Complete an evidence record to generate your first report.";
  return (
    <SectionCard
      title="Recent reports"
      cta={{ label: "Open Reports", href: "/reports" }}
      testId="recent-reports"
    >
      {rows.length === 0 ? (
        <EmptyState>{emptyCopy}</EmptyState>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li
              key={r.evidenceId}
              style={{ ...listItemStyle, ...listItemLinkStyle }}
              data-report-evidence-id={r.evidenceId}
            >
              <Link
                href={r.actions.open}
                style={{ ...listItemTitleStyle, textDecoration: "none" }}
                data-report-action="open"
              >
                {r.evidenceTitle}
              </Link>
              <span style={listItemMetaStyle}>
                <span style={chipStyle}>
                  Report{r.version != null ? ` v${r.version}` : ""}
                </span>
                {r.packageReady ? (
                  <span style={chipStyle}>Package</span>
                ) : null}
                <span style={listItemTimeStyle}>
                  {formatRelative(r.generatedAtUtc)}
                </span>
              </span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 8,
                  flexWrap: "wrap",
                }}
                data-report-actions
              >
                <Link
                  href={r.actions.open}
                  style={secondaryButtonStyle}
                  data-report-action="open-evidence"
                >
                  Open
                </Link>
                {r.actions.reportPdf ? (
                  <a
                    href={r.actions.reportPdf}
                    style={secondaryButtonStyle}
                    data-report-action="download-pdf"
                  >
                    Download PDF
                  </a>
                ) : null}
                {r.actions.packageZip ? (
                  <a
                    href={r.actions.packageZip}
                    style={secondaryButtonStyle}
                    data-report-action="download-package"
                  >
                    Download package
                  </a>
                ) : null}
                {r.actions.verify ? (
                  <a
                    href={r.actions.verify}
                    style={secondaryButtonStyle}
                    data-report-action="open-verify"
                  >
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
// 6. Pipeline Snapshot — onboarding fallback when empty
// ============================================================================

export function PipelineSnapshot({
  stages,
  empty,
}: {
  stages: PipelineStageTile[];
  empty: boolean;
}) {
  if (empty) {
    return (
      <SectionCard
        title="Get started"
        cta={{ label: "Capture evidence", href: "/capture" }}
        testId="pipeline-onboarding"
      >
        <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
          Once you capture your first evidence record, this card will show
          how items are moving through the workspace — uploaded, signed,
          timestamped, reported and packaged.
        </p>
        <ul
          style={{
            ...listStyle,
            gap: 4,
            marginTop: 10,
            listStyle: "disc inside",
          }}
        >
          <li style={{ fontSize: 12, color: "#5d6d71" }}>Upload a file or screenshot</li>
          <li style={{ fontSize: 12, color: "#5d6d71" }}>Add details and finalize</li>
          <li style={{ fontSize: 12, color: "#5d6d71" }}>Generate the PDF report</li>
        </ul>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Pipeline" testId="pipeline-snapshot">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 8,
        }}
      >
        {stages.map((s) => (
          <div
            key={s.key}
            data-pipeline-key={s.key}
            style={pipelineTileStyle(s.tone)}
          >
            <div style={pipelineTileValueStyle}>{s.value}</div>
            <div style={pipelineTileLabelStyle}>{s.label}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ============================================================================
// 7. Storage Usage
// ============================================================================

export function StorageUsageCard({
  usage,
}: {
  usage: StorageUsage | null;
}) {
  return (
    <SectionCard
      title="Storage"
      cta={{ label: "Manage in Billing", href: "/billing" }}
      testId="storage-usage"
    >
      {!usage ? (
        <EmptyState>Storage details will appear once your billing is set up.</EmptyState>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 22, fontWeight: 700, color: "#0f172a" }}>
              {usage.usedLabel ?? "—"}
            </span>
            <span style={{ fontSize: 13, color: "#5d6d71" }}>
              of {usage.limitLabel ?? "—"}{" "}
              {usage.usagePercent != null
                ? `· ${usage.usagePercent}%`
                : ""}
            </span>
          </div>
          <div
            data-storage-bar
            data-storage-near-limit={String(usage.nearLimit)}
            data-storage-limit-reached={String(usage.limitReached)}
            style={{
              width: "100%",
              height: 8,
              borderRadius: 4,
              background: "#e2e8f0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, usage.usagePercent ?? 0))}%`,
                height: "100%",
                background: usage.limitReached
                  ? "#dc2626"
                  : usage.nearLimit
                    ? "#d97706"
                    : "#4f46e5",
                transition: "width 200ms ease",
              }}
            />
          </div>
          {usage.nearLimit || usage.limitReached ? (
            <p
              style={{
                margin: "12px 0 0 0",
                fontSize: 13,
                color: usage.limitReached ? "#991b1b" : "#9a3412",
              }}
            >
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
// 8. Team Activity — PRO/TEAM only
// ============================================================================

export function TeamActivityCard({
  team,
}: {
  team: TeamActivity | null;
}) {
  if (!team) return null;
  return (
    <SectionCard
      title="Team activity"
      cta={{ label: "Manage teams", href: "/teams" }}
      testId="team-activity"
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Stat label="Teams" value={team.ownedTeamCount} />
        <Stat label="Members" value={team.totalMemberCount} />
        <Stat label="Pending invites" value={team.pendingInviteCount} />
      </div>
      {team.teams.length === 0 ? (
        <EmptyState>You don&apos;t own a team yet. Create one in Billing.</EmptyState>
      ) : (
        <ul style={listStyle}>
          {team.teams.map((t) => (
            <li key={t.id} style={listItemStyle}>
              <Link
                href={`/teams/${encodeURIComponent(t.id)}`}
                style={listItemLinkStyle}
                data-team-id={t.id}
              >
                <span style={listItemTitleStyle}>{t.name}</span>
                <span style={listItemMetaStyle}>
                  <span style={chipStyle}>
                    {t.memberCount}{" "}
                    {t.memberCount === 1 ? "member" : "members"}
                  </span>
                  {t.role ? <span style={chipStyle}>{t.role}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#5d6d71" }}>{label}</div>
    </div>
  );
}

// ============================================================================
// 9. Integrity Alerts — render only when non-empty
// ============================================================================

export function IntegrityAlerts({
  alerts,
}: {
  alerts: IntegrityAlert[];
}) {
  if (alerts.length === 0) return null;
  return (
    <SectionCard title="Needs attention" testId="integrity-alerts">
      <ul style={listStyle}>
        {alerts.map((a) => (
          <li
            key={a.id}
            style={{
              ...listItemStyle,
              borderLeft: `3px solid ${a.severity === "danger" ? "#dc2626" : "#d97706"}`,
              paddingLeft: 10,
            }}
            data-alert-severity={a.severity}
          >
            <Link href={a.href} style={listItemLinkStyle}>
              <span style={listItemTitleStyle}>{a.title}</span>
              <span
                style={{
                  fontSize: 12,
                  color: "#5d6d71",
                  marginTop: 4,
                  display: "block",
                }}
              >
                {a.body}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ============================================================================
// 10. Getting-started checklist
// ============================================================================

export function GettingStartedChecklist({
  steps,
}: {
  steps: ChecklistStep[];
}) {
  const visible = steps.filter((s) => s.visible);
  if (visible.length === 0) return null;
  const completedCount = visible.filter((s) => s.done).length;
  return (
    <SectionCard
      title={`Getting started · ${completedCount}/${visible.length}`}
      testId="getting-started"
    >
      <ul style={{ ...listStyle, gap: 4 }}>
        {visible.map((s) => (
          <li
            key={s.key}
            data-checklist-step={s.key}
            data-checklist-done={String(s.done)}
            style={{ ...listItemStyle, padding: "8px 10px" }}
          >
            <Link
              href={s.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                textDecoration: "none",
                color: "inherit",
              }}
            >
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
              <span
                style={{
                  fontSize: 13,
                  color: s.done ? "#5d6d71" : "#0f172a",
                  textDecoration: s.done ? "line-through" : "none",
                }}
              >
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
// 11. Trust Summary — concise card
// ============================================================================

export function TrustSummary() {
  return (
    <SectionCard title="Trust" testId="trust-summary">
      <ul
        style={{
          ...listStyle,
          gap: 2,
          padding: 0,
          listStyle: "disc inside",
        }}
      >
        <li style={{ fontSize: 12, color: "#475569" }}>
          Digital signatures
        </li>
        <li style={{ fontSize: 12, color: "#475569" }}>
          Trusted timestamps
        </li>
        <li style={{ fontSize: 12, color: "#475569" }}>
          Public verification
        </li>
        <li style={{ fontSize: 12, color: "#475569" }}>
          Storage protection
        </li>
        <li style={{ fontSize: 12, color: "#475569" }}>
          Reports and packages
        </li>
      </ul>
      <p style={{ marginTop: 10, fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
        PROOVRA records integrity signals; it does not determine factual
        truth or legal admissibility.
      </p>
    </SectionCard>
  );
}

// ============================================================================
// 12. Recent Activity timeline
// ============================================================================

export function RecentActivity({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <SectionCard title="Activity" testId="recent-activity">
        <EmptyState>Activity will appear here as you upload evidence and generate reports.</EmptyState>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Activity" testId="recent-activity">
      <ul style={{ ...listStyle, gap: 4 }}>
        {events.map((e) => (
          <li
            key={e.id}
            data-activity-kind={e.kind}
            style={{ ...listItemStyle, padding: "6px 8px" }}
          >
            <Link
              href={e.href}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <span style={activityDotStyle(e.kind)} aria-hidden />
              <span style={{ flex: 1, fontSize: 13, color: "#0f172a" }}>
                {e.label}
              </span>
              <span style={listItemTimeStyle}>
                {formatRelative(e.occurredAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function activityDotStyle(kind: ActivityEvent["kind"]): React.CSSProperties {
  const colorMap: Record<ActivityEvent["kind"], string> = {
    evidence_uploaded: "#4f46e5",
    evidence_timestamped: "#0891b2",
    report_generated: "#16a34a",
    package_ready: "#0d9488",
    verification_published: "#7c3aed",
    case_updated: "#475569",
  };
  return {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: colorMap[kind],
    flex: "0 0 auto",
  };
}

// ============================================================================
// 13. Evidence Health widget
// ============================================================================

export function EvidenceHealthCard({
  health,
}: {
  health: EvidenceHealth;
}) {
  const rows: Array<{
    key: string;
    label: string;
    count: number;
    tone: "ok" | "warn" | "danger";
  }> = [];
  if (health.complete > 0) {
    rows.push({
      key: "complete",
      label: "Complete records",
      count: health.complete,
      tone: "ok",
    });
  }
  if (health.needsReport > 0) {
    rows.push({
      key: "needs_report",
      label: "Need a report",
      count: health.needsReport,
      tone: "warn",
    });
  }
  if (health.timestampIssues > 0) {
    rows.push({
      key: "timestamp_issues",
      label: "Timestamp issues",
      count: health.timestampIssues,
      tone: "warn",
    });
  }
  if (health.verificationMissing > 0) {
    rows.push({
      key: "verification_missing",
      label: "Verification package missing",
      count: health.verificationMissing,
      tone: "warn",
    });
  }
  if (health.integrityAlerts > 0) {
    rows.push({
      key: "integrity_alerts",
      label: "Integrity alerts",
      count: health.integrityAlerts,
      tone: "danger",
    });
  }

  return (
    <SectionCard title="Evidence health" testId="evidence-health">
      {health.allClear ? (
        <EmptyState>No evidence issues found.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>Health summary will appear once you have evidence.</EmptyState>
      ) : (
        <ul style={{ ...listStyle, gap: 4 }}>
          {rows.map((r) => (
            <li
              key={r.key}
              data-health-key={r.key}
              style={{
                ...listItemStyle,
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background:
                  r.tone === "danger"
                    ? "#fef2f2"
                    : r.tone === "warn"
                      ? "#fffbeb"
                      : "#f0fdf4",
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 13, color: "#0f172a" }}>{r.label}</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color:
                    r.tone === "danger"
                      ? "#991b1b"
                      : r.tone === "warn"
                        ? "#9a3412"
                        : "#166534",
                }}
              >
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

export function HomeSkeleton() {
  return (
    <div
      data-self-serve-home-skeleton
      aria-busy
      style={{ display: "grid", gap: 14 }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={skeletonTileStyle} />
        ))}
      </div>
      <div style={skeletonRowStyle} />
      <div style={skeletonRowStyle} />
    </div>
  );
}

// ============================================================================
// Inline styles
// ============================================================================

const cardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: 16,
  margin: 0,
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: 10,
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
const cardBodyStyle: React.CSSProperties = {
  margin: 0,
};

const tileLinkStyle: React.CSSProperties = {
  display: "block",
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 14,
  textDecoration: "none",
  color: "inherit",
};
const tileValueStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  color: "#0f172a",
};
const tileLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#5d6d71",
  marginTop: 4,
};
const tileHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  marginTop: 2,
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const listItemStyle: React.CSSProperties = {
  padding: 0,
};
const listItemLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(15, 23, 42, 0.02)",
  textDecoration: "none",
  color: "inherit",
};
const listItemTitleStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const listItemMetaStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  marginTop: 4,
  flexWrap: "wrap",
};
const listItemTimeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
};
const chipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(79, 70, 229, 0.08)",
  color: "#4338ca",
  fontSize: 11,
  fontWeight: 600,
};

function pipelineTileStyle(tone: PipelineStageTile["tone"]): React.CSSProperties {
  return {
    padding: 10,
    borderRadius: 8,
    background: tone === "warn" ? "#fef3c7" : "#f8fafc",
    border: tone === "warn" ? "1px solid #fbbf24" : "1px solid #e2e8f0",
    textAlign: "center",
  };
}
const pipelineTileValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#0f172a",
};
const pipelineTileLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#5d6d71",
  marginTop: 2,
};

const statStyle: React.CSSProperties = {
  padding: 8,
  borderRadius: 8,
  background: "#f8fafc",
  textAlign: "center",
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  borderRadius: 8,
  background: "#4f46e5",
  color: "white",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
};

const secondaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "5px 10px",
  borderRadius: 6,
  background: "white",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 12,
  textDecoration: "none",
};

const quickActionStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "6px 12px",
  borderRadius: 8,
  background: "white",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
};

const skeletonTileStyle: React.CSSProperties = {
  height: 70,
  borderRadius: 10,
  background:
    "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)",
};
const skeletonRowStyle: React.CSSProperties = {
  height: 160,
  borderRadius: 12,
  background:
    "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)",
};
