"use client";

/**
 * PROOVRA Phase 3B Enterprise Closure — Budget Center.
 *
 * Per-scope spend dashboard + breach timeline. Honest per-budget
 * remaining + projected spend + threshold status. Bounded ids only —
 * NEVER PII.
 */

import { useCallback, useEffect, useState } from "react";

import {
  EXECUTIVE_METRICS_RANGES,
  type BudgetBreachProjection,
  type BudgetBreachRow,
  type BudgetSpendProjection,
  type BudgetSpendRow,
  type ExecutiveMetricsRange,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";

export default function BudgetCenterPage() {
  return (
    <PageRouteGate routeId="workspace.budget_center">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [spend, setSpend] = useState<BudgetSpendProjection | null>(null);
  const [breaches, setBreaches] = useState<BudgetBreachProjection | null>(null);
  const [range, setRange] = useState<ExecutiveMetricsRange>("30d");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [s, b] = await Promise.all([
        apiFetch("/v1/intelligence/budgets/spend", { method: "GET" }),
        apiFetch(`/v1/intelligence/budgets/breaches?range=${range}`, {
          method: "GET",
        }),
      ]);
      setSpend((s?.projection ?? null) as BudgetSpendProjection | null);
      setBreaches((b?.projection ?? null) as BudgetBreachProjection | null);
    } catch {
      setSpend(null);
      setBreaches(null);
    } finally {
      setBusy(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-budget-center
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Budget Center</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Per-scope spend, remaining budget, projected burn, breach
          timeline. Hard-limit BLOCK decisions are enforced — no override
          without explicit operator action.
        </p>
      </header>

      <div
        data-budget-center-range-bar
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 14,
          padding: 8,
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 11, color: "#475569" }}>Breach range</span>
        {EXECUTIVE_METRICS_RANGES.map((r) => (
          <button
            type="button"
            key={r}
            data-budget-center-range={r}
            data-active={r === range ? "true" : "false"}
            onClick={() => setRange(r)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border:
                r === range
                  ? "1px solid #0f172a"
                  : "1px solid rgba(15, 23, 42, 0.18)",
              background: r === range ? "#0f172a" : "#fff",
              color: r === range ? "#fafafa" : "#0f172a",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {r}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-budget-center-refresh
          disabled={busy}
          onClick={() => void refresh()}
          style={primaryButton}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <section data-budget-center-spend style={section}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Per-scope spend</h2>
        <SpendTable rows={spend?.rows ?? []} />
      </section>

      <section data-budget-center-breaches style={section}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>
          Breach timeline · {breaches?.totalBreaches ?? 0} total ·{" "}
          {breaches?.softBreaches ?? 0} soft · {breaches?.hardBreaches ?? 0} hard
        </h2>
        <BreachTable rows={breaches?.rows ?? []} />
      </section>
    </div>
  );
}

function SpendTable({ rows }: { rows: ReadonlyArray<BudgetSpendRow> }) {
  if (rows.length === 0) {
    return <p style={{ color: "#475569", fontSize: 12 }}>No active budgets.</p>;
  }
  return (
    <table data-budget-spend-table style={tableStyle}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>Scope</th>
          <th style={th}>Target</th>
          <th style={th}>Provider</th>
          <th style={th}>Period</th>
          <th style={th}>Soft $</th>
          <th style={th}>Hard $</th>
          <th style={th}>Spent $</th>
          <th style={th}>Remaining $</th>
          <th style={th}>Projected $</th>
          <th style={th}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.budgetId}
            data-budget-spend-row={r.budgetId}
            data-budget-threshold={r.thresholdStatus}
          >
            <td style={td}>{r.scope}</td>
            <td style={td}>
              {r.scopeTargetId ? <code>{r.scopeTargetId.slice(0, 8)}…</code> : "—"}
            </td>
            <td style={td}>{r.provider ? <code>{r.provider}</code> : "—"}</td>
            <td style={td}>{r.period}</td>
            <td style={td}>${(r.softLimitUsdMicros / 1_000_000).toFixed(2)}</td>
            <td style={td}>${(r.hardLimitUsdMicros / 1_000_000).toFixed(2)}</td>
            <td style={td}>
              ${(r.consumedUsdMicrosThisPeriod / 1_000_000).toFixed(2)}
            </td>
            <td style={td}>${(r.remainingUsdMicros / 1_000_000).toFixed(2)}</td>
            <td style={td}>
              ${(r.projectedSpendUsdMicros / 1_000_000).toFixed(2)}
            </td>
            <td style={td}>
              <ThresholdBadge status={r.thresholdStatus} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BreachTable({ rows }: { rows: ReadonlyArray<BudgetBreachRow> }) {
  if (rows.length === 0) {
    return <p style={{ color: "#475569", fontSize: 12 }}>No breaches in window.</p>;
  }
  return (
    <table data-budget-breach-table style={tableStyle}>
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>When</th>
          <th style={th}>Threshold</th>
          <th style={th}>Scope</th>
          <th style={th}>Target</th>
          <th style={th}>Provider</th>
          <th style={th}>Period</th>
          <th style={th}>Consumed</th>
          <th style={th}>Hard</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} data-budget-breach-row={r.id} data-threshold={r.threshold}>
            <td style={td}>{new Date(r.occurredAtUtc).toLocaleString()}</td>
            <td style={td}>
              <strong style={{ color: r.threshold === "HARD" ? "#b91c1c" : "#a16207" }}>
                {r.threshold}
              </strong>
            </td>
            <td style={td}>{r.budgetScope}</td>
            <td style={td}>
              {r.budgetScopeTargetId ? (
                <code>{r.budgetScopeTargetId.slice(0, 8)}…</code>
              ) : (
                "—"
              )}
            </td>
            <td style={td}>{r.budgetProvider ?? "ALL"}</td>
            <td style={td}>{r.budgetPeriod}</td>
            <td style={td}>${(r.consumedUsdMicros / 1_000_000).toFixed(2)}</td>
            <td style={td}>${(r.hardLimitUsdMicros / 1_000_000).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ThresholdBadge({ status }: { status: BudgetSpendRow["thresholdStatus"] }) {
  const color =
    status === "EXHAUSTED" || status === "BLOCK"
      ? "#b91c1c"
      : status === "WARN"
      ? "#a16207"
      : "#15803d";
  return (
    <strong style={{ color, fontSize: 11 }}>{status}</strong>
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
const section = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  overflowX: "auto" as const,
};
const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 };
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
