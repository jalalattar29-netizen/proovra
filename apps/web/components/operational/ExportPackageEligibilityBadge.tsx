"use client";

/**
 * Phase 28-G — Export / Package eligibility badge.
 *
 * Drop-in component for any UI surface that exposes an
 * "Export evidence" / "Generate verification package" action. The
 * badge:
 *
 *   1. Calls the governance snapshot for the evidence.
 *   2. Renders an eligible / blocked / UNKNOWN pill alongside the
 *      bounded reason label.
 *   3. Exposes an `actionDisabled` prop callback so the parent can
 *      grey-out the actual button while loading / blocked / unknown.
 *
 * FAIL-CLOSED:
 *   - Snapshot failure → render UNKNOWN, callback `true` for disabled.
 *   - Loading → render LOADING, callback `true` for disabled.
 *   - Eligible → callback `false` for disabled.
 *
 * The button itself is owned by the parent — this component does NOT
 * itself trigger the action; it only reports the eligibility state.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

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

  // Visual pill — fail-closed colors.
  const pill = state.loading
    ? { bg: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", label: "Loading…" }
    : state.unknown
      ? {
          bg: "rgba(239, 68, 68, 0.12)",
          color: "rgba(252, 165, 165, 0.95)",
          label: "Unknown — blocked",
        }
      : state.eligible
        ? {
            bg: "rgba(134, 239, 172, 0.12)",
            color: "rgba(134, 239, 172, 0.95)",
            label: kind === "export" ? "Export allowed" : "Package allowed",
          }
        : {
            bg: "rgba(252, 165, 165, 0.12)",
            color: "rgba(252, 165, 165, 0.95)",
            label: kind === "export" ? "Export blocked" : "Package blocked",
          };

  return (
    <div
      data-eligibility-badge={kind}
      data-eligibility-state={
        state.loading
          ? "loading"
          : state.unknown
            ? "unknown"
            : state.eligible
              ? "eligible"
              : "blocked"
      }
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "3px 10px",
          borderRadius: 999,
          background: pill.bg,
          color: pill.color,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {pill.label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "rgba(255,255,255,0.55)",
          maxWidth: 280,
          lineHeight: 1.4,
        }}
      >
        {state.label}
      </span>
      {state.reason ? (
        <span
          style={{
            fontSize: 10,
            color: "rgba(255,255,255,0.4)",
            fontStyle: "italic",
          }}
        >
          {state.reason}
        </span>
      ) : null}
    </div>
  );
}
