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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  MEDIA_INTELLIGENCE_PROVIDERS,
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_BUDGET_PERIODS,
  PROVIDER_BUDGET_SCOPES,
  type MediaIntelligenceProvider,
  type ProviderAdapterOperation,
  type ProviderAdapterProbe,
  type ProviderBudgetPeriod,
  type ProviderBudgetProjection,
  type ProviderBudgetScope,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { usePlatformContext } from "../../lib/platform-context";

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
        <ProviderBudgetCreateForm onCreated={refresh} />
        {budgets.length === 0 ? (
          <p style={{ color: "#475569", fontSize: 12 }} data-intelligence-budgets-empty>
            No budgets defined yet. Create one above to cap provider spend for
            this workspace.
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

// ---------------------------------------------------------------------------
// PHASE 13 §UI — provider spend budget CREATE.
//
// Closes POST /v1/intelligence/providers/budgets
// (services/api/src/routes/intelligence-platform.routes.ts:634). The budgets
// table above, and /budget-center, were read-only: a workspace could see spend
// and breaches but could never author the limit that produces them.
//
// Server contract:
//   * Body (BudgetCreateBody, intelligence-platform.routes.ts:118)
//       scope             enum(PROVIDER_BUDGET_SCOPES)     required
//       scopeTargetId     uuid | null                      optional
//       provider          enum(MEDIA_INTELLIGENCE_PROVIDERS) | null optional
//       period            enum(PROVIDER_BUDGET_PERIODS)    required
//       softLimitUsdMicros  positive int                   required
//       hardLimitUsdMicros  positive int                   required
//   * teamId is NOT in the body — the route derives the workspace from the
//     caller's current workspace (`authorizeWorkspace`), which is why this
//     form states which workspace it will write to and refuses to submit
//     without a resolved active workspace.
//   * Authorization: `intelligence.policy.manage` (OWNER/ADMIN only). The
//     client-side mirror is the BILLING_MANAGE capability, granted to exactly
//     OWNER + ADMIN by capability-registry.ts — cost controls are the same
//     admin tier. The server remains the authority; this only avoids
//     rendering an enabled control that must 403.
//   * Responses: 201 {budgetId}; 409 {denial} for a policy-rejected budget
//     (bad limits / missing scope target); 401/403/404; >=500.
//
// The client mirrors createBudget's own rejection rules
// (services/api/src/services/intelligence/provider-budget.service.ts:78-97)
// so a request that cannot succeed is never sent.
// ---------------------------------------------------------------------------

type BudgetFormStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "created"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function usdToMicros(raw: string): number | null {
  if (!/^\d+(\.\d{1,6})?$/.test(raw.trim())) return null;
  const micros = Math.round(Number(raw.trim()) * 1_000_000);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  return micros;
}

function ProviderBudgetCreateForm({
  onCreated,
}: {
  onCreated: () => void | Promise<void>;
}) {
  const { can, activeWorkspaceId, contextGeneration } = usePlatformContext();
  const canManage = can("BILLING_MANAGE");

  const [scope, setScope] = useState<ProviderBudgetScope>("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [provider, setProvider] = useState<MediaIntelligenceProvider | "">("");
  const [period, setPeriod] = useState<ProviderBudgetPeriod>("MONTHLY");
  const [softLimitUsd, setSoftLimitUsd] = useState("");
  const [hardLimitUsd, setHardLimitUsd] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<BudgetFormStatus>({ kind: "idle" });

  // Stale-response protection: only the newest submit may write state, an
  // unmounted form writes nothing, and a workspace switch mid-flight
  // invalidates the response (the server scoped it to the OLD workspace).
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = status.kind === "saving";
  const disabled = busy || !canManage || !activeWorkspaceId;
  const targetRequired = scope === "CASE" || scope === "PROJECT";
  const providerRequired = scope === "PROVIDER";

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (disabled) return;

      const next: Record<string, string> = {};
      if (!(PROVIDER_BUDGET_SCOPES as readonly string[]).includes(scope)) {
        next.scope = "Choose a budget scope.";
      }
      if (!(PROVIDER_BUDGET_PERIODS as readonly string[]).includes(period)) {
        next.period = "Choose a budget period.";
      }
      const target = scopeTargetId.trim();
      if (targetRequired && !target) {
        next.scopeTargetId = `A ${scope.toLowerCase()} id is required for this scope.`;
      } else if (target && !UUID_RE.test(target)) {
        next.scopeTargetId = "Scope target must be a valid id (UUID).";
      }
      if (providerRequired && !provider) {
        next.provider = "Pick a provider for a provider-scoped budget.";
      }

      const soft = usdToMicros(softLimitUsd);
      const hard = usdToMicros(hardLimitUsd);
      if (soft === null) {
        next.softLimitUsd = "Enter a soft limit greater than $0.";
      }
      if (hard === null) {
        next.hardLimitUsd = "Enter a hard limit greater than $0.";
      }
      if (soft !== null && hard !== null && soft > hard) {
        next.hardLimitUsd =
          "The hard limit must be greater than or equal to the soft limit.";
      }

      if (Object.keys(next).length > 0 || soft === null || hard === null) {
        setErrors(next);
        setStatus({
          kind: "invalid",
          message:
            "Some details need attention before this budget can be created. Check the highlighted fields.",
        });
        return;
      }
      setErrors({});

      const mine = ++seq.current;
      const generationAtStart = contextGeneration;
      setStatus({ kind: "saving" });
      try {
        await apiFetch("/v1/intelligence/providers/budgets", {
          method: "POST",
          body: JSON.stringify({
            scope,
            scopeTargetId: target ? target : null,
            provider: provider ? provider : null,
            period,
            softLimitUsdMicros: soft,
            hardLimitUsdMicros: hard,
          }),
        });
        if (
          !mounted.current ||
          mine !== seq.current ||
          generationAtStart !== contextGeneration
        ) {
          return;
        }
        setStatus({ kind: "created", message: "Budget created." });
        setScopeTargetId("");
        setSoftLimitUsd("");
        setHardLimitUsd("");
        await onCreated();
      } catch (err) {
        if (
          !mounted.current ||
          mine !== seq.current ||
          generationAtStart !== contextGeneration
        ) {
          return;
        }
        const e = err as { statusCode?: number };
        const code = typeof e.statusCode === "number" ? e.statusCode : 0;
        if (code === 403) {
          setStatus({
            kind: "denied",
            message:
              "You don't have permission to set provider budgets in this workspace. Ask a workspace owner or admin.",
          });
          return;
        }
        if (code === 409) {
          setStatus({
            kind: "invalid",
            message:
              "That budget was refused by policy. Check the scope target, the provider, and that the hard limit is at least the soft limit.",
          });
          return;
        }
        if (code === 400) {
          setStatus({
            kind: "invalid",
            message:
              "The service rejected these details. Review the scope, period and limits and try again.",
          });
          return;
        }
        if (code === 404) {
          setStatus({
            kind: "error",
            message:
              "No active workspace context was found for this request. Switch workspace and try again.",
          });
          return;
        }
        // 401 / >=500 / network / unexpected 4xx — bounded copy only; the raw
        // error body is NEVER rendered.
        setStatus({
          kind: "error",
          message: toSafeUserError(err, {
            message: "We couldn't create this budget. Please try again.",
          }).message,
        });
      }
    },
    [
      disabled,
      scope,
      period,
      scopeTargetId,
      targetRequired,
      providerRequired,
      provider,
      softLimitUsd,
      hardLimitUsd,
      contextGeneration,
      onCreated,
    ],
  );

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={busy}
      data-intelligence-budget-form
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 10,
        margin: "8px 0",
      }}
    >
      <strong style={{ fontSize: 12 }}>Create a spend budget</strong>
      <p style={{ color: "#475569", fontSize: 11, margin: "4px 0 8px" }}>
        Limits are enforced before every paid provider call: the soft limit
        warns, the hard limit refuses. The budget applies to the workspace you
        are currently in.
      </p>

      {!canManage ? (
        <p
          data-intelligence-budget-permission-denied
          style={{ fontSize: 11, color: "#7f1d1d", margin: "0 0 8px" }}
        >
          You have read-only access to cost controls. Creating a budget is
          limited to workspace owners and admins.
        </p>
      ) : null}
      {!activeWorkspaceId ? (
        <p
          data-intelligence-budget-no-workspace
          style={{ fontSize: 11, color: "#7f1d1d", margin: "0 0 8px" }}
        >
          No active workspace is resolved yet, so there is nothing to budget
          against.
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 8,
        }}
      >
        <div style={lblStyle}>
          <label htmlFor="budget-scope">Scope (required)</label>
          <select
            id="budget-scope"
            data-intelligence-budget-scope
            value={scope}
            disabled={disabled}
            aria-invalid={errors.scope ? true : undefined}
            onChange={(e) => setScope(e.target.value as ProviderBudgetScope)}
            style={inputStyle}
          >
            {PROVIDER_BUDGET_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {errors.scope ? <span style={errStyle}>{errors.scope}</span> : null}
        </div>

        <div style={lblStyle}>
          <label htmlFor="budget-period">Period (required)</label>
          <select
            id="budget-period"
            data-intelligence-budget-period
            value={period}
            disabled={disabled}
            aria-invalid={errors.period ? true : undefined}
            onChange={(e) => setPeriod(e.target.value as ProviderBudgetPeriod)}
            style={inputStyle}
          >
            {PROVIDER_BUDGET_PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {errors.period ? <span style={errStyle}>{errors.period}</span> : null}
        </div>

        <div style={lblStyle}>
          <label htmlFor="budget-provider">
            Provider {providerRequired ? "(required)" : "(optional — all)"}
          </label>
          <select
            id="budget-provider"
            data-intelligence-budget-provider
            value={provider}
            disabled={disabled}
            aria-invalid={errors.provider ? true : undefined}
            onChange={(e) =>
              setProvider(e.target.value as MediaIntelligenceProvider | "")
            }
            style={inputStyle}
          >
            <option value="">All providers</option>
            {MEDIA_INTELLIGENCE_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {errors.provider ? (
            <span style={errStyle}>{errors.provider}</span>
          ) : null}
        </div>

        <div style={lblStyle}>
          <label htmlFor="budget-scope-target">
            Scope target id {targetRequired ? "(required)" : "(optional)"}
          </label>
          <input
            id="budget-scope-target"
            data-intelligence-budget-scope-target
            value={scopeTargetId}
            disabled={disabled}
            aria-invalid={errors.scopeTargetId ? true : undefined}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => setScopeTargetId(e.target.value)}
            style={inputStyle}
          />
          {errors.scopeTargetId ? (
            <span style={errStyle}>{errors.scopeTargetId}</span>
          ) : null}
        </div>

        <div style={lblStyle}>
          <label htmlFor="budget-soft-limit">Soft limit (USD, required)</label>
          <input
            id="budget-soft-limit"
            data-intelligence-budget-soft-limit
            value={softLimitUsd}
            disabled={disabled}
            inputMode="decimal"
            aria-invalid={errors.softLimitUsd ? true : undefined}
            placeholder="100"
            onChange={(e) => setSoftLimitUsd(e.target.value)}
            style={inputStyle}
          />
          {errors.softLimitUsd ? (
            <span style={errStyle}>{errors.softLimitUsd}</span>
          ) : null}
        </div>

        <div style={lblStyle}>
          <label htmlFor="budget-hard-limit">Hard limit (USD, required)</label>
          <input
            id="budget-hard-limit"
            data-intelligence-budget-hard-limit
            value={hardLimitUsd}
            disabled={disabled}
            inputMode="decimal"
            aria-invalid={errors.hardLimitUsd ? true : undefined}
            placeholder="250"
            onChange={(e) => setHardLimitUsd(e.target.value)}
            style={inputStyle}
          />
          {errors.hardLimitUsd ? (
            <span style={errStyle}>{errors.hardLimitUsd}</span>
          ) : null}
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        data-intelligence-budget-status={status.kind}
        style={{
          minHeight: 16,
          fontSize: 11,
          margin: "8px 0",
          color:
            status.kind === "created"
              ? "#166534"
              : status.kind === "idle" || status.kind === "saving"
              ? "#475569"
              : "#b91c1c",
        }}
      >
        {status.kind === "saving"
          ? "Creating budget…"
          : status.kind === "idle"
          ? ""
          : status.message}
      </div>

      <button
        type="submit"
        data-intelligence-budget-submit
        disabled={disabled}
        aria-busy={busy}
        title={
          canManage
            ? undefined
            : "Requires workspace owner or admin (BILLING_MANAGE)."
        }
        style={{
          ...primaryButton,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {busy ? "Creating…" : "Create budget"}
      </button>
    </form>
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
const errStyle = { fontSize: 10, color: "#b91c1c" } as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
