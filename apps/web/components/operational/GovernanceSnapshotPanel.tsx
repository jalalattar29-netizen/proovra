"use client";

/**
 * Phase 28-G — Governance Snapshot Panel.
 *
 * Consumes `GET /v1/evidence/:id/governance-snapshot` from Phase 28-D
 * and renders a dense operational summary on Evidence Detail.
 *
 * Hard contracts:
 *   - FAIL-CLOSED: when the snapshot cannot load, render the
 *     `GovernanceSnapshotUnavailableNotice`. NEVER imply success when
 *     state is unknown.
 *   - Safe-wording: render only the backend's bounded drift label
 *     (Storage governance drift). The brief forbids any wording that
 *     implies content-integrity tampering / forgery / alteration —
 *     this component never renders those words.
 *   - No private notes / no raw payloads / no secrets surface here.
 *     The snapshot endpoint already strips those.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { GovernanceSnapshotUnavailableNotice } from "./OperationalEmptyState";

type GovernanceWarning = {
  code: string;
  label: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
};

type GovernanceSnapshot = {
  evidenceId: string;
  teamId: string;
  generatedAtUtc: string;
  lifecycle: { state: string; label: string; isTerminal: boolean };
  review: {
    workflowId: string | null;
    status: string | null;
    slaStatus: string | null;
    activeEscalationId: string | null;
    activeEscalationSeverity: string | null;
  };
  legalHold: {
    hasActiveDirectHold: boolean;
    hasActiveCaseHold: boolean;
    directHoldCount: number;
    caseHoldCount: number;
    blocksExport: boolean;
  };
  retention: {
    bound: boolean;
    immutable: boolean;
    expired: boolean;
    retentionUntilUtc: string | null;
  };
  destruction: {
    activeReviewId: string | null;
    activeReviewStatus: string | null;
    eligible: boolean;
    blockedReason: string | null;
  };
  export: {
    eligible: boolean;
    outcome: string;
    reason: string;
    label: string;
  };
  package: {
    eligible: boolean;
    outcome: string;
    reason: string;
    label: string;
  };
  immutableStorage: {
    driftDetected: boolean;
    driftIncidentId: string | null;
    driftLabel: string | null;
  };
  incidents: Array<{
    id: string;
    severity: string;
    category: string;
    title: string;
    openedAtUtc: string;
    runbookSlug: string | null;
  }>;
  warnings: ReadonlyArray<GovernanceWarning>;
};

const SEVERITY_TONE: Record<
  GovernanceWarning["severity"],
  { bg: string; border: string; color: string }
> = {
  INFO: {
    bg: "rgba(96, 165, 250, 0.08)",
    border: "1px solid rgba(96, 165, 250, 0.3)",
    color: "rgba(147, 197, 253, 0.95)",
  },
  WARNING: {
    bg: "rgba(245, 158, 11, 0.08)",
    border: "1px solid rgba(245, 158, 11, 0.3)",
    color: "rgba(252, 211, 77, 0.95)",
  },
  HIGH: {
    bg: "rgba(239, 68, 68, 0.08)",
    border: "1px solid rgba(239, 68, 68, 0.35)",
    color: "rgba(252, 165, 165, 0.95)",
  },
  CRITICAL: {
    bg: "rgba(239, 68, 68, 0.15)",
    border: "1px solid rgba(239, 68, 68, 0.5)",
    color: "rgba(254, 202, 202, 0.98)",
  },
};

function eligibilityBadge(eligible: boolean | null) {
  if (eligible === null) {
    return { label: "Unknown — treat as blocked", color: "rgba(252, 165, 165, 0.95)" };
  }
  return eligible
    ? { label: "Allowed", color: "rgba(134, 239, 172, 0.95)" }
    : { label: "Blocked", color: "rgba(252, 165, 165, 0.95)" };
}

export type GovernanceSnapshotPanelProps = {
  evidenceId: string;
  teamId: string;
};

export function GovernanceSnapshotPanel({
  evidenceId,
  teamId,
}: GovernanceSnapshotPanelProps) {
  const [snapshot, setSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/governance-snapshot?teamId=${encodeURIComponent(teamId)}`,
        )) as GovernanceSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSnapshot(null);
          const e = err as { message?: string; requestId?: string };
          setError(e?.message ?? "governance_snapshot_unavailable");
          setRequestId(e?.requestId);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, teamId]);

  // FAIL-CLOSED: when the snapshot cannot load, the operator MUST see
  // the unknown-state notice. We never imply success / eligibility on
  // an empty render.
  if (!loading && (error || !snapshot)) {
    return <GovernanceSnapshotUnavailableNotice requestId={requestId} />;
  }
  if (loading || !snapshot) {
    return (
      <div
        role="status"
        aria-busy="true"
        style={{
          padding: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          color: "rgba(255,255,255,0.5)",
          fontSize: 13,
        }}
      >
        Loading governance state…
      </div>
    );
  }

  const exportBadge = eligibilityBadge(snapshot.export.eligible);
  const packageBadge = eligibilityBadge(snapshot.package.eligible);

  return (
    <div
      data-governance-snapshot
      data-evidence-id={snapshot.evidenceId}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: 12,
      }}
    >
      {/* Lifecycle + eligibility row */}
      <section
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.02)",
          borderRadius: 8,
          padding: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <SnapshotField
          label="Lifecycle"
          value={snapshot.lifecycle.label}
          tone={snapshot.lifecycle.isTerminal ? "danger" : "neutral"}
        />
        <SnapshotField
          label="Review state"
          value={snapshot.review.status ?? "No review workflow"}
          tone={snapshot.review.slaStatus === "BREACHED" ? "danger" : "neutral"}
        />
        <SnapshotField
          label="Legal hold"
          value={
            snapshot.legalHold.hasActiveDirectHold ||
            snapshot.legalHold.hasActiveCaseHold
              ? `Active (${snapshot.legalHold.directHoldCount + snapshot.legalHold.caseHoldCount})`
              : "None"
          }
          tone={
            snapshot.legalHold.hasActiveDirectHold ||
            snapshot.legalHold.hasActiveCaseHold
              ? "warning"
              : "neutral"
          }
        />
        <SnapshotField
          label="Retention"
          value={
            snapshot.retention.bound
              ? snapshot.retention.immutable
                ? "Immutable"
                : snapshot.retention.expired
                  ? "Expired"
                  : "Bound"
              : "Not bound"
          }
          tone={snapshot.retention.expired ? "warning" : "neutral"}
        />
        <SnapshotField
          label="Storage governance"
          value={
            snapshot.immutableStorage.driftDetected
              ? snapshot.immutableStorage.driftLabel ??
                "Storage governance drift"
              : "Healthy"
          }
          tone={snapshot.immutableStorage.driftDetected ? "danger" : "neutral"}
        />
      </section>

      {/* Export + package eligibility */}
      <section
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.02)",
          borderRadius: 8,
          padding: 14,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <EligibilityCard
          kicker="Compliance export"
          eligible={snapshot.export.eligible}
          label={snapshot.export.label}
          reason={snapshot.export.eligible ? null : snapshot.export.reason}
          badge={exportBadge}
        />
        <EligibilityCard
          kicker="Verification package"
          eligible={snapshot.package.eligible}
          label={snapshot.package.label}
          reason={snapshot.package.eligible ? null : snapshot.package.reason}
          badge={packageBadge}
        />
      </section>

      {/* Governance warnings */}
      {snapshot.warnings.length > 0 ? (
        <section
          aria-label="Governance warnings"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {snapshot.warnings.map((w) => {
            const tone = SEVERITY_TONE[w.severity];
            return (
              <div
                key={`${w.code}-${w.label}`}
                style={{
                  border: tone.border,
                  background: tone.bg,
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  color: tone.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <span>{w.label}</span>
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: 0.6,
                    fontWeight: 600,
                    opacity: 0.7,
                  }}
                >
                  {w.severity}
                </span>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* Active incidents */}
      {snapshot.incidents.length > 0 ? (
        <section
          aria-label="Open incidents"
          style={{
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.02)",
            borderRadius: 8,
            padding: 14,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.5)",
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Open incidents ({snapshot.incidents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {snapshot.incidents.map((i) => (
              <div
                key={i.id}
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.8)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <span>{i.title}</span>
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: 0.5,
                    fontWeight: 600,
                    color:
                      i.severity === "CRITICAL"
                        ? "rgba(252, 165, 165, 0.95)"
                        : i.severity === "HIGH"
                          ? "rgba(252, 211, 77, 0.95)"
                          : "rgba(255,255,255,0.5)",
                  }}
                >
                  {i.severity}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small internal field components
// -----------------------------------------------------------------------------

type FieldTone = "neutral" | "warning" | "danger";

function SnapshotField({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: FieldTone;
}) {
  const color =
    tone === "danger"
      ? "rgba(252, 165, 165, 0.95)"
      : tone === "warning"
        ? "rgba(252, 211, 77, 0.95)"
        : "rgba(255,255,255,0.92)";
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function EligibilityCard({
  kicker,
  eligible,
  label,
  reason,
  badge,
}: {
  kicker: string;
  eligible: boolean;
  label: string;
  reason: string | null;
  badge: { label: string; color: string };
}) {
  return (
    <div
      data-eligibility-kicker={kicker}
      data-eligibility-eligible={String(eligible)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          fontWeight: 600,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: badge.color,
        }}
      >
        {badge.label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "rgba(255,255,255,0.65)",
          lineHeight: 1.45,
        }}
      >
        {label}
      </div>
      {reason ? (
        <div
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.45)",
            fontStyle: "italic",
          }}
        >
          Reason: {reason}
        </div>
      ) : null}
    </div>
  );
}
