"use client";

/**
 * Phase E3 — Operational Automation page.
 *
 * Lives UNDER the Operations Center hub (`/admin/platform/automation`). NOT a
 * root nav item — 32.8 IA pinned by Test 1 + Test 2 keeps root at the
 * 6 canonical primaries.
 *
 * Scope:
 *   - List rules with enabled / trigger / action / last-run
 *   - View run history (no execution yet — dispatcher is E3.1)
 *   - Create / Edit rules (PHASE 13 §UI — the lifecycle is now reachable
 *     from the product; see components/automation/AutomationRuleForm.tsx)
 *   - Enable / Disable existing rules (AutomationRuleToggle — one control,
 *     whose leg is derived from the rule's CURRENT state)
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
 * PHASE 13 §UI (2026-08-16) — the deferred rule-form work is CLOSED.
 * Create, edit, enable and disable are all reachable here; the four
 * lifecycle routes had no product surface at all before this.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import {
  useActiveSpaceId,
  usePlatformContext,
} from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { AutomationRuleForm } from "../../../../../components/automation/AutomationRuleForm";
import { AutomationRuleToggle } from "../../../../../components/automation/AutomationRuleToggle";
import type { AutomationRule } from "../../../../../components/automation/types";
import { formatUserDateTime } from "../../../../../lib/date";

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
  // PHASE 13 §UI — bumped by every successful lifecycle mutation so the rule
  // list is refetched from the server (the projection, including `version`
  // and `disabledAt`, is the server's to compute — never patched locally).
  const [reloadToken, setReloadToken] = useState(0);
  const [formMode, setFormMode] = useState<
    { kind: "closed" } | { kind: "create" } | { kind: "edit"; ruleId: string }
  >({ kind: "closed" });
  const [lastAction, setLastAction] = useState<string | null>(null);
  const canManage = ctx.can("AUTOMATION_MANAGE");

  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!teamId) {
      setState({ status: "loading" });
      return;
    }
    let cancelled = false;
    // Keep the ready surface mounted across a post-mutation refetch — a
    // flash back to the skeleton would unmount the very control the user
    // just used (and its success message) mid-announcement.
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
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
            message: toSafeUserError(e, { message: "Unable to load automation." }).message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, reloadToken]);

  // ----- Render branches -----

  if (state.status === "loading") {
    return (
      <PageShell
      width="full" data-automation-loading
      header={
        <PageHeader
          eyebrow={"Operations Center · Automation"}
          title={"Automation rules"}
        />
      }
    >
        <section className="apf-section">
          <div className="cc-skeleton" />
        </section>
      </PageShell>
    );
  }

  if (state.status === "auth_error") {
    return (
      <PageShell
      width="full" data-automation-auth-error={state.code}
      header={
        <PageHeader
          eyebrow={"Operations Center · Automation"}
          title={state.code === "auth_required"
                ? "Sign in required"
                : "Permission required"}
          subtitle={"Automation visibility requires the AUTOMATION_VIEW capability (team writer or admin)."}
        />
      }
    >
      </PageShell>
    );
  }

  if (state.status === "unavailable") {
    return (
      <PageShell
      width="full" data-automation-unavailable
      header={
        <PageHeader
          eyebrow={"Operations Center · Automation"}
          title={"Automation temporarily unavailable"}
          subtitle={state.message}
        />
      }
    >
      </PageShell>
    );
  }

  const { envelope, runs } = state;
  const enabledCount = envelope.rules.filter((r) => r.enabled).length;
  const editingRule =
    formMode.kind === "edit"
      ? envelope.rules.find((r) => r.id === formMode.ruleId) ?? null
      : null;

  const closeForm = () => setFormMode({ kind: "closed" });
  const afterSave = (message: string) => {
    setLastAction(message);
    setFormMode({ kind: "closed" });
    reload();
  };

  return (
    <PageShell
      width="full" data-automation-ready
      header={
        <PageHeader
          eyebrow={"Operations Center · Automation"}
          title={"Automation rules"}
          subtitle={"Bounded operational automation. Each rule has a strictly-typed trigger and a strictly-typed action — no scripts, no visual builder, no marketplace. Rules are team-scoped and audited."}
          secondaryActions={
            <>
              <div className="cc-meta">
              <span data-automation-counts>
              {envelope.rules.length} rule
              {envelope.rules.length === 1 ? "" : "s"} ·{" "}
              {enabledCount} enabled
              </span>
              </div>
            </>
          }
        />
      }
    >

      {/* Phase E3.1 — execution runtime active. The dispatcher accepts
          trigger events from internal services, matches enabled rules,
          and synchronously executes the bounded action handlers. Each
          lifecycle transition emits an `automation_*` security event. */}
      <section
        className="apf-section"
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
      <section className="apf-section" data-automation-rules-list>
        <header className="cc-section-header">
          <h2 className="apf-section-title">Rules</h2>
          <span
            className="cc-section-subtitle"
            data-automation-manage-hint
          >
            {/*
              PHASE 13 (NEW-034) — both requirements, stated.
              This console is a PLATFORM-ADMIN surface (`platform.automation`
              declares `requiredActiveSpace: "PLATFORM_ADMIN"`), while
              AUTOMATION_MANAGE is a WORKSPACE capability held by an owner or
              admin. Naming only the second told a workspace owner who is not a
              platform admin that they were one capability away from acting,
              when in fact they cannot open this page at all.
            */}
            {canManage
              ? "Owner/admin: create, edit, enable and disable rules here."
              : "View-only access — changing a rule needs the AUTOMATION_MANAGE capability, held by a workspace owner or admin, on this platform-admin console. Both are required."}
          </span>
          <button
            type="button"
            data-automation-new-rule
            onClick={() => {
              setLastAction(null);
              setFormMode({ kind: "create" });
            }}
            disabled={!canManage || formMode.kind === "create" || !teamId}
            title={
              canManage
                ? undefined
                : "Requires the AUTOMATION_MANAGE capability (workspace owner or admin) on this platform-admin console."
            }
            style={newRuleButtonStyle(
              !canManage || formMode.kind === "create" || !teamId,
            )}
          >
            New rule
          </button>
        </header>

        {/* Page-level screen-reader status for a control that closes on
            success (the form unmounts with its own status region). */}
        <div
          role="status"
          aria-live="polite"
          data-automation-page-status
          style={{ minHeight: 16, fontSize: 12, color: "#166534" }}
        >
          {lastAction ?? ""}
        </div>

        {formMode.kind === "create" && teamId ? (
          <AutomationRuleForm
            mode="create"
            teamId={teamId}
            triggerTypes={envelope.allowlist.triggerTypes}
            actionTypes={envelope.allowlist.actionTypes}
            canManage={canManage}
            onSaved={() =>
              afterSave(
                "Rule created. It starts disabled — review it, then enable it.",
              )
            }
            onCancel={closeForm}
          />
        ) : null}

        {formMode.kind === "edit" && editingRule && teamId ? (
          <AutomationRuleForm
            key={editingRule.id}
            mode="edit"
            teamId={teamId}
            rule={editingRule}
            triggerTypes={envelope.allowlist.triggerTypes}
            actionTypes={envelope.allowlist.actionTypes}
            canManage={canManage}
            onSaved={() => afterSave("Rule updated.")}
            onCancel={closeForm}
          />
        ) : null}

        {envelope.rules.length === 0 ? (
          <div className="cc-empty" data-automation-empty>
            <p>No automation rules configured yet.</p>
            <p style={{ fontSize: 12, color: "#64748b" }}>
              Allowed triggers: {envelope.allowlist.triggerTypes.length}.
              Allowed actions: {envelope.allowlist.actionTypes.length}.
            </p>
            <button
              type="button"
              data-automation-empty-create
              onClick={() => {
                setLastAction(null);
                setFormMode({ kind: "create" });
              }}
              disabled={!canManage || formMode.kind === "create" || !teamId}
              title={
                canManage
                  ? undefined
                  : "Requires the AUTOMATION_MANAGE capability (workspace owner or admin) on this platform-admin console."
              }
              style={newRuleButtonStyle(
                !canManage || formMode.kind === "create" || !teamId,
              )}
            >
              Create the first rule
            </button>
          </div>
        ) : (
          <div className="apf-table-wrap">
            <table
              className="apf-table"
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {envelope.rules.map((r) => (
                  // PHASE 13 (NEW-065) — the ROW reports its own armed state.
                  //
                  // `data-automation-rule-enabled` existed only on the "Enabled"
                  // cell below. The row is the element carrying the rule's
                  // IDENTITY (`data-automation-rule-id`), so it was the one place
                  // a consumer could ask "what is rule X's state now?" and get
                  // nothing back — you had to already know which cell held the
                  // answer. Every other lifecycle row in this product states its
                  // state on the entity element itself (`member-status-{id}`,
                  // `data-org-workspace-lifecycle`, `data-cross-org-state`).
                  //
                  // Additive: the cell keeps both its copy and its attribute, so
                  // nothing that read the old position changes.
                  <tr
                    key={r.id}
                    data-automation-rule-id={r.id}
                    data-automation-rule-enabled={String(r.enabled)}
                  >
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
                    <td>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "flex-start",
                        }}
                      >
                        <AutomationRuleToggle
                          rule={r}
                          canManage={canManage}
                          onChanged={() => {
                            setLastAction(null);
                            reload();
                          }}
                        />
                        <button
                          type="button"
                          data-automation-rule-edit={r.id}
                          onClick={() => {
                            setLastAction(null);
                            setFormMode({ kind: "edit", ruleId: r.id });
                          }}
                          disabled={!canManage || !teamId}
                          aria-label={`Edit automation rule ${r.name}`}
                          title={
                            canManage
                              ? undefined
                              : "Requires the AUTOMATION_MANAGE capability (workspace owner or admin) on this platform-admin console."
                          }
                          style={newRuleButtonStyle(!canManage || !teamId)}
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Run history */}
      <section className="apf-section" data-automation-runs-list>
        <header className="cc-section-header">
          <h2 className="apf-section-title">Recent runs</h2>
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
          <div className="apf-table-wrap">
            <table
              className="apf-table"
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
          </div>
        )}
      </section>

      {/* Allowlist reference */}
      <section className="apf-section" data-automation-allowlists>
        <header className="cc-section-header">
          <h2 className="apf-section-title">Bounded allowlists</h2>
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
    </PageShell>
  );
}

function newRuleButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    fontWeight: 600,
    fontSize: 12,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
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
