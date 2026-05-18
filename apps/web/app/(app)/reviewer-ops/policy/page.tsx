"use client";

/**
 * Phase 25.5 — Reviewer Ops governance + SLA policy admin.
 *
 * Workspace-scoped admin page. Operators with the reviewer-capability
 * permission can edit:
 *   - SLA defaults (assignment / first-review / completion / escalation
 *     / due-soon, all in hours)
 *   - Step-up enforcement flags (approve / reject / escalation-resolve /
 *     bulk)
 *   - Reviewer inactivity threshold (hours)
 *
 * Editing this policy is itself a high-risk action — the API
 * route requires a GOVERNANCE_POLICY_UPDATE step-up challenge.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveWorkspaceId } from "../../../../lib/useActiveWorkspaceId";
import { WorkspaceGateState } from "../WorkspaceGateState";
import { RuntimeStatusBanner } from "../../../../components/operational";
import {
  cardStyle,
  errorBoxStyle,
  ghostButtonStyle,
  headerRowStyle,
  inputStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type Policy = {
  policy: {
    assignmentHours: number;
    firstReviewHours: number;
    completionHours: number;
    escalationHours: number;
    dueSoonHours: number;
  };
  sources: {
    template: Partial<Policy["policy"]>;
    workspace: Partial<Policy["policy"]>;
    env: Partial<Policy["policy"]>;
  };
};

type Flags = {
  requireStepUpForApprove: boolean;
  requireStepUpForReject: boolean;
  requireStepUpForEscalationResolve: boolean;
  requireStepUpForBulk: boolean;
  reviewerInactivityHours: number | null;
};

type ApiResponse = {
  policy: Policy;
  flags: Flags;
};

export default function ReviewerOpsPolicyPage() {
  // Hotfix — canonical workspace resolution.
  const workspaceState = useActiveWorkspaceId();
  const teamId =
    workspaceState.status === "ready" ? workspaceState.workspaceId : null;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [overrides, setOverrides] = useState<Partial<Policy["policy"]>>({});
  const [flagDraft, setFlagDraft] = useState<Partial<Flags>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    apiFetch(
      `/v1/reviewer-ops/sla-policy?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: ApiResponse) => {
        setPolicy(r.policy);
        setFlags(r.flags);
        setOverrides(r.policy.sources.workspace ?? {});
        setFlagDraft({});
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load policy."),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    setNotice(null);
    try {
      // Strip zero / NaN values so we don't accidentally pin a 0-hour
      // SLA.
      const cleanOverrides: Record<string, number> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          cleanOverrides[k] = Math.floor(v);
        }
      }
      const res = await apiFetch("/v1/reviewer-ops/sla-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          overrides:
            Object.keys(cleanOverrides).length > 0 ? cleanOverrides : undefined,
          flags: Object.keys(flagDraft).length > 0 ? flagDraft : undefined,
        }),
      });
      setPolicy(res.policy);
      setFlags(res.flags);
      setNotice("Policy saved.");
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not save policy.",
      );
    } finally {
      setBusy(false);
    }
  }, [teamId, overrides, flagDraft]);

  if (workspaceState.status !== "ready") {
    return (
      <WorkspaceGateState state={workspaceState} surface="Review Policy" />
    );
  }

  if (!policy || !flags) {
    return (
      <main style={pageStyle}>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}
        <p style={mutedStyle}>Loading policy…</p>
      </main>
    );
  }

  const eff = policy.policy;
  const env = policy.sources.env;

  return (
    <main style={pageStyle}>
      {teamId ? <RuntimeStatusBanner teamId={teamId} /> : null}
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Reviewer Ops Policy</h1>
          <p style={subtitleStyle}>
            Workspace SLA defaults + step-up enforcement. Workflow
            templates can override SLAs per-template; this surface sets
            the workspace baseline. Saving triggers a step-up challenge.
          </p>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {notice ? (
        <div
          style={{
            ...errorBoxStyle,
            background: "#ecfdf5",
            color: "#065f46",
            borderColor: "#a7f3d0",
          }}
        >
          {notice}
        </div>
      ) : null}

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>SLA overrides (hours)</h3>
        <p style={mutedStyle}>
          Each field overrides the env default. Leave blank to inherit.
        </p>
        <div style={gridStyle}>
          <PolicyField
            label="Assignment"
            value={overrides.assignmentHours}
            effective={eff.assignmentHours}
            envValue={env.assignmentHours}
            onChange={(v) =>
              setOverrides((p) => ({ ...p, assignmentHours: v }))
            }
          />
          <PolicyField
            label="First review"
            value={overrides.firstReviewHours}
            effective={eff.firstReviewHours}
            envValue={env.firstReviewHours}
            onChange={(v) =>
              setOverrides((p) => ({ ...p, firstReviewHours: v }))
            }
          />
          <PolicyField
            label="Completion"
            value={overrides.completionHours}
            effective={eff.completionHours}
            envValue={env.completionHours}
            onChange={(v) =>
              setOverrides((p) => ({ ...p, completionHours: v }))
            }
          />
          <PolicyField
            label="Escalation"
            value={overrides.escalationHours}
            effective={eff.escalationHours}
            envValue={env.escalationHours}
            onChange={(v) =>
              setOverrides((p) => ({ ...p, escalationHours: v }))
            }
          />
          <PolicyField
            label="Due-soon window"
            value={overrides.dueSoonHours}
            effective={eff.dueSoonHours}
            envValue={env.dueSoonHours}
            onChange={(v) => setOverrides((p) => ({ ...p, dueSoonHours: v }))}
          />
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Step-up enforcement</h3>
        <p style={mutedStyle}>
          When enabled, the action requires a fresh step-up challenge
          (MFA / trusted device) before it succeeds.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <FlagRow
            label="Require step-up for approve"
            value={
              flagDraft.requireStepUpForApprove ??
              flags.requireStepUpForApprove
            }
            onChange={(v) =>
              setFlagDraft((p) => ({ ...p, requireStepUpForApprove: v }))
            }
          />
          <FlagRow
            label="Require step-up for reject"
            value={
              flagDraft.requireStepUpForReject ?? flags.requireStepUpForReject
            }
            onChange={(v) =>
              setFlagDraft((p) => ({ ...p, requireStepUpForReject: v }))
            }
          />
          <FlagRow
            label="Require step-up for escalation resolve / suppress"
            value={
              flagDraft.requireStepUpForEscalationResolve ??
              flags.requireStepUpForEscalationResolve
            }
            onChange={(v) =>
              setFlagDraft((p) => ({
                ...p,
                requireStepUpForEscalationResolve: v,
              }))
            }
          />
          <FlagRow
            label="Require step-up for bulk triage"
            value={
              flagDraft.requireStepUpForBulk ?? flags.requireStepUpForBulk
            }
            onChange={(v) =>
              setFlagDraft((p) => ({ ...p, requireStepUpForBulk: v }))
            }
          />
        </div>
      </section>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Reviewer inactivity</h3>
        <p style={mutedStyle}>
          When set, the reconcile job surfaces a reviewer-inactive
          reminder after the threshold elapses without a touch on the
          assignment. Leave blank to disable.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={720}
            value={
              flagDraft.reviewerInactivityHours ??
              flags.reviewerInactivityHours ??
              ""
            }
            onChange={(e) => {
              const n = e.target.value === "" ? null : Number(e.target.value);
              setFlagDraft((p) => ({
                ...p,
                reviewerInactivityHours:
                  n === null || (Number.isFinite(n) && n > 0) ? n : undefined,
              }));
            }}
            style={{ ...inputStyle, width: 100 }}
            placeholder="—"
          />
          <span style={mutedStyle}>hours</span>
        </div>
      </section>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy}
          onClick={save}
        >
          {busy ? "Saving…" : "Save policy"}
        </button>
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={load}
          disabled={busy}
        >
          Reload
        </button>
      </div>
    </main>
  );
}

function PolicyField({
  label,
  value,
  effective,
  envValue,
  onChange,
}: {
  label: string;
  value: number | undefined;
  effective: number;
  envValue: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div>
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 12,
          color: TOKENS.inkMuted,
        }}
      >
        <span>{label}</span>
        <input
          type="number"
          min={1}
          max={720}
          value={typeof value === "number" ? value : ""}
          placeholder={String(effective)}
          onChange={(e) => {
            if (e.target.value === "") return onChange(undefined);
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0) onChange(n);
          }}
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: TOKENS.inkSubtle }}>
          Effective {effective}h · env {envValue ?? "—"}h
        </span>
      </label>
    </div>
  );
}

function FlagRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        fontSize: 13,
      }}
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  marginTop: 8,
};
