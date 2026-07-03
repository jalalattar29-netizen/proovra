"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";
import { formatUserDate } from "../../../lib/date";

type PermissionDenialState = { denial: string; tier: string } | null;

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
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "ENTITLEMENT";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "ENTITLEMENT";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

function Shell() {
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const [applyBusy, setApplyBusy] = useState<string | null>(null);

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

  const applyProductLine = useCallback(
    async (line: string) => {
      setApplyBusy(line);
      setDenial(null);
      try {
        await apiFetch("/v1/packaging/entitlements/apply-product-line", {
          method: "POST",
          body: JSON.stringify({ line }),
        });
        await refresh();
      } catch (err) {
        applyDenial(err, setDenial);
      } finally {
        setApplyBusy(null);
      }
    },
    [refresh],
  );

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
          Plan lines · entitlement registry · apply product bundles.
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
            <button
              type="button"
              data-apply-product-line={line}
              disabled={applyBusy === line || busy}
              onClick={() => void applyProductLine(line)}
              style={secondaryButton}
            >
              {applyBusy === line ? "Applying…" : "Apply Product Line"}
            </button>
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
                  <td style={td}>{e.kind}</td>
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
