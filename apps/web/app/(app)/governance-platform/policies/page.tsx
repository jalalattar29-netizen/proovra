"use client";

import { useCallback, useEffect, useState } from "react";

import {
  GOVERNANCE_POLICY_KINDS,
  type GovernancePolicyProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";

type PermissionDenialState = {
  denial: string;
  tier: string;
} | null;

export default function PoliciesPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<GovernancePolicyProjection>>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = await apiFetch("/v1/governance/policies", { method: "GET" });
      setRows((res?.policies ?? []) as ReadonlyArray<GovernancePolicyProjection>);
    } catch (err) {
      setRows([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const activate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/activate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const deprecate = useCallback(async (id: string) => {
    setBusy(true);
    setDenial(null);
    try {
      await apiFetch(`/v1/governance/policies/${id}/deprecate`, { method: "POST" });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-governance-policies-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Governance Policies</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Policy registry. Kinds: {GOVERNANCE_POLICY_KINDS.join(", ")}.
          Inheritance + override + audit. Enforcement: BLOCK / WARN / AUDIT_ONLY.
        </p>
        <p><a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a></p>
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

      <button
        type="button"
        data-governance-policies-refresh
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section style={{ background: "#fff", border: "1px solid rgba(15, 23, 42, 0.08)", borderRadius: 10, padding: 8, marginTop: 12, overflowX: "auto" }}>
        <table data-governance-policies-table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Name</th>
              <th style={th}>Kind</th>
              <th style={th}>Slug</th>
              <th style={th}>State</th>
              <th style={th}>Enforcement</th>
              <th style={th}>Version</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} style={{ ...td, color: "#475569" }}>No policies.</td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} data-governance-policy-row={p.id} data-governance-policy-state={p.state} data-governance-policy-kind={p.kind}>
                  <td style={td}>{p.name}</td>
                  <td style={td}><code>{p.kind}</code></td>
                  <td style={td}><code>{p.slug}</code></td>
                  <td style={td}><strong>{p.state}</strong></td>
                  <td style={td}>{p.enforcementMode}</td>
                  <td style={td}>v{p.version}</td>
                  <td style={td}>{new Date(p.createdAtUtc).toLocaleDateString()}</td>
                  <td style={td}>
                    {p.state === "DRAFT" ? (
                      <button data-governance-policy-activate={p.id} type="button" onClick={() => void activate(p.id)} style={secondaryButton}>
                        Activate
                      </button>
                    ) : p.state === "ACTIVE" ? (
                      <button data-governance-policy-deprecate={p.id} type="button" onClick={() => void deprecate(p.id)} style={secondaryButton}>
                        Deprecate
                      </button>
                    ) : "—"}
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

function applyDenial(
  err: unknown,
  setDenial: (v: PermissionDenialState) => void,
): void {
  if (err instanceof ApiError) {
    const detailsDenial =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const tier =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (err.statusCode === 403 && detailsDenial === "DELEGATED_ADMIN_REQUIRED") {
      setDenial({ denial: detailsDenial, tier });
      return;
    }
  }
  const generic = err as {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
  const detailsDenial =
    generic && generic.details && typeof generic.details["denial"] === "string"
      ? (generic.details["denial"] as string)
      : null;
  const tier =
    generic && generic.details && typeof generic.details["requiredTier"] === "string"
      ? (generic.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    generic &&
    generic.statusCode === 403 &&
    detailsDenial === "DELEGATED_ADMIN_REQUIRED"
  ) {
    setDenial({ denial: detailsDenial, tier });
  }
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
