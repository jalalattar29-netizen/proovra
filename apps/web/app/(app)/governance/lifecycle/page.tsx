"use client";

/**
 * Phase 27 — Governance Operations dashboard.
 *
 * Compliance-grade overview surface. Aggregates the signals the
 * legal / ops reviewer cares about most:
 *
 *   - Evidence lifecycle distribution (gauge counts by state)
 *   - Active destruction queue depth + pending-destruction count
 *   - Retention policy footprint (ACTIVE count, conflicting count)
 *   - Legal hold footprint (ACTIVE workspace holds)
 *
 * The page is read-only — actions land on the dedicated sub-consoles
 * (`/governance/retention`, `/governance/destruction`). Polls
 * `/v1/governance/dashboard` for a single aggregate read.
 *
 * Tone: enterprise / SOC. No playful copy, no truth claims, no
 * privileged legal text. All labels are catalog-bound.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { ImmutableStorageDriftSection } from "../../../../components/hidden-feature-panels/HiddenFeaturePanels";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";

type LifecycleStateCounts = {
  ACTIVE: number;
  UNDER_REVIEW: number;
  ON_HOLD: number;
  RETENTION_LOCKED: number;
  PENDING_DESTRUCTION: number;
  DESTROYED: number;
  ARCHIVED: number;
};

type DashboardResponse = {
  lifecycle: {
    byState: LifecycleStateCounts;
    pendingDestructionCount: number;
  };
  destruction: { activeReviewCount: number };
  retention: { activePoliciesCount: number; conflictCount: number };
  holds: { activeHoldsCount: number };
};

const STATE_LABEL: Record<keyof LifecycleStateCounts, string> = {
  ACTIVE: "Active",
  UNDER_REVIEW: "Under review",
  ON_HOLD: "On legal hold",
  RETENTION_LOCKED: "Retention locked",
  PENDING_DESTRUCTION: "Pending destruction",
  DESTROYED: "Destroyed",
  ARCHIVED: "Archived",
};

const STATE_ORDER: ReadonlyArray<keyof LifecycleStateCounts> = [
  "ACTIVE",
  "UNDER_REVIEW",
  "ON_HOLD",
  "RETENTION_LOCKED",
  "PENDING_DESTRUCTION",
  "ARCHIVED",
  "DESTROYED",
];

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function GovernanceLifecycleDashboard() {
  return (
    <PageRouteGate routeId="governance.lifecycle">
      <GovernanceLifecycleDashboardInner />
    </PageRouteGate>
  );
}

function GovernanceLifecycleDashboardInner() {
  const teamId = useTeamId();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const tick = () => {
      apiFetch(
        `/v1/governance/dashboard?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )
        .then((res: DashboardResponse) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: { message?: string }) => {
          if (cancelled) return;
          setError(toSafeUserError(err, { message: "Unable to load governance dashboard." }).message);
        });
    };
    tick();
    const handle = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [teamId]);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance Posture"
          subtitle="Read-only lifecycle posture across retention, legal holds, destruction queue, and evidence lifecycle distribution."
        />
      }
    >
      <p style={calloutStyle}>
        This page summarizes lifecycle posture. To configure or execute
        lifecycle actions, open{" "}
        <Link href="/evidence-lifecycle" style={calloutLinkStyle}>
          Lifecycle Operations
        </Link>
        .
      </p>

      <nav style={navStyle}>
        <Link href="/governance" style={navLinkStyle}>
          ← Workspace governance
        </Link>
        <Link href="/evidence-lifecycle" style={navLinkStyle}>
          Open Lifecycle Operations →
        </Link>
        <Link href="/governance/retention" style={navLinkStyle}>
          Retention policies →
        </Link>
        <Link href="/governance/destruction" style={navLinkStyle}>
          Destruction queue →
        </Link>
      </nav>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to an organization workspace to view its governance posture dashboard."
        />
      ) : !data ? (
        <p style={mutedStyle}>Loading governance signals…</p>
      ) : (
        <>
          <section style={summaryGridStyle}>
            <TileLink href="/evidence-lifecycle/retention">
              <SummaryTile
                label="Active retention policies"
                value={data.retention.activePoliciesCount}
                accent={
                  data.retention.conflictCount > 0 ? "warning" : "neutral"
                }
                footer={
                  data.retention.conflictCount > 0
                    ? `${data.retention.conflictCount} conflicting`
                    : "No conflicts detected"
                }
              />
            </TileLink>
            <TileLink href="/evidence-lifecycle/legal-holds">
              <SummaryTile
                label="Active legal holds"
                value={data.holds.activeHoldsCount}
                accent={
                  data.holds.activeHoldsCount > 0 ? "warning" : "neutral"
                }
                footer="Workspace evidence holds"
              />
            </TileLink>
            <TileLink href="/evidence-lifecycle/destruction">
              <SummaryTile
                label="Destruction queue"
                value={data.destruction.activeReviewCount}
                accent={
                  data.destruction.activeReviewCount > 0
                    ? "critical"
                    : "neutral"
                }
                footer={`${data.lifecycle.pendingDestructionCount} pending destruction`}
              />
            </TileLink>
            <TileLink href="/evidence-lifecycle/destruction">
              <SummaryTile
                label="Destroyed evidence"
                value={data.lifecycle.byState.DESTROYED}
                accent="critical"
                footer="Terminal — certificate emitted"
              />
            </TileLink>
            {typeof data.lifecycle.byState.ARCHIVED === "number" ? (
              <TileLink href="/evidence-lifecycle/archive">
                <SummaryTile
                  label="Archived evidence"
                  value={data.lifecycle.byState.ARCHIVED}
                  accent="neutral"
                  footer="Tiered storage — archive console"
                />
              </TileLink>
            ) : null}
          </section>

          <PageSection
            title="Lifecycle distribution"
            description="Counts are point-in-time. The orchestrator is the single writer of lifecycle state; every transition is logged in the evidence lifecycle ledger."
          >
            <Card>
              <ul style={listStyle}>
                {STATE_ORDER.map((s) => (
                  <li key={s} style={stateRowStyle}>
                    <span style={stateBadgeStyle(s)}>{STATE_LABEL[s]}</span>
                    <span style={stateCountStyle}>
                      {data.lifecycle.byState[s].toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </PageSection>

          {/* Phase Final-Hidden-Feature-Surfacing — ImmutableStorageCheck
              drift list. Reconciler-detected mismatches between DB
              lifecycle state and storage bucket pin. Real backend. */}
          <ImmutableStorageDriftSection teamId={teamId} />

          <PageSection title="Operator runbook">
            <Card>
            <ol style={runbookListStyle}>
              <li>
                <strong>Retention conflicts</strong> — open Retention policies
                and resolve same-scope duplicates by superseding or pausing
                the older policy.
              </li>
              <li>
                <strong>Destruction queue depth</strong> — review pending
                items in the Destruction queue. Approve only after confirming
                no legal hold or active investigation applies.
              </li>
              <li>
                <strong>Pending destruction count</strong> — these evidence
                items are awaiting reviewer approval. Destruction does not
                run until a reviewer EXECUTEs an APPROVED review.
              </li>
              <li>
                <strong>Active legal holds</strong> — holds block destruction
                regardless of retention. Release a hold from the workspace
                governance page before any destruction can proceed.
              </li>
            </ol>
            </Card>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

function SummaryTile({
  label,
  value,
  accent,
  footer,
}: {
  label: string;
  value: number;
  accent: "neutral" | "warning" | "critical";
  footer: string;
}) {
  return (
    <div style={summaryTileStyle(accent)}>
      <div style={summaryLabelStyle}>{label}</div>
      <div style={summaryValueStyle}>{value.toLocaleString()}</div>
      <div style={summaryFooterStyle}>{footer}</div>
    </div>
  );
}

/**
 * Read-only deep-link wrapper for posture tiles. Clicking the tile
 * navigates to the matching Lifecycle Operations sub-console where
 * the operator can take action. The tile itself remains read-only.
 */
function TileLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} style={tileLinkStyle}>
      {children}
    </Link>
  );
}

// -----------------------------------------------------------------------------
// Styles — enterprise/SOC palette: slate + indigo, restrained accents.
// -----------------------------------------------------------------------------

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const calloutStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "10px 12px",
  fontSize: 13,
  color: "#1e293b",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 8,
};
const calloutLinkStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontWeight: 600,
  textDecoration: "underline",
};
const tileLinkStyle: React.CSSProperties = {
  display: "block",
  textDecoration: "none",
  color: "inherit",
};
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 16,
  marginBottom: 8,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
  marginTop: 24,
};
function summaryTileStyle(
  accent: "neutral" | "warning" | "critical",
): React.CSSProperties {
  const palette = {
    neutral: { border: "#e2e8f0", bg: "#fff", color: "#0f172a" },
    warning: { border: "#fcd34d", bg: "#fffbeb", color: "#92400e" },
    critical: { border: "#fca5a5", bg: "#fef2f2", color: "#991b1b" },
  }[accent];
  return {
    padding: 16,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
    color: palette.color,
    borderRadius: 12,
  };
}
const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "inherit",
  opacity: 0.7,
};
const summaryValueStyle: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  marginTop: 6,
  marginBottom: 4,
  letterSpacing: -0.5,
  color: "inherit",
};
const summaryFooterStyle: React.CSSProperties = {
  fontSize: 12,
  color: "inherit",
  opacity: 0.75,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "12px 0 0",
};
const stateRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 0",
  borderBottom: "1px solid #f1f5f9",
};
const stateCountStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};
function stateBadgeStyle(s: keyof LifecycleStateCounts): React.CSSProperties {
  const palette: Record<keyof LifecycleStateCounts, [string, string, string]> = {
    ACTIVE: ["#ecfdf5", "#bbf7d0", "#166534"],
    UNDER_REVIEW: ["#eff6ff", "#bfdbfe", "#1e40af"],
    ON_HOLD: ["#fffbeb", "#fcd34d", "#92400e"],
    RETENTION_LOCKED: ["#f5f3ff", "#ddd6fe", "#5b21b6"],
    PENDING_DESTRUCTION: ["#fff7ed", "#fed7aa", "#9a3412"],
    DESTROYED: ["#fef2f2", "#fca5a5", "#991b1b"],
    ARCHIVED: ["#f8fafc", "#e2e8f0", "#475569"],
  };
  const [bg, border, color] = palette[s];
  return {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
  };
}
const runbookListStyle: React.CSSProperties = {
  paddingLeft: 20,
  margin: "12px 0 0",
  fontSize: 14,
  color: "#334155",
  lineHeight: 1.6,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
