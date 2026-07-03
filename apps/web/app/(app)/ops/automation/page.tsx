"use client";

/**
 * Phase E3 — Operational Automation page.
 *
 * Lives UNDER the Operations Center hub (`/ops/automation`). NOT a
 * root nav item — 32.8 IA pinned by Test 1 + Test 2 keeps root at the
 * 6 canonical primaries.
 *
 * Scope:
 *   - List rules with enabled / trigger / action / last-run
 *   - View run history (no execution yet — dispatcher is E3.1)
 *   - Enable / Disable existing rules
 *   - Show the bounded trigger + action allowlists
 *
 * Hard rules (also enforced by phase-e3-automation-foundation.test.ts):
 *   - No drag-and-drop builder.
 *   - No visual workflow canvas.
 *   - No scripting / code editor.
 *   - No AI workflow generator.
 *   - No marketplace / template gallery.
 *   - All numbers / counters trace back to real backend rows.
 *
 * Rule create + edit UI is intentionally minimal in E3 — a future
 * E3.1 phase will refine the form. For now, this page focuses on
 * VISIBILITY of existing automation state, which is the prerequisite
 * for the trigger dispatcher to land safely.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import {
  useActiveSpaceId,
  usePlatformContext,
} from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { formatUserDateTime } from "../../../../lib/date";

type AutomationRule = {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  conditionJson: unknown;
  actionType: string;
  actionConfigJson: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

type AutomationRun = {
  id: string;
  teamId: string;
  ruleId: string;
  triggerType: string;
  targetType: string;
  targetId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

type RulesEnvelope = {
  rules: AutomationRule[];
  allowlist: {
    triggerTypes: readonly string[];
    actionTypes: readonly string[];
  };
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: RulesEnvelope; runs: AutomationRun[] }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

// ---------------------------------------------------------------------------
// Inner page (PageRouteGate handles capability gating)
// ---------------------------------------------------------------------------

function AutomationPageInner(): JSX.Element {
  const ctx = usePlatformContext();
  const teamId = useActiveSpaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const canManage = ctx.can("AUTOMATION_MANAGE");

  useEffect(() => {
    if (!teamId) {
      setState({ status: "loading" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const [envelope, runsResp] = await Promise.all([
          apiFetch(
            `/v1/automation/rules?teamId=${encodeURIComponent(teamId)}`,
          ) as Promise<RulesEnvelope>,
          apiFetch(
            `/v1/automation/runs?teamId=${encodeURIComponent(teamId)}&limit=50`,
          ) as Promise<{ runs: AutomationRun[] }>,
        ]);
        if (cancelled) return;
        setState({ status: "ready", envelope, runs: runsResp.runs });
      } catch (err) {
        if (cancelled) return;
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 401) {
          setState({ status: "auth_error", code: "auth_required" });
        } else if (e.statusCode === 403) {
          setState({ status: "auth_error", code: "permission_denied" });
        } else {
          setState({
            status: "unavailable",
            message: e.message ?? "Unable to load automation.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // ----- Render branches -----

  if (state.status === "loading") {
    return (
      <main className="cc-page" data-automation-loading>
        <header className="cc-page-header">
          <div>
            <div className="cc-kicker">Operations Center · Automation</div>
            <h1 className="cc-title">Automation rules</h1>
          </div>
        </header>
        <section className="cc-section">
          <div className="cc-skeleton" />
        </section>
      </main>
    );
  }

  if (state.status === "auth_error") {
    return (
      <main className="cc-page" data-automation-auth-error={state.code}>
        <header className="cc-page-header">
          <div>
            <div className="cc-kicker">Operations Center · Automation</div>
            <h1 className="cc-title">
              {state.code === "auth_required"
                ? "Sign in required"
                : "Permission required"}
            </h1>
            <p className="cc-subtitle">
              Automation visibility requires the AUTOMATION_VIEW capability
              (team writer or admin).
            </p>
          </div>
        </header>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="cc-page" data-automation-unavailable>
        <header className="cc-page-header">
          <div>
            <div className="cc-kicker">Operations Center · Automation</div>
            <h1 className="cc-title">Automation temporarily unavailable</h1>
            <p className="cc-subtitle">{state.message}</p>
          </div>
        </header>
      </main>
    );
  }

  const { envelope, runs } = state;
  const enabledCount = envelope.rules.filter((r) => r.enabled).length;

  return (
    <main className="cc-page" data-automation-ready>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Operations Center · Automation</div>
          <h1 className="cc-title">Automation rules</h1>
          <p className="cc-subtitle">
            Bounded operational automation. Each rule has a strictly-typed
            trigger and a strictly-typed action — no scripts, no visual
            builder, no marketplace. Rules are team-scoped and audited.
          </p>
        </div>
        <div className="cc-meta">
          <span data-automation-counts>
            {envelope.rules.length} rule
            {envelope.rules.length === 1 ? "" : "s"} ·{" "}
            {enabledCount} enabled
          </span>
        </div>
      </header>

      {/* Phase E3.1 — execution runtime active. The dispatcher accepts
          trigger events from internal services, matches enabled rules,
          and synchronously executes the bounded action handlers. Each
          lifecycle transition emits an `automation_*` security event. */}
      <section
        className="cc-section"
        data-automation-execution-notice
        style={{
          borderLeft: "4px solid #10b981",
          paddingLeft: 12,
          background: "#f0fdf4",
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "#065f46" }}>
          <strong>Phase E3.1 — execution runtime active.</strong> Enabled
          rules execute when matching trigger events fire from internal
          services. Rules are always created disabled by default; flip
          the enable switch only after reviewing the action config. The
          webhook action (DEF-022) remains deferred.
        </p>
      </section>

      {/* Rules list */}
      <section className="cc-section" data-automation-rules-list>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Rules</h2>
          {canManage ? (
            <span
              className="cc-section-subtitle"
              data-automation-manage-hint
            >
              Owner/admin: create + edit + enable + disable via API
              (form UI lands in E3.1)
            </span>
          ) : (
            <span className="cc-section-subtitle">View-only access</span>
          )}
        </header>
        {envelope.rules.length === 0 ? (
          <div className="cc-empty" data-automation-empty>
            <p>No automation rules configured yet.</p>
            <p style={{ fontSize: 12, color: "#64748b" }}>
              Allowed triggers: {envelope.allowlist.triggerTypes.length}.
              Allowed actions: {envelope.allowlist.actionTypes.length}.
            </p>
          </div>
        ) : (
          <table
            className="cc-table"
            data-automation-rules-table
            style={{ width: "100%", fontSize: 13 }}
          >
            <thead>
              <tr>
                <th>Name</th>
                <th>Trigger</th>
                <th>Action</th>
                <th>Enabled</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {envelope.rules.map((r) => (
                <tr key={r.id} data-automation-rule-id={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.description ? (
                      <div style={{ fontSize: 12, color: "#64748b" }}>
                        {r.description}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <code style={{ fontSize: 12 }}>{r.triggerType}</code>
                  </td>
                  <td>
                    <code style={{ fontSize: 12 }}>{r.actionType}</code>
                  </td>
                  <td data-automation-rule-enabled={String(r.enabled)}>
                    {r.enabled ? "Yes" : "No"}
                  </td>
                  <td style={{ color: "#64748b", fontSize: 12 }}>
                    {formatUserDateTime(r.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Run history */}
      <section className="cc-section" data-automation-runs-list>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Recent runs</h2>
          <span className="cc-section-subtitle">
            Latest {runs.length} run
            {runs.length === 1 ? "" : "s"}
          </span>
        </header>
        {runs.length === 0 ? (
          <div className="cc-empty">
            <p>No automation runs recorded yet.</p>
            <p style={{ fontSize: 12, color: "#64748b" }}>
              Runs appear here once the E3.1 trigger dispatcher is wired.
            </p>
          </div>
        ) : (
          <table
            className="cc-table"
            data-automation-runs-table
            style={{ width: "100%", fontSize: 13 }}
          >
            <thead>
              <tr>
                <th>When</th>
                <th>Trigger</th>
                <th>Target</th>
                <th>Status</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-automation-run-id={r.id}>
                  <td style={{ color: "#64748b", fontSize: 12 }}>
                    {formatUserDateTime(r.createdAt)}
                  </td>
                  <td>
                    <code style={{ fontSize: 12 }}>{r.triggerType}</code>
                  </td>
                  <td>
                    <code style={{ fontSize: 12 }}>
                      {r.targetType}:{r.targetId.slice(0, 8)}…
                    </code>
                  </td>
                  <td data-automation-run-status={r.status}>{r.status}</td>
                  <td style={{ color: "#64748b", fontSize: 12 }}>
                    {r.reason ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Allowlist reference */}
      <section className="cc-section" data-automation-allowlists>
        <header className="cc-section-header">
          <h2 className="cc-section-title">Bounded allowlists</h2>
          <span className="cc-section-subtitle">
            Read-only. Adding a value requires a coordinated DB migration.
          </span>
        </header>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <h3 style={{ fontSize: 13 }}>Trigger types</h3>
            <ul style={{ fontSize: 12, color: "#475569" }}>
              {envelope.allowlist.triggerTypes.map((t) => (
                <li key={t}>
                  <code>{t}</code>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 style={{ fontSize: 13 }}>Action types</h3>
            <ul style={{ fontSize: 12, color: "#475569" }}>
              {envelope.allowlist.actionTypes.map((a) => (
                <li key={a}>
                  <code>{a}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Default export — PageRouteGate wrapper enforces AUTOMATION_VIEW.
// ---------------------------------------------------------------------------

export default function AutomationPage(): JSX.Element {
  return (
    <PageRouteGate routeId="platform.automation">
      <AutomationPageInner />
    </PageRouteGate>
  );
}
