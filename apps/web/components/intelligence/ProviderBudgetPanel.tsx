"use client";

/**
 * PROOVRA Phase 2B (Intelligence consolidation) — Provider / cost / budget
 * panel.
 *
 * Extracted verbatim from the former `/intelligence-platform` page
 * (`IntelligencePlatformShell`) so its useful enterprise content — provider
 * health ribbon, 7-day cost summary, budgets list, and the inline
 * quick-provider-run form — lives inside the canonical `/intelligence`
 * surface. The standalone `/intelligence-platform` route was deleted; this
 * component is the single canonical home for that content.
 *
 * Hard rules (unchanged from the original surface):
 *   * All writes round-trip through the bounded API.
 *   * NEVER raw provider payloads — counts + bands only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  MEDIA_INTELLIGENCE_PROVIDERS,
  PROVIDER_ADAPTER_OPERATIONS,
  type MediaIntelligenceProvider,
  type ProviderAdapterOperation,
  type ProviderAdapterProbe,
  type ProviderBudgetProjection,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";

export function ProviderBudgetPanel() {
  const [probes, setProbes] = useState<ProviderAdapterProbe[]>([]);
  const [budgets, setBudgets] = useState<ProviderBudgetProjection[]>([]);
  const [usageSummary, setUsageSummary] = useState<
    Array<{ provider: string; operation: string; unit: string; callCount: number; estimatedCostUsdMicros: number }>
  >([]);
  const [evidenceId, setEvidenceId] = useState("");
  const [provider, setProvider] = useState<MediaIntelligenceProvider>(
    "AZURE_DOCUMENT_INTELLIGENCE",
  );
  const [operation, setOperation] = useState<ProviderAdapterOperation>(
    "OCR_DOCUMENT",
  );
  const [text, setText] = useState("");
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await apiFetch("/v1/intelligence/providers/health", {
        method: "GET",
      });
      setProbes((h?.providers ?? []) as ProviderAdapterProbe[]);
    } catch {
      setProbes([]);
    }
    try {
      const u = await apiFetch("/v1/intelligence/providers/usage", {
        method: "GET",
      });
      setUsageSummary(u?.summary ?? []);
    } catch {
      setUsageSummary([]);
    }
    try {
      const b = await apiFetch("/v1/intelligence/providers/budgets", {
        method: "GET",
      });
      setBudgets((b?.budgets ?? []) as ProviderBudgetProjection[]);
    } catch {
      setBudgets([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalCostUsd = useMemo(
    () =>
      usageSummary.reduce(
        (acc, r) => acc + r.estimatedCostUsdMicros / 1_000_000,
        0,
      ),
    [usageSummary],
  );

  const onRunText = useCallback(async () => {
    if (!evidenceId || !text.trim()) return;
    try {
      const res = await apiFetch(
        `/v1/intelligence/evidence/${encodeURIComponent(evidenceId)}/run/text`,
        {
          method: "POST",
          body: JSON.stringify({ provider, operation, text }),
        },
      );
      setBanner(
        `Run completed · ${res?.insertedRecords ?? 0} records · ${res?.insertedEntities ?? 0} entities · decision=${res?.decision ?? "?"}`,
      );
      await refresh();
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reason = (err as any)?.reason ?? "POLICY_REJECTED";
      setBanner(`Refused: ${reason}`);
    }
  }, [evidenceId, provider, operation, text, refresh]);

  return (
    <div
      data-intelligence-platform-page
      style={{
        marginTop: 12,
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>
          Provider platform · cost &amp; budgets
        </h2>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Provider health across Azure Document Intelligence, Deepgram, AWS
          Rekognition, and OpenAI, with confidence banding, cost controls, and
          an inline quick-run for ad-hoc reviewer use.
        </p>
      </header>

      {banner ? (
        <div
          data-intelligence-banner
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            background: "rgba(15, 23, 42, 0.05)",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          {banner}
        </div>
      ) : null}

      <section data-intelligence-provider-health style={panelStyle}>
        <strong style={{ fontSize: 13 }}>Provider health</strong>
        <div
          style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}
        >
          {probes.map((p) => (
            <span
              key={p.provider}
              data-intelligence-provider-row={p.provider}
              data-intelligence-provider-state={p.state}
              title={p.reason ?? ""}
              style={chipStyle(p.state)}
            >
              {p.provider} · {p.state}
            </span>
          ))}
        </div>
      </section>

      <section data-intelligence-cost-summary style={panelStyle}>
        <strong style={{ fontSize: 13 }}>Cost summary · last 7d</strong>
        <p style={{ color: "#475569", fontSize: 12 }}>
          Total est. spend:{" "}
          <strong data-intelligence-total-cost>
            ${totalCostUsd.toFixed(2)}
          </strong>{" "}
          · NEVER includes blocked calls (those show as <code>BLOCK</code> in
          the audit centre).
        </p>
        <table
          data-intelligence-cost-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Provider</th>
              <th style={th}>Operation</th>
              <th style={th}>Unit</th>
              <th style={th}>Calls</th>
              <th style={th}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {usageSummary.map((r, idx) => (
              <tr key={`${r.provider}:${r.operation}:${idx}`}>
                <td style={td}>
                  <code>{r.provider}</code>
                </td>
                <td style={td}>{r.operation}</td>
                <td style={td}>{r.unit}</td>
                <td style={td}>{r.callCount}</td>
                <td style={td}>
                  ${(r.estimatedCostUsdMicros / 1_000_000).toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-intelligence-budgets style={panelStyle}>
        <strong style={{ fontSize: 13 }}>Budgets</strong>
        {budgets.length === 0 ? (
          <p style={{ color: "#475569", fontSize: 12 }}>
            No budgets defined yet.
          </p>
        ) : (
          <table
            data-intelligence-budgets-table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
              marginTop: 6,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={th}>Scope</th>
                <th style={th}>Provider</th>
                <th style={th}>Period</th>
                <th style={th}>Soft</th>
                <th style={th}>Hard</th>
                <th style={th}>Consumed</th>
                <th style={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr
                  key={b.id}
                  data-intelligence-budget-row={b.id}
                  data-intelligence-budget-state={b.state}
                >
                  <td style={td}>{b.scope}</td>
                  <td style={td}>
                    {b.provider ? <code>{b.provider}</code> : "all"}
                  </td>
                  <td style={td}>{b.period}</td>
                  <td style={td}>
                    ${(b.softLimitUsdMicros / 1_000_000).toFixed(2)}
                  </td>
                  <td style={td}>
                    ${(b.hardLimitUsdMicros / 1_000_000).toFixed(2)}
                  </td>
                  <td style={td}>
                    ${(b.consumedUsdMicrosThisPeriod / 1_000_000).toFixed(4)}
                  </td>
                  <td style={td}>{b.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-intelligence-quick-run style={panelStyle}>
        <strong style={{ fontSize: 13 }}>Quick provider run · inline text</strong>
        <p style={{ color: "#475569", fontSize: 11 }}>
          For ad-hoc reviewer use. Paste OCR / transcript / document text to
          trigger an EXTRACT_ENTITIES or SUMMARISE_DOCUMENT call; inserted
          records appear in the evidence&apos;s record list.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <label style={lblStyle}>
            Evidence id
            <input
              data-intelligence-run-evidence-id
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              style={inputStyle}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <label style={lblStyle}>
            Provider
            <select
              data-intelligence-run-provider
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as MediaIntelligenceProvider)
              }
              style={inputStyle}
            >
              {MEDIA_INTELLIGENCE_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label style={lblStyle}>
            Operation
            <select
              data-intelligence-run-operation
              value={operation}
              onChange={(e) =>
                setOperation(e.target.value as ProviderAdapterOperation)
              }
              style={inputStyle}
            >
              {PROVIDER_ADAPTER_OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          data-intelligence-run-text
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Paste OCR text / transcript here for EXTRACT_ENTITIES or SUMMARISE_DOCUMENT"
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            boxSizing: "border-box",
          }}
        />
        <button
          type="button"
          data-intelligence-run-submit
          onClick={onRunText}
          disabled={!evidenceId || !text.trim()}
          style={{ ...primaryButton, marginTop: 6 }}
        >
          Run provider
        </button>
      </section>
    </div>
  );
}

function chipStyle(state: string): React.CSSProperties {
  const tone =
    state === "READY"
      ? { bg: "rgba(34, 197, 94, 0.12)", fg: "#166534" }
      : state === "DISABLED_BY_POLICY" || state === "RATE_LIMITED"
      ? { bg: "rgba(59, 130, 246, 0.1)", fg: "#1e3a8a" }
      : state === "ERROR" || state === "BUDGET_EXCEEDED"
      ? { bg: "rgba(239, 68, 68, 0.1)", fg: "#7f1d1d" }
      : { bg: "rgba(15, 23, 42, 0.06)", fg: "#0f172a" };
  return {
    padding: "3px 8px",
    borderRadius: 999,
    background: tone.bg,
    color: tone.fg,
    fontSize: 11,
    fontWeight: 600,
  };
}

const panelStyle = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
} as const;
const lblStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
  fontSize: 11,
  color: "#475569",
};
const inputStyle = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  boxSizing: "border-box" as const,
};
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
