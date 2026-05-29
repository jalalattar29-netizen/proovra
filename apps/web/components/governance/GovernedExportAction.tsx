"use client";

/**
 * Phase G2 (G1.1 closure) — Governed Export Action wrapper.
 *
 * Composes the Phase G1 `ExportEligibilityPreflight` with an action
 * button so every output action across the app routes through the
 * same deterministic eligibility check. Operators see the verdict
 * BEFORE the destructive POST/GET; the button is only enabled when
 * the backend returns `outcome: "ALLOWED"`.
 *
 * Hard rules:
 *   * Action labels are passed in — Report PDF and Verification
 *     Package ZIP are NEVER collapsed (Phase A2 vocabulary).
 *   * The wrapper never invents an action — it accepts an `onAction`
 *     callback and calls it only when the verdict is ALLOWED.
 *   * Blocked verdicts disable the button AND surface the reason +
 *     next-step copy from the existing pre-flight component. This is
 *     the "no silent disable" rule from the G2 spec.
 *   * Read-only otherwise — the wrapper itself does not mutate.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

type EligibilityOutcome =
  | "ALLOWED"
  | "BLOCKED_BY_HOLD"
  | "BLOCKED_BY_LIFECYCLE"
  | "BLOCKED_BY_REVIEW_GATE"
  | "BLOCKED_BY_POLICY";

type EligibilityResult = {
  outcome: EligibilityOutcome;
  reason: string;
  lifecycleState: string | null;
};

const TONE: Record<
  EligibilityOutcome,
  { bg: string; fg: string; border: string }
> = {
  ALLOWED: { bg: "#ecfdf5", fg: "#166534", border: "#bbf7d0" },
  BLOCKED_BY_HOLD: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  BLOCKED_BY_LIFECYCLE: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
  BLOCKED_BY_REVIEW_GATE: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
  BLOCKED_BY_POLICY: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
};

const NEXT_STEP: Record<EligibilityOutcome, string> = {
  ALLOWED: "",
  BLOCKED_BY_HOLD:
    "Release the active legal hold from the governance surface before retrying.",
  BLOCKED_BY_LIFECYCLE:
    "The current lifecycle state prevents this action. Wait for the operator review to complete, or restore from archival.",
  BLOCKED_BY_REVIEW_GATE:
    "An active destruction review must resolve before exports proceed.",
  BLOCKED_BY_POLICY:
    "Workspace policy disallows this action. Update the policy from the governance surface.",
};

export function GovernedExportAction({
  evidenceId,
  teamId,
  actionLabel,
  /**
   * Render-prop for the action button. The wrapper passes `disabled`
   * (true when not ALLOWED) + `onClick` (calls onAction). Callers
   * keep full control of button styling/label.
   */
  renderAction,
  /** Optional — when ALLOWED, the wrapper calls this on click. */
  onAction,
  /**
   * Compact mode hides the explanation panel when ALLOWED (the
   * action button alone is enough). Defaults to false.
   */
  compactWhenAllowed = false,
}: {
  evidenceId: string;
  teamId: string | null;
  actionLabel: string;
  renderAction: (props: { disabled: boolean; onClick: () => void }) => React.ReactNode;
  onAction?: () => void;
  compactWhenAllowed?: boolean;
}) {
  const [data, setData] = useState<EligibilityResult | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/governance/export-eligibility?teamId=${encodeURIComponent(
          teamId,
        )}&evidenceId=${encodeURIComponent(evidenceId)}`,
      )) as EligibilityResult;
      if (mountedRef.current) setData(json);
    } catch {
      if (mountedRef.current) setData(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [evidenceId, teamId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const outcome = data?.outcome;
  const allowed = outcome === "ALLOWED";
  const handleClick = useCallback(() => {
    if (!allowed) return;
    if (onAction) onAction();
  }, [allowed, onAction]);

  if (!teamId) {
    return (
      <div
        data-governed-export-empty="no-workspace"
        data-governed-export-action={actionLabel}
        style={panelStyle}
      >
        <strong>{actionLabel}</strong>
        <p style={mutedStyle}>
          A workspace context is required to check eligibility.
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        data-governed-export-loading
        data-governed-export-action={actionLabel}
        style={panelStyle}
      >
        Checking eligibility for {actionLabel}…
      </div>
    );
  }
  if (!data) {
    return (
      <div
        data-governed-export-error
        data-governed-export-action={actionLabel}
        role="alert"
        style={panelStyle}
      >
        <strong>{actionLabel} — eligibility unavailable</strong>
        <p style={mutedStyle}>
          The eligibility check could not run. Retry from the governance
          surface or contact support.
        </p>
      </div>
    );
  }

  const tone = TONE[outcome!];
  return (
    <section
      data-governed-export
      data-governed-export-outcome={outcome}
      data-governed-export-action={actionLabel}
      data-governed-export-allowed={allowed ? "true" : "false"}
      style={{
        border: `1px solid ${tone.border}`,
        background: compactWhenAllowed && allowed ? "transparent" : tone.bg,
        color: compactWhenAllowed && allowed ? "inherit" : tone.fg,
        borderRadius: 8,
        padding: "0.75rem 1rem",
      }}
    >
      {!(compactWhenAllowed && allowed) ? (
        <header style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>{actionLabel}</strong>
          <p style={{ margin: "2px 0 0", fontSize: 12, opacity: 0.85 }}>
            {data.reason}
          </p>
          {!allowed && NEXT_STEP[outcome!] ? (
            <p
              data-governed-export-next-step
              style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.95 }}
            >
              {NEXT_STEP[outcome!]}
            </p>
          ) : null}
        </header>
      ) : null}
      <div data-governed-export-action-host>
        {renderAction({ disabled: !allowed, onClick: handleClick })}
      </div>
    </section>
  );
}

const panelStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  padding: "0.75rem 1rem",
} as const;

const mutedStyle = {
  fontSize: 12,
  color: "#64748b",
  margin: "4px 0 0",
} as const;
