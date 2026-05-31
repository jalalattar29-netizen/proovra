"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";

type PermissionDenialState = { denial: string; tier: string } | null;

interface RetentionPolicy {
  id: string;
  name: string;
  template: string;
  scopeKind: string;
  scopeTargetId?: string | null;
  expiresAtUtc?: string | null;
  state: string;
  createdAtUtc: string;
}

interface UpcomingExpiration {
  evidenceId: string;
  expiresAtUtc: string;
  policyName: string;
}

const RETENTION_TEMPLATES = [
  "STANDARD_1Y",
  "STANDARD_3Y",
  "LEGAL_HOLD_EXEMPT",
  "CUSTOM",
] as const;

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

export default function RetentionPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [expirations, setExpirations] = useState<UpcomingExpiration[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string>(RETENTION_TEMPLATES[0]);
  const [scopeKind, setScopeKind] = useState("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const [pRes, eRes] = await Promise.all([
        apiFetch("/v1/lifecycle/retention/policies", { method: "GET" }),
        apiFetch("/v1/lifecycle/retention/upcoming-expirations", { method: "GET" }),
      ]);
      setPolicies(
        ((pRes as { policies?: RetentionPolicy[] } | null)?.policies ?? []) as RetentionPolicy[],
      );
      setExpirations(
        ((eRes as { expirations?: UpcomingExpiration[] } | null)?.expirations ??
          []) as UpcomingExpiration[],
      );
    } catch (err) {
      setPolicies([]);
      setExpirations([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    try {
      await apiFetch("/v1/lifecycle/retention/policies", {
        method: "POST",
        body: JSON.stringify({ name, template, scopeKind, scopeTargetId: scopeTargetId || null }),
      });
      setName("");
      setScopeTargetId("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [name, template, scopeKind, scopeTargetId, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-retention-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Retention Policies</h1>
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
          Create Retention Policy
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Policy name"
            />
          </label>
          <label style={labelStyle}>
            Template
            <select style={inputStyle} value={template} onChange={(e) => setTemplate(e.target.value)}>
              {RETENTION_TEMPLATES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Scope Kind
            <input
              style={inputStyle}
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value)}
              placeholder="WORKSPACE"
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
            disabled={creating || !name}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {/* Policies table */}
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
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>Policies</strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Template</th>
              <th style={th}>Scope Kind</th>
              <th style={th}>Scope Target</th>
              <th style={th}>State</th>
              <th style={th}>Expires</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...td, color: "#475569" }}>
                  No retention policies.
                </td>
              </tr>
            ) : (
              policies.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.name}</td>
                  <td style={td}>
                    <code>{p.template}</code>
                  </td>
                  <td style={td}>{p.scopeKind}</td>
                  <td style={td}>{p.scopeTargetId ?? "—"}</td>
                  <td style={td}>
                    <strong>{p.state}</strong>
                  </td>
                  <td style={td}>
                    {p.expiresAtUtc ? new Date(p.expiresAtUtc).toLocaleDateString() : "—"}
                  </td>
                  <td style={td}>{new Date(p.createdAtUtc).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* Upcoming expirations */}
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
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>
          Upcoming Expirations
        </strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Evidence ID</th>
              <th style={th}>Policy</th>
              <th style={th}>Expires At</th>
            </tr>
          </thead>
          <tbody>
            {expirations.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ ...td, color: "#475569" }}>
                  No upcoming expirations.
                </td>
              </tr>
            ) : (
              expirations.map((e) => (
                <tr key={e.evidenceId}>
                  <td style={td}>
                    <code>{e.evidenceId}</code>
                  </td>
                  <td style={td}>{e.policyName}</td>
                  <td style={td}>{new Date(e.expiresAtUtc).toLocaleDateString()}</td>
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
