"use client";

import { useCallback, useEffect, useState } from "react";

import { identifierLabel } from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";
import { formatUserDate } from "../../../lib/date";
import { permissionDenialCopy } from "../../../lib/labels/governanceReviewLabels";

type PermissionDenialState = { denial: string; permission: string | null } | null;

interface Entitlement {
  id: string;
  key: string;
  kind: string;
  value: string | number | boolean;
  source: string;
  expiresAtUtc?: string | null;
}

interface EntitlementsResponse {
  entitlements: Entitlement[];
}

export default function PackagingPage() {
  return (
    <PageRouteGate routeId="workspace.packaging">
      <Shell />
    </PageRouteGate>
  );
}

const PLAN_LINES = [
  { line: "CAPTURE_AND_VERIFY", label: "Capture & Verify", color: "#eff6ff", border: "#bfdbfe" },
  { line: "INVESTIGATIONS", label: "Investigations", color: "#f0fdf4", border: "#bbf7d0" },
  { line: "ENTERPRISE", label: "Enterprise", color: "#faf5ff", border: "#e9d5ff" },
] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const permission =
    e?.details && typeof e.details["permission"] === "string"
      ? (e.details["permission"] as string)
      : null;
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "PERMISSION_REQUIRED")
  ) {
    setDenial({ denial: denial as string, permission });
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const p =
      err.details && typeof err.details["permission"] === "string"
        ? (err.details["permission"] as string)
        : null;
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "PERMISSION_REQUIRED")
    ) {
      setDenial({ denial: d, permission: p });
    }
  }
}

/**
 * WHAT THIS WORKSPACE HOLDS. Read only: `billing.manage` is a customer OWNER's
 * permission, and it was the only thing between an owner and their own paid
 * features (BILLING-001). What an Enterprise contract sold is active with no
 * action here, and exceptions are an operator's, on the customer's admin page.
 */
function Shell() {
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/packaging/entitlements", {
        method: "GET",
      })) as EntitlementsResponse | null;
      setEntitlements(res?.entitlements ?? []);
    } catch (err) {
      setEntitlements([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-packaging-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Packaging &amp; Entitlements</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          What this workspace holds. Your contract decides it: contact your account manager to change it.
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
          <strong>{permissionDenialCopy(denial.denial, denial.permission).title}</strong>{" "}
          {permissionDenialCopy(denial.denial, denial.permission).detail}
        </div>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {/* Plan cards */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
        {PLAN_LINES.map(({ line, label, color, border }) => (
          <div
            key={line}
            data-plan-card={line}
            style={{
              background: color,
              border: `1px solid ${border}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <strong style={{ fontSize: 15, display: "block", marginBottom: 8 }}>{label}</strong>
            <p style={{ fontSize: 12, color: "#475569", margin: "0 0 12px" }}>
              Product line: <code>{line}</code>
            </p>
          </div>
        ))}
      </section>

      {/* Entitlement table */}
      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 16,
          overflowX: "auto",
        }}
      >
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>Entitlements</strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Key</th>
              <th style={th}>Kind</th>
              <th style={th}>Value</th>
              <th style={th}>Source</th>
              <th style={th}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {entitlements.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#475569" }}>
                  No entitlements.
                </td>
              </tr>
            ) : (
              entitlements.map((e) => (
                <tr key={e.id} data-entitlement-row={e.key}>
                  <td style={td}>
                    <code>{e.key}</code>
                  </td>
                  <td style={td}>{identifierLabel(e.kind)}</td>
                  <td style={td}>{String(e.value)}</td>
                  <td style={td}>{e.source}</td>
                  <td style={td}>
                    {e.expiresAtUtc
                      ? formatUserDate(e.expiresAtUtc)
                      : "—"}
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
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
