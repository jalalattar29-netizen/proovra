"use client";

/**
 * Phase G1 (F.3) — Export eligibility pre-flight.
 *
 * Consumes the existing
 * `GET /v1/governance/export-eligibility?teamId&evidenceId` endpoint
 * before destructive export actions (Report PDF generation,
 * Verification Package ZIP download, evidence/case export) and
 * surfaces the deterministic verdict so operators never click a
 * blind button.
 *
 * Hard rules:
 *   * Read-only. The component never mutates state.
 *   * A2 vocabulary preserved — Report PDF vs Verification Package
 *     ZIP labels are configurable per call site, never collapsed.
 *   * Never claims legal admissibility, evidentiary correctness, or
 *     compliance attestation.
 *   * `outcome` and `reason` come from the backend; the component
 *     never invents either.
 */

import { useCallback, useEffect, useState } from "react";

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

const OUTCOME_LABEL: Record<EligibilityOutcome, string> = {
  ALLOWED: "Eligible",
  BLOCKED_BY_HOLD: "Blocked by legal hold",
  BLOCKED_BY_LIFECYCLE: "Blocked by lifecycle state",
  BLOCKED_BY_REVIEW_GATE: "Blocked by active destruction review",
  BLOCKED_BY_POLICY: "Blocked by workspace policy",
};

const OUTCOME_TONE: Record<
  EligibilityOutcome,
  { bg: string; fg: string; border: string }
> = {
  ALLOWED: { bg: "#ecfdf5", fg: "#166534", border: "#bbf7d0" },
  BLOCKED_BY_HOLD: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  BLOCKED_BY_LIFECYCLE: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
  BLOCKED_BY_REVIEW_GATE: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
  BLOCKED_BY_POLICY: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
};

export function ExportEligibilityPreflight({
  evidenceId,
  teamId,
  /**
   * Operator-readable name of the action this preflight is gating.
   * Defaults to "Export" — call sites should pass the artifact-specific
   * label (e.g. "Report PDF", "Verification Package ZIP") so the
   * outcome copy reads correctly.
   */
  actionLabel = "Export",
}: {
  evidenceId: string;
  teamId: string | null;
  actionLabel?: string;
}) {
  const [data, setData] = useState<EligibilityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/v1/governance/export-eligibility?teamId=${encodeURIComponent(
          teamId,
        )}&evidenceId=${encodeURIComponent(evidenceId)}`,
      );
      const json = (await res.json()) as EligibilityResult;
      setData(json);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Could not check export eligibility.");
    } finally {
      setLoading(false);
    }
  }, [evidenceId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!teamId) {
    return (
      <div
        data-export-preflight-empty="no-workspace"
        role="status"
        style={panelStyle}
      >
        <strong>Export eligibility</strong>
        <p style={mutedStyle}>
          A workspace context is required to check eligibility.
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div data-export-preflight-loading style={panelStyle}>
        Checking export eligibility for {actionLabel}…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div data-export-preflight-error role="alert" style={panelStyle}>
        <strong>Eligibility check unavailable</strong>
        <p style={mutedStyle}>{error ?? "Not available."}</p>
      </div>
    );
  }

  const tone = OUTCOME_TONE[data.outcome];
  return (
    <section
      data-export-preflight
      data-export-outcome={data.outcome}
      data-export-action={actionLabel}
      style={{
        ...panelStyle,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.fg,
      }}
    >
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
          {actionLabel} — {OUTCOME_LABEL[data.outcome]}
        </strong>
        {data.lifecycleState ? (
          <span
            data-export-preflight-lifecycle
            style={{ fontSize: 11, opacity: 0.8 }}
          >
            Lifecycle: {data.lifecycleState}
          </span>
        ) : null}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>
        {data.reason}
      </p>
      {data.outcome === "ALLOWED" ? null : (
        <p
          data-export-preflight-next-step
          style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.4 }}
        >
          {nextStepFor(data.outcome)}
        </p>
      )}
    </section>
  );
}

function nextStepFor(outcome: EligibilityOutcome): string {
  switch (outcome) {
    case "BLOCKED_BY_HOLD":
      return "Release the active legal hold from the governance surface, or coordinate with the hold owner before retrying.";
    case "BLOCKED_BY_LIFECYCLE":
      return "The current lifecycle state prevents export. Wait for the operator review to complete, or restore the evidence from archival.";
    case "BLOCKED_BY_REVIEW_GATE":
      return "An active destruction review must resolve (denied, restored, or cancelled) before exports proceed.";
    case "BLOCKED_BY_POLICY":
      return "Workspace policy disallows this export. Update the policy from the governance surface (governance.policy.write capability required).";
    default:
      return "";
  }
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
