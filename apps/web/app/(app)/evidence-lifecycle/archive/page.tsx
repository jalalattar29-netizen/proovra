"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";

type PermissionDenialState = { denial: string; tier: string } | null;

interface ArchiveTransition {
  id: string;
  evidenceId: string;
  fromTier: string;
  toTier: string;
  state: string;
  initiatedAtUtc: string;
}

interface ArchiveCost {
  tier: string;
  storageGbMonthUsd: number;
  retrievalGbUsd: number;
}

const ARCHIVE_TIERS = ["HOT", "WARM", "COLD", "FROZEN"] as const;

const TIER_COLORS: Record<string, string> = {
  HOT: "#fef3c7",
  WARM: "#ffe4e6",
  COLD: "#dbeafe",
  FROZEN: "#f3f4f6",
};

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

export default function ArchivePage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [transitions, setTransitions] = useState<ArchiveTransition[]>([]);
  const [costs, setCosts] = useState<ArchiveCost[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Manual transition form
  const [evidenceId, setEvidenceId] = useState("");
  const [toTier, setToTier] = useState<string>(ARCHIVE_TIERS[0]);
  const [transitioning, setTransitioning] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const [tRes, cRes] = await Promise.all([
        apiFetch("/v1/lifecycle/archive/transitions", { method: "GET" }),
        apiFetch("/v1/lifecycle/archive/costs", { method: "GET" }),
      ]);
      setTransitions(
        ((tRes as { transitions?: ArchiveTransition[] } | null)?.transitions ??
          []) as ArchiveTransition[],
      );
      setCosts(
        ((cRes as { costs?: ArchiveCost[] } | null)?.costs ?? []) as ArchiveCost[],
      );
    } catch (err) {
      setTransitions([]);
      setCosts([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const doTransition = useCallback(async () => {
    setTransitioning(true);
    setDenial(null);
    try {
      // Lifecycle Consolidation — backend route is singular: /transition (POST).
      // The GET list endpoint remains plural at /transitions.
      await apiFetch("/v1/lifecycle/archive/transition", {
        method: "POST",
        body: JSON.stringify({ evidenceId, toTier }),
      });
      setEvidenceId("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setTransitioning(false);
    }
  }, [evidenceId, toTier, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-archive-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Archive Tiers</h1>
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

      {/* Tier cards */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {ARCHIVE_TIERS.map((tier) => {
          const cost = costs.find((c) => c.tier === tier);
          return (
            <div
              key={tier}
              data-archive-tier={tier}
              style={{
                background: TIER_COLORS[tier] ?? "#f9fafb",
                border: "1px solid rgba(15,23,42,0.08)",
                borderRadius: 10,
                padding: 12,
                minWidth: 160,
              }}
            >
              <strong style={{ display: "block", marginBottom: 4 }}>{tier}</strong>
              {cost ? (
                <div style={{ fontSize: 11, color: "#475569" }}>
                  <div>Storage: ${cost.storageGbMonthUsd}/GB·mo</div>
                  <div>Retrieval: ${cost.retrievalGbUsd}/GB</div>
                </div>
              ) : (
                <small style={{ color: "#94a3b8" }}>No cost data</small>
              )}
            </div>
          );
        })}
      </div>

      {/* Manual transition form */}
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
          Manual Tier Transition
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Evidence ID
            <input
              style={inputStyle}
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              placeholder="uuid"
            />
          </label>
          <label style={labelStyle}>
            To Tier
            <select style={inputStyle} value={toTier} onChange={(e) => setToTier(e.target.value)}>
              {ARCHIVE_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={transitioning || !evidenceId}
            onClick={() => void doTransition()}
            style={primaryButton}
          >
            {transitioning ? "Transitioning…" : "Transition"}
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

      {/* Transitions table */}
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
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>Transitions</strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Evidence ID</th>
              <th style={th}>From</th>
              <th style={th}>To</th>
              <th style={th}>State</th>
              <th style={th}>Initiated</th>
            </tr>
          </thead>
          <tbody>
            {transitions.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#475569" }}>
                  No transitions.
                </td>
              </tr>
            ) : (
              transitions.map((t) => (
                <tr key={t.id}>
                  <td style={td}>
                    <code>{t.evidenceId}</code>
                  </td>
                  <td style={td}>{t.fromTier}</td>
                  <td style={td}>{t.toTier}</td>
                  <td style={td}>
                    <strong>{t.state}</strong>
                  </td>
                  <td style={td}>{new Date(t.initiatedAtUtc).toLocaleDateString()}</td>
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
