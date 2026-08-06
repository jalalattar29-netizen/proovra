"use client";

/**
 * PHASE 12B (Evidence Operations) — Policy scope panel.
 *
 * Product consumer for three previously unreachable ops:
 *   * GET    /v1/redaction/policy/effective
 *   * GET    /v1/redaction/policy/assignments
 *   * DELETE /v1/redaction/policy-assignments/:id   (step-up gated)
 *
 * The Policy console could CREATE assignments but never see which
 * assignments were live, which policy actually won at a given scope, or
 * withdraw one. This panel closes that loop.
 *
 * Contract:
 *   * ZERO client policy authority. "Which policy applies" is resolved
 *     entirely by the server's `resolveEffectivePolicy` inheritance
 *     resolver (GLOBAL → WORKSPACE → CASE → PROJECT). This component
 *     renders that resolution; it never recomputes precedence.
 *   * Workspace binding is SERVER-held (`currentWorkspaceId` + the
 *     canonical authorization primitive + `redaction.view` /
 *     `redaction.administer`). No workspace id crosses the wire.
 *   * Version concurrency: the revoke call carries the policy VERSION id
 *     this panel rendered. If the assignment has since been re-pointed,
 *     the server refuses with a bounded denial rather than revoking a
 *     decision the operator never saw.
 *   * Step-up: revoke runs inside `runStepUpAction`, so when the backend
 *     answers STEP_UP_REQUIRED the modal opens and the SAME request is
 *     resumed with the challenge header. Cancelling never revokes.
 *   * Stale-context rejection on every read and on the revoke outcome.
 */

import { useCallback, useEffect, useState } from "react";

import { POLICY_ASSIGNMENT_SCOPES, type PolicyAssignmentScope } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  useActiveWorkspaceId,
  useTenantGuard,
} from "../../lib/platform-context";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";

type AssignmentRow = {
  id: string;
  policyId: string;
  policyVersionId: string;
  scope: string;
  scopeTargetId: string | null;
  assignedByUserId: string;
  assignedAtUtc: string;
  revokedAtUtc: string | null;
};

type EffectivePolicy = {
  schemaVersion: string;
  effectiveAtUtc: string;
  providers: Record<string, boolean>;
  kinds: Record<string, boolean>;
  ruleActions: Record<string, string>;
  customRules: ReadonlyArray<{ name: string; kind: string; action: string }>;
  resolution: ReadonlyArray<{
    scope: string;
    scopeTargetId: string | null;
    policyId: string;
    policyVersionId: string;
    versionOrdinal: number;
  }>;
};

type Phase = "loading" | "denied" | "error" | "ready";

export function PolicyScopePanel({
  onAssignmentsChanged,
}: {
  onAssignmentsChanged?: () => void;
}) {
  const workspaceId = useActiveWorkspaceId();
  const { stamp, isStale } = useTenantGuard();
  const stepUp = useStepUpAction({ teamId: workspaceId });

  const [scope, setScope] = useState<PolicyAssignmentScope>("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [effective, setEffective] = useState<EffectivePolicy | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const targetTrimmed = scopeTargetId.trim();
  const needsTarget = scope === "CASE" || scope === "PROJECT";

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase("loading");
    setMessage(null);
    try {
      const aqs = new URLSearchParams({ scope });
      if (needsTarget && targetTrimmed) {
        aqs.set("scopeTargetId", targetTrimmed);
      }
      const [a, e] = await Promise.all([
        apiFetch(`/v1/redaction/policy/assignments?${aqs.toString()}`, {
          method: "GET",
        }),
        (() => {
          const eqs = new URLSearchParams();
          if (scope === "CASE" && targetTrimmed) eqs.set("caseId", targetTrimmed);
          if (scope === "PROJECT" && targetTrimmed) {
            eqs.set("projectId", targetTrimmed);
          }
          const suffix = eqs.toString();
          return apiFetch(
            `/v1/redaction/policy/effective${suffix ? `?${suffix}` : ""}`,
            { method: "GET" },
          );
        })(),
      ]);
      if (isStale(captured)) return;
      setAssignments((a?.assignments ?? []) as AssignmentRow[]);
      setEffective((e?.effective ?? null) as EffectivePolicy | null);
      setPhase("ready");
    } catch (err) {
      if (isStale(captured)) return;
      const status = (err as { statusCode?: number })?.statusCode;
      const denial = (err as { denial?: string })?.denial;
      if (status === 403 || status === 404 || denial === "NOT_PERMITTED") {
        setAssignments([]);
        setEffective(null);
        setPhase("denied");
        return;
      }
      setPhase("error");
      setMessage(
        toSafeUserError(err, {
          message: "We couldn't load the policy scope for this workspace.",
        }).message,
      );
    }
  }, [isStale, needsTarget, scope, stamp, targetTrimmed]);

  useEffect(() => {
    void load();
  }, [load, workspaceId]);

  const revoke = useCallback(
    async (row: AssignmentRow) => {
      const captured = stamp();
      setPendingId(row.id);
      setMessage(null);
      try {
        // Version-concurrency token + step-up. The wrapper is a
        // transparent no-op when the backend demands no challenge.
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/redaction/policy-assignments/${encodeURIComponent(
              row.id,
            )}?expectedPolicyVersionId=${encodeURIComponent(row.policyVersionId)}`,
            {
              method: "DELETE",
              headers: { ...(headers ?? {}) },
            },
          ),
        );
        if (isStale(captured)) return;
        setMessage("Assignment withdrawn.");
        await load();
        onAssignmentsChanged?.();
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setMessage("Verification cancelled — the assignment is unchanged.");
          return;
        }
        const denial = (err as { denial?: string })?.denial;
        if (denial === "INVALID_TRANSITION") {
          setMessage(
            "This assignment changed while you were looking at it. Refreshed — review it again before withdrawing.",
          );
          void load();
          return;
        }
        if (denial === "PROJECT_NOT_FOUND") {
          setMessage("That assignment is no longer active.");
          void load();
          return;
        }
        if (denial === "NOT_PERMITTED") {
          setMessage("You don't have permission to change policy assignments.");
          return;
        }
        setMessage(
          toSafeUserError(err, {
            message: "We couldn't withdraw that assignment.",
          }).message,
        );
      } finally {
        if (!isStale(captured)) setPendingId(null);
      }
    },
    [isStale, load, onAssignmentsChanged, stamp, stepUp],
  );

  return (
    <section data-redaction-policy-scope style={sectionStyle}>
      <StepUpModal control={stepUp} />

      <header style={headerStyle}>
        <div>
          <strong style={{ fontSize: 13 }}>Where policies apply</strong>
          <p style={mutedStyle}>
            Which policy version is assigned at a scope, and which one
            actually applies once the workspace, case and project levels
            are combined. The platform resolves this — nothing here is
            decided in your browser.
          </p>
        </div>
      </header>

      <div style={controlsStyle}>
        <label style={labelStyle}>
          Scope&nbsp;
          <select
            data-redaction-policy-scope-select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as PolicyAssignmentScope);
              setScopeTargetId("");
            }}
            style={inputStyle}
          >
            {POLICY_ASSIGNMENT_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {needsTarget ? (
          <label style={labelStyle}>
            {scope === "CASE" ? "Case id" : "Project id"}&nbsp;
            <input
              data-redaction-policy-scope-target
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="UUID"
              style={{ ...inputStyle, minWidth: 260 }}
            />
          </label>
        ) : null}
        <button
          type="button"
          data-redaction-policy-scope-refresh
          onClick={() => void load()}
          disabled={phase === "loading"}
          style={subtleButtonStyle}
        >
          {phase === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>

      {message ? (
        <p data-redaction-policy-scope-message style={noticeStyle}>
          {message}
        </p>
      ) : null}

      {phase === "denied" ? (
        <p data-redaction-policy-scope-denied style={mutedStyle}>
          You don&apos;t have permission to view policy assignments for this
          workspace.
        </p>
      ) : null}

      {phase === "error" ? (
        <p data-redaction-policy-scope-error style={errorStyle}>
          {message ?? "We couldn't load the policy scope."}
        </p>
      ) : null}

      {phase === "ready" ? (
        <>
          <div style={{ marginTop: 10 }}>
            <strong style={{ fontSize: 12 }}>Assignments at this scope</strong>
            {assignments.length === 0 ? (
              <p data-redaction-policy-assignments-empty style={mutedStyle}>
                No policy is assigned at this scope. The next level up
                applies.
              </p>
            ) : (
              <table data-redaction-policy-assignments-table style={tableStyle}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#475569" }}>
                    <th style={thStyle}>Policy</th>
                    <th style={thStyle}>Version</th>
                    <th style={thStyle}>Target</th>
                    <th style={thStyle}>Assigned</th>
                    <th style={thStyle} />
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr
                      key={a.id}
                      data-redaction-policy-assignment-row={a.id}
                      data-redaction-policy-assignment-version={a.policyVersionId}
                    >
                      <td style={tdStyle}>
                        <code>{a.policyId.slice(0, 8)}…</code>
                      </td>
                      <td style={tdStyle}>
                        <code>{a.policyVersionId.slice(0, 8)}…</code>
                      </td>
                      <td style={tdStyle}>
                        {a.scopeTargetId ? (
                          <code>{a.scopeTargetId.slice(0, 8)}…</code>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={tdStyle}>{safeDate(a.assignedAtUtc)}</td>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          data-redaction-policy-assignment-revoke={a.id}
                          disabled={pendingId === a.id}
                          onClick={() => void revoke(a)}
                          style={dangerButtonStyle}
                        >
                          {pendingId === a.id ? "Withdrawing…" : "Withdraw"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 12 }}>What actually applies here</strong>
            {!effective ? (
              <p data-redaction-policy-effective-empty style={mutedStyle}>
                No effective policy could be resolved for this scope.
              </p>
            ) : (
              <div data-redaction-policy-effective>
                <p style={mutedStyle}>
                  Resolved {safeDate(effective.effectiveAtUtc)}.
                </p>
                {effective.resolution.length === 0 ? (
                  <p style={mutedStyle}>
                    No policy is assigned anywhere above this scope, so every
                    detector and kind is enabled by default.
                  </p>
                ) : (
                  <ul
                    data-redaction-policy-effective-resolution
                    style={listStyle}
                  >
                    {effective.resolution.map((r) => (
                      <li key={`${r.scope}:${r.policyVersionId}`}>
                        {r.scope}
                        {r.scopeTargetId
                          ? ` (${r.scopeTargetId.slice(0, 8)}…)`
                          : ""}{" "}
                        → policy <code>{r.policyId.slice(0, 8)}…</code> v
                        {r.versionOrdinal}
                      </li>
                    ))}
                  </ul>
                )}
                <p style={mutedStyle}>
                  Detectors turned off:{" "}
                  {disabledKeys(effective.providers) || "none"}
                </p>
                <p style={mutedStyle}>
                  Kinds turned off: {disabledKeys(effective.kinds) || "none"}
                </p>
                <p style={mutedStyle}>
                  Custom rules in force: {effective.customRules.length}
                </p>
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function disabledKeys(map: Record<string, boolean> | undefined): string {
  return Object.entries(map ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k)
    .join(", ");
}

/**
 * Timestamps route through the ONE shared formatting layer (Global Timestamp
 * Display Policy) — see DetectionManifestPanel for the full rationale.
 */
const safeDate = (iso: string): string => formatUserDateTime(iso);

const sectionStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 10,
};
const headerStyle: React.CSSProperties = { marginBottom: 6 };
const controlsStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#475569",
  display: "flex",
  alignItems: "center",
  gap: 4,
};
const inputStyle: React.CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  fontSize: 11,
};
const mutedStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 11,
  margin: "4px 0 0",
  maxWidth: 720,
};
const noticeStyle: React.CSSProperties = {
  margin: "8px 0 0",
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(15, 23, 42, 0.05)",
  fontSize: 12,
};
const errorStyle: React.CSSProperties = {
  color: "#7f1d1d",
  fontSize: 12,
  margin: "6px 0 0",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 11,
  marginTop: 4,
};
const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
};
const listStyle: React.CSSProperties = {
  margin: "4px 0 0",
  paddingLeft: 18,
  fontSize: 11,
  color: "#475569",
};
const subtleButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
};
