"use client";

/**
 * Phase G2 (G1.1 closure) — Governed Export Action wrapper.
 *
 * The canonical governed-export surface: the Phase G1 export-eligibility
 * pre-flight composed with an action button, so every output action
 * across the app routes through the same deterministic eligibility
 * check. Operators see the verdict BEFORE the destructive POST/GET;
 * the button is only enabled when the backend returns
 * `outcome: "ALLOWED"`.
 *
 * Phase 12 Point 4 — the standalone `ExportEligibilityPreflight`
 * component was a never-mounted duplicate of this wrapper. Its unique
 * presentation (bounded outcome labels, lifecycle state, honest error
 * copy) was migrated here and the duplicate deleted. The same server
 * verdict is now also enforced on the report + verification-package
 * download routes, so a direct API call cannot bypass it.
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
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

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

// Bounded operator-readable verdict labels. Migrated from the Phase G1
// `ExportEligibilityPreflight` (deleted in Phase 12 Point 4 as a
// duplicate of this wrapper) so the blocked state names the gate that
// blocked it, not just the server's free-text reason.
const OUTCOME_LABEL: Record<EligibilityOutcome, string> = {
  ALLOWED: "Eligible",
  BLOCKED_BY_HOLD: "Blocked by legal hold",
  BLOCKED_BY_LIFECYCLE: "Blocked by lifecycle state",
  BLOCKED_BY_REVIEW_GATE: "Blocked by active destruction review",
  BLOCKED_BY_POLICY: "Blocked by workspace policy",
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/governance/export-eligibility?teamId=${encodeURIComponent(
          teamId,
        )}&evidenceId=${encodeURIComponent(evidenceId)}`,
      )) as EligibilityResult;
      if (mountedRef.current) setData(json);
    } catch (err) {
      // Phase 12 Point 4 — the failure reason is surfaced instead of
      // swallowed (migrated from the deleted preflight component). A
      // failed eligibility check must never look like a bare "not
      // available"; the action stays disabled either way.
      if (mountedRef.current) {
        setData(null);
        setError(
          toSafeUserError(err, {
            message: "Could not check export eligibility.",
          }).message,
        );
      }
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
    /*
     * THE WHITE SLAB ON FIRST LOAD.
     *
     * This state used to render `panelStyle` unconditionally: a block-level
     * div with `background: #fff`, a hairline border and 0.75rem of padding,
     * stretched to the full width of whatever row it sat in. On the Reports
     * index that is two of them per row over twenty-one rows, so opening the
     * page painted forty-two large white rectangles where the download
     * buttons were about to be, until `/v1/governance/export-eligibility`
     * came back and each collapsed into a small button. That is the flash.
     *
     * A compact caller has told us its resolved form is JUST the button, so
     * the honest placeholder is that same button, inert. The footprint is
     * identical before and after the fetch, so nothing reflows and there is
     * no white surface to flash — the row simply starts with its action
     * disabled and enables it once eligibility is known.
     *
     * It cannot leak an unauthorised export: `disabled` is hard-coded true
     * and the click handler is a no-op, so the only path to `onAction` is
     * still the ALLOWED branch below.
     *
     * A non-compact caller keeps the panel. Its resolved form IS a panel
     * carrying the verdict and its next step, so a panel-shaped placeholder
     * is the stable footprint there.
     */
    if (compactWhenAllowed) {
      return (
        <div
          data-governed-export-loading
          data-governed-export-loading-form="compact"
          data-governed-export-action={actionLabel}
          aria-busy="true"
        >
          {renderAction({ disabled: true, onClick: () => {} })}
        </div>
      );
    }

    return (
      <div
        data-governed-export-loading
        data-governed-export-loading-form="panel"
        data-governed-export-action={actionLabel}
        aria-busy="true"
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
          {error ??
            "The eligibility check could not run. Retry from the governance surface or contact support."}
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
      /**
       * COMPACT-ALLOWED IS A PASS-THROUGH.
       *
       * This wrapper used to keep `border: 1px solid ${tone.border}` in every
       * outcome. With `compactWhenAllowed` the background and text were cleared
       * but the BORDER survived, so an ALLOWED export drew `#bbf7d0` — a thin
       * green rectangle around the download control, applied for no reason
       * other than the file being available. A blocked outcome still needs its
       * surface, because it carries the gate and its next-step copy.
       */
      style={
        compactWhenAllowed && allowed
          ? { border: "none", background: "transparent", color: "inherit", padding: 0 }
          : {
              border: `1px solid ${tone.border}`,
              background: tone.bg,
              color: tone.fg,
              borderRadius: 8,
              padding: "0.75rem 1rem",
            }
      }
    >
      {!(compactWhenAllowed && allowed) ? (
        <header style={{ marginBottom: 8 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <strong style={{ fontSize: 13 }}>
              {actionLabel} — {OUTCOME_LABEL[outcome!]}
            </strong>
            {/* Lifecycle state comes from the same server projection.
                Migrated from the deleted preflight component so a
                lifecycle block names the state that caused it. */}
            {data.lifecycleState ? (
              <span
                data-governed-export-lifecycle={data.lifecycleState}
                style={{ fontSize: 11, opacity: 0.8 }}
              >
                Lifecycle: {data.lifecycleState}
              </span>
            ) : null}
          </div>
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
