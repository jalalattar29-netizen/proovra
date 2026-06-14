"use client";

/**
 * Phase 28-G — Export / Package eligibility badge.
 *
 * Drop-in component for any UI surface that exposes an
 * "Export evidence" / "Generate verification package" action. The
 * component:
 *
 *   1. Calls the governance snapshot for the evidence.
 *   2. Exposes an `actionDisabled` prop callback so the parent can
 *      grey-out the actual button while loading / blocked / unknown.
 *   3. Renders UI ONLY when something is wrong:
 *        - blocked  → a small alert panel with the bounded label and
 *                     an actionable next-step line
 *        - unknown  → a fail-closed "eligibility unavailable" panel
 *        - allowed  → nothing (no positive-state pill noise; the
 *                     parent's already-enabled download button is the
 *                     affordance)
 *        - loading  → nothing (the parent's button is disabled while we
 *                     wait; surfacing a transient pill creates flicker
 *                     and adds no signal)
 *
 * FAIL-CLOSED:
 *   - Snapshot failure → render UNKNOWN panel, callback `true` for disabled.
 *   - Loading → render nothing, callback `true` for disabled.
 *   - Eligible → render nothing, callback `false` for disabled.
 *
 * The button itself is owned by the parent — this component does NOT
 * itself trigger the action; it only reports the eligibility state.
 *
 * Phase EVIDENCE-DETAIL-CLEANUP — Removed the positive-state pills
 * that previously rendered next to every download button. Reason:
 * those pills sat next to buttons that were already enabled; they
 * added no operator-actionable signal and ate visual real-estate.
 * Blocked outcomes remain visible AND become more prominent (full
 * alert panel with a next-step line), so restrictions are now MORE
 * visible, not less.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { OPS_INK } from "./tokens";

type EligibilityKind = "export" | "package";

type GovernanceSnapshot = {
  export: { eligible: boolean; outcome: string; reason: string; label: string };
  package: { eligible: boolean; outcome: string; reason: string; label: string };
};

export type ExportPackageEligibilityBadgeProps = {
  evidenceId: string;
  teamId: string;
  kind: EligibilityKind;
  /** Called whenever the eligibility state changes. Parent uses this
   *  to enable/disable the actual export/package button. */
  onEligibilityChange?: (state: {
    eligible: boolean;
    loading: boolean;
    unknown: boolean;
    reason: string | null;
  }) => void;
};

export function ExportPackageEligibilityBadge({
  evidenceId,
  teamId,
  kind,
  onEligibilityChange,
}: ExportPackageEligibilityBadgeProps) {
  const [state, setState] = useState<{
    loading: boolean;
    unknown: boolean;
    eligible: boolean;
    label: string;
    reason: string | null;
  }>({
    loading: true,
    unknown: false,
    eligible: false,
    label: "Loading governance state…",
    reason: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState((s) => ({ ...s, loading: true }));
      try {
        const snap = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/governance-snapshot?teamId=${encodeURIComponent(teamId)}`,
        )) as GovernanceSnapshot;
        if (cancelled) return;
        const slice = kind === "export" ? snap.export : snap.package;
        const next = {
          loading: false,
          unknown: false,
          eligible: slice.eligible,
          label: slice.label,
          reason: slice.eligible ? null : slice.reason,
        };
        setState(next);
        onEligibilityChange?.({
          eligible: next.eligible,
          loading: false,
          unknown: false,
          reason: next.reason,
        });
      } catch {
        if (cancelled) return;
        const next = {
          loading: false,
          unknown: true,
          eligible: false,
          label:
            "Governance state could not be loaded — action blocked until snapshot recovers.",
          reason: "governance_state_unavailable",
        };
        setState(next);
        onEligibilityChange?.({
          eligible: false,
          loading: false,
          unknown: true,
          reason: next.reason,
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, teamId, kind, onEligibilityChange]);

  // Phase EVIDENCE-DETAIL-CLEANUP — render UI only for restrictions.
  //   loading  → nothing (button already disabled while we wait)
  //   allowed  → nothing (button is enabled; no positive-state noise)
  //   unknown  → fail-closed warning panel
  //   blocked  → warning panel with bounded label + next-step
  if (state.loading || state.eligible) {
    return null;
  }

  const restriction = state.unknown
    ? {
        title:
          kind === "export"
            ? "Export eligibility unavailable"
            : "Package eligibility unavailable",
        detail:
          "Governance state could not be loaded — action blocked until the snapshot recovers.",
        nextStep:
          "Retry from this page in a moment. If the issue persists, the governance snapshot endpoint may be degraded — contact support.",
      }
    : {
        title:
          kind === "export"
            ? "Export blocked"
            : "Verification package blocked",
        detail: state.label, // bounded operator-readable label from the snapshot
        nextStep: nextStepForReason(state.reason),
      };

  return (
    <div
      role="alert"
      data-eligibility-badge={kind}
      data-eligibility-state={state.unknown ? "unknown" : "blocked"}
      data-eligibility-reason={state.reason ?? "unknown"}
      style={{
        border: "1px solid #fcd34d",
        background: "#fef3c7",
        color: "#78350f",
        borderRadius: 8,
        padding: "0.55rem 0.75rem",
        maxWidth: 360,
      }}
    >
      <strong style={{ fontSize: 13, display: "block" }}>
        {restriction.title}
      </strong>
      <span
        style={{
          display: "block",
          marginTop: 2,
          fontSize: 12,
          color: OPS_INK.muted,
          lineHeight: 1.4,
        }}
      >
        {restriction.detail}
      </span>
      {restriction.nextStep ? (
        <span
          data-eligibility-next-step
          style={{
            display: "block",
            marginTop: 4,
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {restriction.nextStep}
        </span>
      ) : null}
    </div>
  );
}

// Phase EVIDENCE-DETAIL-CLEANUP — bounded next-step copy keyed by the
// canonical reason strings emitted by the governance snapshot. Same
// vocabulary used by `GovernedExportAction`'s NEXT_STEP table so the
// operator sees a consistent recovery path regardless of which surface
// surfaced the block.
function nextStepForReason(reason: string | null): string {
  switch (reason) {
    case "active_legal_hold":
    case "BLOCKED_BY_HOLD":
      return "Release the active legal hold from the governance surface before retrying.";
    case "BLOCKED_BY_LIFECYCLE":
      return "The current lifecycle state prevents this action. Wait for the operator review to complete, or restore from archival.";
    case "active_destruction_review":
    case "BLOCKED_BY_REVIEW_GATE":
      return "An active destruction review must resolve before exports proceed.";
    case "BLOCKED_BY_POLICY":
      return "Workspace policy disallows this action. Update the policy from the governance surface.";
    case "immutable_storage_drift_open":
    case "BLOCKED_BY_IMMUTABLE_DRIFT":
      return "Storage governance reports drift between the database flag and the object-lock state. Resolve from the governance surface before retrying. This is a storage-state finding, not a content-integrity claim.";
    case "governance_state_unavailable":
      return "Retry from this page in a moment. If the issue persists, the governance snapshot endpoint may be degraded — contact support.";
    default:
      return "Resolve from the governance surface before retrying.";
  }
}
