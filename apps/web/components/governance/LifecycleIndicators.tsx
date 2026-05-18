"use client";

/**
 * Phase 27.5 — Lifecycle indicators (cross-platform).
 *
 * A reusable badge strip for evidence pages, case pages, reviewer
 * workspace, and any other surface that needs to surface a workspace's
 * governance posture for an evidence record. Renders nothing when no
 * relevant signal is present so non-governance contexts stay clean.
 *
 * Signals shown:
 *   - Lifecycle state (Phase 27 — color-coded ribbon)
 *   - Active destruction review status (PENDING / UNDER_REVIEW /
 *     APPROVED / DEFERRED — terminal statuses are omitted)
 *   - Export-eligibility outcome (only when BLOCKED_*)
 *   - Most-recent immutable storage check outcome (only when drift)
 *
 * Privacy: every field shown here is bounded-catalog. The component
 * NEVER displays legal hold reason text or any free-form metadata.
 * Data is fetched workspace-scoped — non-members get an opaque
 * "not available" response from the API.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

type LifecycleState =
  | "ACTIVE"
  | "UNDER_REVIEW"
  | "ON_HOLD"
  | "RETENTION_LOCKED"
  | "PENDING_DESTRUCTION"
  | "DESTROYED"
  | "ARCHIVED";

type DestructionReviewStatus =
  | "PENDING"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "DEFERRED";

type ExportEligibilityOutcome =
  | "ALLOWED"
  | "BLOCKED_BY_HOLD"
  | "BLOCKED_BY_RETENTION"
  | "BLOCKED_BY_POLICY"
  | "BLOCKED_BY_LIFECYCLE"
  | "BLOCKED_BY_REVIEW_GATE";

type ImmutableOutcome =
  | "OK"
  | "MISSING_LOCK"
  | "RETENTION_MISMATCH"
  | "LEGAL_HOLD_MISMATCH"
  | "COMPLIANCE_MODE_MISMATCH"
  | "STORAGE_UNAVAILABLE"
  | "EVIDENCE_NOT_FOUND";

type LifecycleEvent = {
  id: string;
  toState: LifecycleState;
  eventType: string;
  createdAt: string;
};

type ExportEligibility = {
  outcome: ExportEligibilityOutcome;
  reason: string;
  lifecycleState: LifecycleState | null;
};

type ImmutableCheck = {
  id: string;
  outcome: ImmutableOutcome;
  checkedAtUtc: string;
  driftSummary: string | null;
};

type DestructionReview = {
  id: string;
  status: DestructionReviewStatus | "DENIED" | "RESTORED" | "EXECUTED" | "CANCELLED";
  reason: "retention_expired" | "manual_review" | "policy_supersede";
  createdAt: string;
};

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  ACTIVE: "Active",
  UNDER_REVIEW: "Under review",
  ON_HOLD: "On legal hold",
  RETENTION_LOCKED: "Retention locked",
  PENDING_DESTRUCTION: "Pending destruction",
  DESTROYED: "Destroyed",
  ARCHIVED: "Archived",
};

const ELIGIBILITY_LABEL: Record<ExportEligibilityOutcome, string> = {
  ALLOWED: "Export allowed",
  BLOCKED_BY_HOLD: "Export blocked: hold",
  BLOCKED_BY_RETENTION: "Export blocked: retention",
  BLOCKED_BY_POLICY: "Export blocked: policy",
  BLOCKED_BY_LIFECYCLE: "Export blocked: lifecycle",
  BLOCKED_BY_REVIEW_GATE: "Export blocked: review",
};

const IMMUTABLE_LABEL: Record<ImmutableOutcome, string> = {
  OK: "Object lock OK",
  MISSING_LOCK: "Object lock missing",
  RETENTION_MISMATCH: "Retention mismatch",
  LEGAL_HOLD_MISMATCH: "Hold mismatch",
  COMPLIANCE_MODE_MISMATCH: "Compliance mode mismatch",
  STORAGE_UNAVAILABLE: "Storage unavailable",
  EVIDENCE_NOT_FOUND: "Evidence record missing",
};

const REVIEW_LABEL: Record<string, string> = {
  PENDING: "Review pending",
  UNDER_REVIEW: "Review under way",
  APPROVED: "Approved — awaiting execution",
  DEFERRED: "Review deferred",
};

export default function LifecycleIndicators({
  teamId,
  evidenceId,
}: {
  teamId: string | null;
  evidenceId: string;
}) {
  const [events, setEvents] = useState<LifecycleEvent[] | null>(null);
  const [eligibility, setEligibility] = useState<ExportEligibility | null>(null);
  const [immutable, setImmutable] = useState<ImmutableCheck | null>(null);
  const [activeReview, setActiveReview] = useState<DestructionReview | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    Promise.all([
      apiFetch(
        `/v1/governance/lifecycle/evidence/${encodeURIComponent(evidenceId)}/events?teamId=${encodeURIComponent(teamId)}&limit=5`,
        { method: "GET" },
      ).catch(() => ({ events: [] })),
      apiFetch(
        `/v1/governance/export-eligibility?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}`,
        { method: "GET" },
      ).catch(() => null),
      apiFetch(
        `/v1/governance/immutable-storage-checks?teamId=${encodeURIComponent(teamId)}&evidenceId=${encodeURIComponent(evidenceId)}&limit=1`,
        { method: "GET" },
      ).catch(() => ({ checks: [] })),
      apiFetch(
        `/v1/governance/destruction-reviews?teamId=${encodeURIComponent(teamId)}&status=ACTIVE&limit=20`,
        { method: "GET" },
      ).catch(() => ({ reviews: [] })),
    ]).then(([eRes, elRes, iRes, rRes]: [
      { events: LifecycleEvent[] },
      ExportEligibility | null,
      { checks: ImmutableCheck[] },
      { reviews: Array<DestructionReview & { evidenceId: string }> },
    ]) => {
      if (cancelled) return;
      setEvents(eRes.events ?? []);
      setEligibility(elRes);
      setImmutable(iRes.checks?.[0] ?? null);
      const reviewForThis = (rRes.reviews ?? []).find(
        (r) => r.evidenceId === evidenceId,
      );
      setActiveReview(reviewForThis ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [teamId, evidenceId]);

  if (!teamId) return null;

  // Resolve current lifecycle state from the latest event toState.
  const currentState: LifecycleState | null = events && events.length > 0
    ? events[0]!.toState
    : null;

  const badges: Array<{ tone: "ok" | "info" | "warn" | "danger"; label: string; title?: string }> = [];

  if (currentState && currentState !== "ACTIVE") {
    badges.push({
      tone: stateTone(currentState),
      label: LIFECYCLE_LABEL[currentState],
      title: `Lifecycle state: ${currentState}`,
    });
  }
  if (activeReview && activeReview.status in REVIEW_LABEL) {
    badges.push({
      tone: activeReview.status === "APPROVED" ? "danger" : "warn",
      label: REVIEW_LABEL[activeReview.status] ?? activeReview.status,
      title: `Reason: ${activeReview.reason}`,
    });
  }
  if (eligibility && eligibility.outcome !== "ALLOWED") {
    badges.push({
      tone: "warn",
      label: ELIGIBILITY_LABEL[eligibility.outcome],
      title: eligibility.reason,
    });
  }
  if (immutable && immutable.outcome !== "OK") {
    badges.push({
      tone: immutable.outcome === "STORAGE_UNAVAILABLE" ? "info" : "danger",
      label: IMMUTABLE_LABEL[immutable.outcome],
      title: immutable.driftSummary ?? undefined,
    });
  }

  if (badges.length === 0) return null;

  return (
    <div style={containerStyle} aria-label="Governance lifecycle indicators">
      {badges.map((b, i) => (
        <span key={i} style={badgeStyle(b.tone)} title={b.title}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

function stateTone(state: LifecycleState): "ok" | "info" | "warn" | "danger" {
  switch (state) {
    case "ACTIVE":
      return "ok";
    case "UNDER_REVIEW":
    case "ARCHIVED":
      return "info";
    case "ON_HOLD":
    case "RETENTION_LOCKED":
    case "PENDING_DESTRUCTION":
      return "warn";
    case "DESTROYED":
      return "danger";
  }
}

// -----------------------------------------------------------------------------
// Styles — small, dense, enterprise. Inline to keep the component
// drop-in (no CSS module dependency).
// -----------------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  alignItems: "center",
  margin: "8px 0",
};

function badgeStyle(
  tone: "ok" | "info" | "warn" | "danger",
): React.CSSProperties {
  const palette: Record<typeof tone, [string, string, string]> = {
    ok: ["#ecfdf5", "#bbf7d0", "#166534"],
    info: ["#eff6ff", "#bfdbfe", "#1e40af"],
    warn: ["#fffbeb", "#fcd34d", "#92400e"],
    danger: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[tone];
  return {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}
