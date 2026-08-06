"use client";

/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * Operational workflow actions, INSIDE the existing Command Center.
 *
 * This is deliberately not a separate "workflow dashboard": operational
 * pressure and the actions that relieve it belong on the same surface,
 * or operators end up triaging in one place and acting in another.
 *
 * What it wires:
 *   GET  /v1/ops/workflows                     — list + server projection
 *   GET  /v1/ops/workflows/:id                 — detail + history
 *   POST /v1/ops/workflows/:id/{start,assign,escalate,mitigation,
 *        resolve,suppress,reopen,schedule-retry}
 *   POST /v1/ops/bulk-actions                  — multi-select fan-out
 *   GET  /v1/ops/causality/chains{,/:id}       — "why is this happening"
 *
 * Contract with the server:
 *   * ACTION AVAILABILITY IS NOT A CLIENT DECISION. Every button's
 *     enabled/disabled state comes from `workflow.projection.actions[]`,
 *     which the API computes from the caller's capability decision plus
 *     the row's state machine. There is no role string anywhere in this
 *     file.
 *   * Every mutation echoes `expectedVersion` (the row's
 *     `updatedAtUtc`). A 409 means the board moved underneath the
 *     operator — we say so and refresh, we do not retry blindly.
 *   * Every mutation carries an `idempotencyKey` so a dropped response
 *     never turns into a double-apply on retry.
 *   * Nothing is marked done optimistically. State only changes after
 *     the server returns the refreshed projection.
 *
 * Denial is a first-class state. When the projection says
 * `canAct: false` we render WHY, not an empty toolbar and not a zero.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../lib/platform-context";
import { useConfirmAction } from "../../ui/ConfirmActionModal";
import { StepUpModal, useStepUpAction } from "../../identity-security/StepUpModal";

// ---------------------------------------------------------------------------
// Server projection types — mirrors workflow-actions.service.ts
// ---------------------------------------------------------------------------

type WorkflowActionKey =
  | "start"
  | "assign"
  | "escalate"
  | "mitigation"
  | "resolve"
  | "suppress"
  | "reopen"
  | "schedule-retry";

type ActionUnavailableReason =
  | "CAPABILITY_REQUIRED"
  | "TERMINAL_STATE"
  | "NOT_RESOLVED_OR_SUPPRESSED"
  | "ALREADY_IN_PROGRESS";

type ActionAvailability = {
  action: WorkflowActionKey;
  label: string;
  available: boolean;
  reason: ActionUnavailableReason | null;
  permission: string;
  requiresStepUp: boolean;
  destructive: boolean;
};

type WorkflowRow = {
  id: string;
  teamId: string;
  workflowKey: string;
  workflowType: string;
  status: string;
  severity: string;
  priority: string;
  title: string;
  safeSummary: string;
  assignedOwnerUserId: string | null;
  escalationLevel: number;
  retryCount: number;
  nextRetryAtUtc: string | null;
  mitigationSummary: string | null;
  resolutionSummary: string | null;
  dueAtUtc: string | null;
  resolvedAtUtc: string | null;
  caseId: string | null;
  evidenceId: string | null;
  queueName: string | null;
  updatedAtUtc: string;
  projection: {
    version: string;
    canAct: boolean;
    actions: ActionAvailability[];
  };
};

type WorkflowListResponse = {
  workflows: WorkflowRow[];
  canAct: boolean;
  denialReason: string | null;
};

type CausalityChain = {
  id: string;
  title: string;
  summary: string;
  rootCauseType: string;
  severity: string;
  linkedWorkflowIds: string[];
  lastSeenAtUtc: string;
};

type BulkItemResult = {
  id: string;
  targetType: string;
  targetId: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "SKIPPED";
  errorCode: string | null;
};

/** Per-row outcome. Never a single global banner. */
type RowResult = {
  tone: "success" | "error" | "info";
  message: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: WorkflowListResponse; chains: CausalityChain[] }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Bounded copy for server reason codes. The client never invents a reason.
// ---------------------------------------------------------------------------

const REASON_COPY: Record<ActionUnavailableReason, string> = {
  CAPABILITY_REQUIRED:
    "Your role in this workspace cannot take operational actions.",
  TERMINAL_STATE: "This workflow is already closed.",
  NOT_RESOLVED_OR_SUPPRESSED:
    "Only a resolved or suppressed workflow can be reopened.",
  ALREADY_IN_PROGRESS: "This workflow is already in progress.",
};

/**
 * Actions that need an operator-supplied value. Everything else is a
 * single click.
 */
const ACTIONS_NEEDING_INPUT: ReadonlySet<WorkflowActionKey> = new Set([
  "assign",
  "mitigation",
  "resolve",
  "schedule-retry",
]);

const BULK_ACTION_FOR: Partial<Record<WorkflowActionKey, string>> = {
  escalate: "BULK_ESCALATE_WORKFLOWS",
  resolve: "BULK_RESOLVE_WORKFLOWS",
  mitigation: "BULK_ADD_MITIGATION",
  "schedule-retry": "BULK_SCHEDULE_RETRY",
};

function newIdempotencyKey(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `cc-wf-${rand}`;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function WorkflowOperationsSection({
  teamId,
}: {
  teamId: string | null;
}) {
  const guard = useTenantGuard();
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkItems, setBulkItems] = useState<BulkItemResult[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const inputRef = useRef<Record<string, string>>({});

  // -------------------------------------------------------------------------
  // Server projection load. Refreshing from the server after EVERY
  // mutation is what keeps availability honest — the client never
  // patches a row locally.
  // -------------------------------------------------------------------------
  const load = useCallback(async () => {
    if (!teamId) return;
    const stamp = guard.stamp();
    try {
      const [list, chainRes] = await Promise.all([
        apiFetch(
          `/v1/ops/workflows?teamId=${encodeURIComponent(teamId)}&limit=50`,
          { method: "GET" },
        ) as Promise<WorkflowListResponse>,
        apiFetch(
          `/v1/ops/causality/chains?teamId=${encodeURIComponent(teamId)}&limit=6`,
          { method: "GET" },
        ).catch(() => ({ chains: [] as CausalityChain[] })) as Promise<{
          chains: CausalityChain[];
        }>,
      ]);
      if (guard.isStale(stamp)) return;
      setState({
        kind: "ready",
        data: list,
        chains: chainRes.chains ?? [],
      });
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const safe = toSafeUserError(err, {
        message: "Unable to load operational workflows.",
      });
      const code = (err as { code?: string; statusCode?: number }).code;
      if (code === "permission_denied" || code === "PERMISSION_DENIED") {
        setState({
          kind: "denied",
          reason:
            "You do not have permission to view operational workflows in this workspace.",
        });
        return;
      }
      setState({ kind: "error", message: safe.message });
    }
  }, [guard, teamId]);

  useEffect(() => {
    if (!teamId) return;
    setState({ kind: "loading" });
    void load();
  }, [teamId, load]);

  const workflows = state.kind === "ready" ? state.data.workflows : [];

  const chainsByWorkflow = useMemo(() => {
    const map = new Map<string, CausalityChain[]>();
    if (state.kind !== "ready") return map;
    for (const chain of state.chains) {
      for (const wid of chain.linkedWorkflowIds ?? []) {
        map.set(wid, [...(map.get(wid) ?? []), chain]);
      }
    }
    return map;
  }, [state]);

  const setRowResult = useCallback((id: string, result: RowResult | null) => {
    setRowResults((prev) => {
      const next = { ...prev };
      if (result === null) delete next[id];
      else next[id] = result;
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Single-workflow action.
  // -------------------------------------------------------------------------
  const runAction = useCallback(
    async (workflow: WorkflowRow, availability: ActionAvailability) => {
      if (!teamId || !availability.available) return;
      const key = `${availability.action}:${workflow.id}`;

      if (availability.destructive) {
        const ok = await confirm({
          title: `${availability.label} this workflow?`,
          description: `"${workflow.title}" will move out of its current state (${workflow.status}). The change is recorded in the operational history.`,
          confirmLabel: availability.label,
          tone: "warning",
        });
        if (!ok) return;
      }

      const payload: Record<string, unknown> = {
        teamId,
        // Optimistic-concurrency token straight from the read projection.
        expectedVersion: workflow.projection.version,
        idempotencyKey: newIdempotencyKey(),
      };
      const typed = (inputRef.current[key] ?? "").trim();
      if (availability.action === "assign") {
        if (!typed) {
          setRowResult(workflow.id, {
            tone: "error",
            message: "Enter the user id of the operator to assign.",
          });
          return;
        }
        payload.assigneeUserId = typed;
      }
      if (availability.action === "mitigation") {
        if (!typed) {
          setRowResult(workflow.id, {
            tone: "error",
            message: "A mitigation note is required.",
          });
          return;
        }
        payload.note = typed;
      }
      if (availability.action === "resolve" && typed) payload.note = typed;
      if (availability.action === "schedule-retry") {
        if (!typed) {
          setRowResult(workflow.id, {
            tone: "error",
            message: "Enter the retry time (ISO 8601).",
          });
          return;
        }
        const parsed = new Date(typed);
        if (Number.isNaN(parsed.getTime())) {
          setRowResult(workflow.id, {
            tone: "error",
            message: "That retry time is not a valid date.",
          });
          return;
        }
        payload.nextRetryAtUtc = parsed.toISOString();
      }

      setBusyKey(key);
      setRowResult(workflow.id, null);
      const stamp = guard.stamp();
      try {
        const res = (await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/ops/workflows/${encodeURIComponent(workflow.id)}/${availability.action}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify(payload),
            },
          ),
        )) as { applied: boolean; idempotentReplay: boolean };
        if (guard.isStale(stamp)) return;
        setRowResult(workflow.id, {
          tone: "success",
          message: res.idempotentReplay
            ? `${availability.label} was already recorded — nothing was applied twice.`
            : `${availability.label} applied.`,
        });
        inputRef.current[key] = "";
        // Refresh from the SERVER projection. Never patch locally.
        await load();
      } catch (err) {
        if (guard.isStale(stamp)) return;
        const e = err as { code?: string; details?: { code?: string } };
        if (e.code === "STEP_UP_CANCEL") {
          setRowResult(workflow.id, {
            tone: "info",
            message: "Verification cancelled — nothing changed.",
          });
          return;
        }
        const errorCode =
          (err as { body?: { error?: { code?: string } } })?.body?.error?.code ??
          e.details?.code ??
          e.code;
        if (errorCode === "stale_workflow_state") {
          setRowResult(workflow.id, {
            tone: "error",
            message:
              "This workflow changed while you were looking at it. Nothing was applied — refreshing.",
          });
          await load();
          return;
        }
        setRowResult(workflow.id, {
          tone: "error",
          message: toSafeUserError(err, {
            message: `Could not ${availability.label.toLowerCase()} this workflow.`,
          }).message,
        });
      } finally {
        setBusyKey(null);
      }
    },
    [confirm, guard, load, setRowResult, stepUp, teamId],
  );

  // -------------------------------------------------------------------------
  // Bulk fan-out. The server returns per-item outcomes; we render which
  // rows moved and which did not.
  // -------------------------------------------------------------------------
  const runBulk = useCallback(
    async (action: WorkflowActionKey) => {
      const actionType = BULK_ACTION_FOR[action];
      if (!teamId || !actionType || selected.size === 0) return;
      const targetIds = [...selected];
      const ok = await confirm({
        title: `Apply "${action}" to ${targetIds.length} workflow${targetIds.length === 1 ? "" : "s"}?`,
        description:
          "Each target is evaluated individually against your permissions — the bulk runner is a fan-out, not a bypass. You will see a per-row outcome.",
        confirmLabel: "Run bulk action",
        tone: "warning",
      });
      if (!ok) return;

      const payload: Record<string, unknown> = {
        teamId,
        actionType,
        targetIds,
        idempotencyKey: newIdempotencyKey(),
      };
      const note = (inputRef.current["bulk:note"] ?? "").trim();
      if (actionType === "BULK_ADD_MITIGATION") {
        if (!note) {
          setBulkItems(null);
          setRowResult("__bulk__", {
            tone: "error",
            message: "A mitigation note is required for a bulk mitigation.",
          });
          return;
        }
        payload.note = note;
      }
      if (actionType === "BULK_SCHEDULE_RETRY") {
        const when = new Date(
          (inputRef.current["bulk:retry"] ?? "").trim() || "invalid",
        );
        if (Number.isNaN(when.getTime())) {
          setRowResult("__bulk__", {
            tone: "error",
            message: "Enter a valid retry time (ISO 8601) for the bulk retry.",
          });
          return;
        }
        payload.nextRetryAtUtc = when.toISOString();
      }

      setBusyKey("bulk");
      setRowResult("__bulk__", null);
      const stamp = guard.stamp();
      try {
        const res = (await stepUp.runStepUpAction(async (headers) =>
          apiFetch(`/v1/ops/bulk-actions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(payload),
          }),
        )) as {
          run: { succeeded: number; failed: number; skipped: number };
          items: BulkItemResult[];
          idempotentReplay: boolean;
        };
        if (guard.isStale(stamp)) return;
        setBulkItems(res.items ?? []);
        setRowResult("__bulk__", {
          tone: res.run.failed > 0 ? "error" : "success",
          message: res.idempotentReplay
            ? "This bulk run was already recorded — the original outcome is shown."
            : `${res.run.succeeded} applied · ${res.run.skipped} skipped · ${res.run.failed} failed.`,
        });
        setSelected(new Set());
        await load();
      } catch (err) {
        if (guard.isStale(stamp)) return;
        if ((err as { code?: string }).code === "STEP_UP_CANCEL") {
          setRowResult("__bulk__", {
            tone: "info",
            message: "Verification cancelled — no workflow was changed.",
          });
          return;
        }
        setRowResult("__bulk__", {
          tone: "error",
          message: toSafeUserError(err, {
            message: "The bulk action could not be started.",
          }).message,
        });
      } finally {
        setBusyKey(null);
      }
    },
    [confirm, guard, load, selected, setRowResult, stepUp, teamId],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!teamId) return null;

  return (
    <section className="ec-section" data-cc-workflow-operations>
      <StepUpModal control={stepUp} />
      <div className="ec-section-header">
        <div className="ec-section-kicker">Workflow Operations</div>
        <h2 className="ec-section-title">
          {state.kind === "ready"
            ? `${state.data.workflows.length} operational workflow${state.data.workflows.length === 1 ? "" : "s"}`
            : "Operational workflows"}
        </h2>
      </div>

      <div className="ec-section-body">
        {state.kind === "loading" ? (
          <p className="ec-section-note" data-cc-workflow-state="loading">
            Loading operational workflows…
          </p>
        ) : null}

        {state.kind === "denied" ? (
          <div className="ec-empty" data-cc-workflow-state="denied">
            <strong>Access restricted</strong>
            <p className="ec-empty-hint">{state.reason}</p>
          </div>
        ) : null}

        {state.kind === "error" ? (
          <div className="ec-empty" data-cc-workflow-state="error">
            <strong>Workflows unavailable</strong>
            <p className="ec-empty-hint">{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              data-cc-workflow-retry
            >
              Try again
            </button>
          </div>
        ) : null}

        {state.kind === "ready" && !state.data.canAct ? (
          // DENIAL IS NOT ZERO. The list still renders; the toolbar
          // explains why it is inert.
          <p
            className="ec-section-note"
            data-cc-workflow-state="read-only"
            data-cc-workflow-denial={state.data.denialReason ?? "none"}
          >
            You can see operational pressure in this workspace but cannot act on
            it. Taking workflow actions needs an operations role.
          </p>
        ) : null}

        {state.kind === "ready" && workflows.length === 0 ? (
          <div className="ec-empty" data-cc-workflow-state="empty">
            <strong>No operational workflows open</strong>
            <p className="ec-empty-hint">
              Workflows are generated from real incidents and correlations. An
              empty list means nothing in this workspace currently needs
              operator action — it is not a failed read.
            </p>
          </div>
        ) : null}

        {state.kind === "ready" && workflows.length > 0 ? (
          <>
            {/* Bulk toolbar — only meaningful once rows are selected. */}
            <div className="ec-subsection" data-cc-workflow-bulk>
              <div className="ec-subsection-head">
                <h3 className="ec-subsection-title">
                  Bulk actions · {selected.size} selected
                </h3>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  placeholder="Bulk mitigation note"
                  aria-label="Bulk mitigation note"
                  defaultValue=""
                  onChange={(e) => {
                    inputRef.current["bulk:note"] = e.target.value;
                  }}
                  data-cc-workflow-bulk-note
                />
                <input
                  placeholder="Bulk retry time (ISO 8601)"
                  aria-label="Bulk retry time"
                  defaultValue=""
                  onChange={(e) => {
                    inputRef.current["bulk:retry"] = e.target.value;
                  }}
                  data-cc-workflow-bulk-retry
                />
                {(
                  ["escalate", "mitigation", "resolve", "schedule-retry"] as const
                ).map((action) => (
                  <button
                    key={action}
                    type="button"
                    className="ec-chip"
                    disabled={
                      selected.size === 0 ||
                      busyKey === "bulk" ||
                      !state.data.canAct
                    }
                    onClick={() => void runBulk(action)}
                    data-cc-workflow-bulk-action={action}
                  >
                    {busyKey === "bulk" ? "Working…" : `Bulk ${action}`}
                  </button>
                ))}
              </div>
              {rowResults["__bulk__"] ? (
                <p
                  className="ec-section-note"
                  data-cc-workflow-bulk-result={rowResults["__bulk__"].tone}
                >
                  {rowResults["__bulk__"].message}
                </p>
              ) : null}
              {bulkItems && bulkItems.length > 0 ? (
                <ul className="ec-telemetry-list" data-cc-workflow-bulk-items>
                  {bulkItems.map((item) => (
                    <li
                      key={item.id}
                      className="ec-telemetry-row"
                      data-cc-bulk-item-status={item.status}
                      data-cc-bulk-item-target={item.targetId}
                    >
                      <span className="ec-telemetry-label">
                        {item.targetId.slice(0, 8)}…
                      </span>
                      <span className="ec-chip">{item.status}</span>
                      {item.errorCode ? (
                        <span className="ec-chip-faint">{item.errorCode}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <ul className="ec-telemetry-list" data-cc-workflow-list>
              {workflows.map((wf) => {
                const chains = chainsByWorkflow.get(wf.id) ?? [];
                const result = rowResults[wf.id];
                const isExpanded = expandedId === wf.id;
                return (
                  <li
                    key={wf.id}
                    className="ec-telemetry-row"
                    data-cc-workflow-id={wf.id}
                    data-cc-workflow-status={wf.status}
                    data-cc-workflow-severity={wf.severity}
                  >
                    <div className="ec-telemetry-row-main">
                      <label style={{ display: "inline-flex", gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={selected.has(wf.id)}
                          disabled={!state.data.canAct}
                          onChange={(e) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(wf.id);
                              else next.delete(wf.id);
                              return next;
                            });
                          }}
                          aria-label={`Select ${wf.title}`}
                          data-cc-workflow-select={wf.id}
                        />
                        <span className="ec-telemetry-label">{wf.title}</span>
                      </label>
                      <span className="ec-chip">{wf.status}</span>
                      <span className="ec-chip-faint">{wf.severity}</span>
                      <span className="ec-chip-faint">{wf.priority}</span>
                    </div>
                    <div className="ec-telemetry-meta">
                      <span>{wf.safeSummary}</span>
                      {wf.escalationLevel > 0 ? (
                        <span className="ec-chip">
                          escalation {wf.escalationLevel}
                        </span>
                      ) : null}
                      {wf.retryCount > 0 ? (
                        <span className="ec-chip-faint">
                          {wf.retryCount} retries
                        </span>
                      ) : null}
                      {wf.assignedOwnerUserId ? (
                        <span className="ec-chip-faint">
                          owner {wf.assignedOwnerUserId.slice(0, 8)}…
                        </span>
                      ) : (
                        <span className="ec-chip-faint">unassigned</span>
                      )}
                    </div>

                    {chains.length > 0 ? (
                      <div className="ec-coord-explanation" data-cc-workflow-causality>
                        Why: {chains.map((c) => c.summary).join(" · ")}
                      </div>
                    ) : null}

                    {/* Action row. Availability is 100% server-decided. */}
                    <div
                      style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                      data-cc-workflow-actions
                    >
                      {wf.projection.actions.map((a) => {
                        const key = `${a.action}:${wf.id}`;
                        return (
                          <span key={a.action} style={{ display: "inline-flex", gap: 4 }}>
                            {a.available && ACTIONS_NEEDING_INPUT.has(a.action) ? (
                              <input
                                aria-label={`${a.label} value`}
                                placeholder={
                                  a.action === "assign"
                                    ? "assignee user id"
                                    : a.action === "schedule-retry"
                                      ? "ISO 8601"
                                      : "note"
                                }
                                defaultValue=""
                                onChange={(e) => {
                                  inputRef.current[key] = e.target.value;
                                }}
                                data-cc-workflow-action-input={a.action}
                              />
                            ) : null}
                            <button
                              type="button"
                              className="ec-chip"
                              disabled={!a.available || busyKey === key}
                              title={
                                a.reason ? REASON_COPY[a.reason] : undefined
                              }
                              onClick={() => void runAction(wf, a)}
                              data-cc-workflow-action={a.action}
                              data-cc-workflow-action-available={
                                a.available ? "true" : "false"
                              }
                              data-cc-workflow-action-reason={a.reason ?? ""}
                              data-cc-workflow-action-stepup={
                                a.requiresStepUp ? "true" : "false"
                              }
                            >
                              {busyKey === key ? "Working…" : a.label}
                              {a.requiresStepUp ? " ✓" : ""}
                            </button>
                          </span>
                        );
                      })}
                      <button
                        type="button"
                        className="ec-chip-faint"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : wf.id)
                        }
                        data-cc-workflow-expand={wf.id}
                      >
                        {isExpanded ? "Hide history" : "History"}
                      </button>
                    </div>

                    {/* Per-row outcome — never one global banner. */}
                    {result ? (
                      <p
                        className="ec-section-note"
                        data-cc-workflow-row-result={result.tone}
                        data-cc-workflow-row-result-id={wf.id}
                      >
                        {result.message}
                      </p>
                    ) : null}

                    {isExpanded ? (
                      <WorkflowHistory teamId={teamId} workflowId={wf.id} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>

      <div className="ec-section-foot">
        Action availability is resolved by the server from your workspace
        permissions and each workflow&apos;s state — this surface renders that
        decision, it does not make it.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History drawer — GET /v1/ops/workflows/:id
// ---------------------------------------------------------------------------

type HistoryEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  summary: string;
  occurredAtUtc: string;
};

function WorkflowHistory({
  teamId,
  workflowId,
}: {
  teamId: string;
  workflowId: string;
}) {
  const guard = useTenantGuard();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; events: HistoryEvent[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const stamp = guard.stamp();
    apiFetch(
      `/v1/ops/workflows/${encodeURIComponent(workflowId)}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res: { history: HistoryEvent[] }) => {
        if (cancelled || guard.isStale(stamp)) return;
        setState({ kind: "ready", events: res.history ?? [] });
      })
      .catch((err) => {
        if (cancelled || guard.isStale(stamp)) return;
        setState({
          kind: "error",
          message: toSafeUserError(err, {
            message: "Unable to load this workflow's history.",
          }).message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [guard, teamId, workflowId]);

  if (state.kind === "loading") {
    return <p className="ec-section-note">Loading history…</p>;
  }
  if (state.kind === "error") {
    return <p className="ec-section-note">{state.message}</p>;
  }
  if (state.events.length === 0) {
    return (
      <p className="ec-section-note">
        No operator events recorded for this workflow yet.
      </p>
    );
  }
  return (
    <ul className="ec-coord-list" data-cc-workflow-history={workflowId}>
      {state.events.map((e) => (
        <li key={e.id} className="ec-coord-row" data-cc-workflow-event={e.eventType}>
          <span className="ec-coord-type">{e.eventType}</span>
          <span className="ec-coord-explanation">{e.summary}</span>
          <time className="ec-chip-faint" dateTime={e.occurredAtUtc}>
            {e.occurredAtUtc}
          </time>
        </li>
      ))}
    </ul>
  );
}
