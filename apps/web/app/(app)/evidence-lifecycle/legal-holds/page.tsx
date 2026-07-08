"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { useToast } from "../../../../components/ui";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../lib/platform-context";
import { LifecycleSectionBoundary } from "../_shared";

type PermissionDenialState = { denial: string; tier: string } | null;

interface LegalHold {
  id: string;
  kind: string;
  name: string;
  reason: string;
  state: string;
  scopeTargetId?: string | null;
  expiresAtUtc?: string | null;
  createdAtUtc: string;
}

// Legal-hold `kind` is the SCOPE the hold applies to, and must match the
// contract enum LEGAL_HOLD_KINDS validated by POST /v1/lifecycle/legal-holds.
// The litigation basis (LITIGATION/REGULATORY/…) belongs in the free-text
// `reason` field, not here — sending a reason value as `kind` fails the
// route's zod enum parse.
const HOLD_KINDS = ["EVIDENCE", "CASE", "WORKSPACE", "ORGANIZATION"] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

export default function LegalHoldsPage() {
  // LifecycleSectionBoundary contains any render crash inside <Shell />
  // to a small inline alert — the segment-level error.tsx becomes the
  // last-resort safety net rather than the first line of defence.
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Legal Holds">
        <Shell />
      </LifecycleSectionBoundary>
    </PageRouteGate>
  );
}

function safeDate(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? "—" : formatUserDate(input);
}

function Shell() {
  const { addToast } = useToast();
  // Active workspace id — the step-up challenge is minted against this
  // tenant. Placing a legal hold is a sensitive governance action, so
  // when the backend responds STEP_UP_REQUIRED the hook opens the modal
  // and resumes the EXACT create request with the challenge header.
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });

  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Create form state
  const [kind, setKind] = useState<string>(HOLD_KINDS[0]);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAtUtc, setExpiresAtUtc] = useState("");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/lifecycle/legal-holds", { method: "GET" })) as {
        holds?: LegalHold[];
      } | null;
      setHolds((res?.holds ?? []) as LegalHold[]);
    } catch (err) {
      setHolds([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    setCreateError(null);
    try {
      // Run the create INSIDE runStepUpAction: if the backend gate
      // responds STEP_UP_REQUIRED, the modal opens and, on successful
      // step-up, the hook resumes this exact request with the step-up
      // challenge header injected by the hook's retry (never spelled out
      // here). If the endpoint does not demand a challenge the wrapper is
      // a no-op and the hold is created on the first call.
      await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/lifecycle/legal-holds", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            kind,
            name,
            reason,
            expiresAtUtc: expiresAtUtc || null,
            scopeTargetId: scopeTargetId || null,
          }),
        }),
      );
      setName("");
      setReason("");
      setExpiresAtUtc("");
      setScopeTargetId("");
      addToast("Legal hold placed.", "success");
      await refresh();
    } catch (err) {
      // Cancelling step-up must NOT create a hold and must NOT surface a
      // scary error — the operator deliberately backed out.
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        addToast("Step-up cancelled — no legal hold was placed.", "info");
      } else {
        applyDenial(err, setDenial);
        const safe = toSafeUserError(err, {
          message: "We couldn't place this legal hold.",
        });
        setCreateError(safe.message);
        notifyApiError(addToast, err, {
          message: "We couldn't place this legal hold.",
        });
      }
    } finally {
      setCreating(false);
    }
  }, [kind, name, reason, expiresAtUtc, scopeTargetId, refresh, stepUp, addToast]);

  const release = useCallback(
    async (id: string) => {
      setDenial(null);
      try {
        await apiFetch(`/v1/lifecycle/legal-holds/${id}/release`, { method: "POST" });
        await refresh();
      } catch (err) {
        applyDenial(err, setDenial);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-legal-holds-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Legal Holds</h1>
        <p>
          <a href="/evidence-lifecycle" style={{ fontSize: 12 }}>
            ← Back to Evidence Lifecycle
          </a>
        </p>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      {/* Create form */}
      <section
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 10, fontSize: 14 }}>
          Create Legal Hold
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Kind
            <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
              {HOLD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Hold name"
            />
          </label>
          <label style={labelStyle}>
            Reason
            <input
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Legal basis"
            />
          </label>
          <label style={labelStyle}>
            Expires At (UTC)
            <input
              type="datetime-local"
              style={inputStyle}
              value={expiresAtUtc}
              onChange={(e) => setExpiresAtUtc(e.target.value)}
            />
          </label>
          <label style={labelStyle}>
            Scope Target ID
            <input
              style={inputStyle}
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="optional"
            />
          </label>
          <button
            type="button"
            disabled={creating || !name || !reason}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </section>

      {createError ? (
        <div
          data-legal-hold-create-error
          role="alert"
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {createError}
        </div>
      ) : null}

      {/* Reuses the existing step-up flow — the modal opens only when the
          backend answers STEP_UP_REQUIRED for the create request. */}
      <StepUpModal control={stepUp} />

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Kind</th>
              <th style={th}>Reason</th>
              <th style={th}>State</th>
              <th style={th}>Scope Target</th>
              <th style={th}>Expires</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {holds.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ ...td, color: "#475569" }}>
                  No legal holds.
                </td>
              </tr>
            ) : (
              holds.map((h) => (
                <tr key={h.id} data-legal-hold-row={h.id}>
                  <td style={td}>{h.name}</td>
                  <td style={td}>
                    <code>{h.kind}</code>
                  </td>
                  <td style={td}>{h.reason}</td>
                  <td style={td}>
                    <strong>{h.state}</strong>
                  </td>
                  <td style={td}>{h.scopeTargetId ?? "—"}</td>
                  <td style={td}>{safeDate(h.expiresAtUtc)}</td>
                  <td style={td}>{safeDate(h.createdAtUtc)}</td>
                  <td style={td}>
                    {h.state === "ACTIVE" ? (
                      <button
                        type="button"
                        onClick={() => void release(h.id)}
                        style={secondaryButton}
                      >
                        Release
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const secondaryButton = {
  padding: "4px 8px",
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
