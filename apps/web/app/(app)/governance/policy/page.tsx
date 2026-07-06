"use client";

/**
 * Phase 32.8B — canonical policy administration surface.
 *
 * This page was formerly at `/reviewer-ops/policy`. Phase 32.8A
 * relocated it to `/governance/policy` because policy administration
 * belongs to the Governance domain (preservation / SLA / step-up
 * enforcement is governance, not queue triage).
 *
 * `/reviewer-ops/policy` now redirects here.
 *
 * Behavior, API contract, and step-up requirements are unchanged
 * from Phase 25.5 — only the URL changed.
 *
 * Shared helpers (`WorkspaceGateState`, `ui-tokens`) still live
 * under `/reviewer-ops/` until Phase 32.8C relocates them to a
 * neutral home. We import them by relative path until then.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
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
} from "../../reviewer-ops/ui-tokens";

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

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function GovernancePolicyPage() {
  return (
    <PageRouteGate routeId="governance.policy">
      <GovernancePolicyPageInner />
    </PageRouteGate>
  );
}

function GovernancePolicyPageInner() {
  // PageRouteGate guarantees an active ORGANIZATION space here.
  const teamId = useActiveSpaceId();
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
        setError(toSafeUserError(err, { message: "Could not load policy." }).message),
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
        toSafeUserError(err, { message: "Could not save policy." }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [teamId, overrides, flagDraft]);

  // PageRouteGate already guaranteed ALLOWED. If teamId is null the
  // envelope hasn't hydrated yet — render the bounded loading shell.
  if (!teamId) {
    return (
      <main data-governance-policy-loading style={{ padding: 24 }}>
        Loading organization workspace…
      </main>
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
      {teamId ? (
        <RuntimeStatusBanner teamId={teamId} forDomains={["reviewer_ops"]} />
      ) : null}
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Governance Policy</h1>
          <p style={subtitleStyle} data-governance-policy-intro>
            This surface administers the workspace baseline SLA and
            step-up enforcement flags. Workflow templates can override
            the SLA per template; the values set here apply only when a
            template does not pin its own. Saving triggers a step-up
            challenge.
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
