"use client";

/**
 * Phase P7 (UI) — Operations Intelligence: bounded operational summaries over
 * deterministic system counts. No free-form general chat — mode buttons only.
 */
import { useState } from "react";

import { apiFetch, ApiError } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";
import { CopilotCitationList, type CopilotCitationData } from "./CopilotCitation";

const MODES: Array<{ type: string; label: string }> = [
  { type: "WORKSPACE_HEALTH", label: "Workspace health" },
  { type: "TSA_FAILURES", label: "TSA failures" },
  { type: "OTS_PENDING", label: "OTS pending" },
  { type: "REPORT_PACKAGE_FAILURES", label: "Reports & packages" },
  { type: "REVIEW_BACKLOG", label: "Review backlog" },
  { type: "CONFIGURATION_GAPS", label: "Configuration gaps" },
];

type OpsData = {
  operationalSummary: string;
  affectedWorkflows: string[];
  failureGroups: string[];
  queueOrSlaObservations: string[];
  configurationGaps: string[];
  suggestedActions: string[];
  citations: CopilotCitationData[];
  advisoryBoundary: string;
};
type Snapshot = {
  tsaFailedCount: number; otsPendingCount: number; signedWithoutReportCount: number;
  openReviewWorkflowCount: number; aiOperationsThisMonth: number; snapshotAtUtc: string;
};
type RunResult = { status: string; decision?: string; data?: OpsData };

type UiState =
  | { kind: "idle" }
  | { kind: "loading"; mode: string }
  | { kind: "error"; message: string }
  | { kind: "result"; result: RunResult; snapshot: Snapshot | null; mode: string };

export function OperationsIntelligencePanel() {
  const teamId = useActiveWorkspaceId();
  const [state, setState] = useState<UiState>({ kind: "idle" });

  async function run(mode: string) {
    if (!teamId || state.kind === "loading") return;
    setState({ kind: "loading", mode });
    try {
      const res = (await apiFetch(`/v1/ai/operations/summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, operationType: mode, idempotencyKey: `${teamId}:${mode}` }),
      })) as { data?: RunResult; snapshot?: Snapshot; status?: string };
      setState({ kind: "result", result: res.data ?? (res as RunResult), snapshot: res.snapshot ?? null, mode });
    } catch (err) {
      setState({ kind: "error", message: err instanceof ApiError && err.statusCode === 403 ? "Operations Intelligence requires an operations/admin role or is disabled by policy." : "AI is unavailable right now. Operational dashboards remain fully functional." });
    }
  }

  if (!teamId) return null;
  return (
    <section className="app-card" style={{ marginTop: 16 }} aria-label="Operations Intelligence">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Operations Intelligence</h3>
        <span style={{ display: "flex", gap: 6 }}>
          <span className="app-chip app-chip--ai">AI-generated</span>
          <span className="app-chip">Advisory only</span>
          <span className="app-chip">Deterministic data</span>
        </span>
      </div>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
        Bounded summaries of deterministic system state. No general chat.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {MODES.map((m) => (
          <button key={m.type} className="app-btn app-btn--ghost" disabled={state.kind === "loading"} aria-busy={state.kind === "loading" && state.mode === m.type} onClick={() => void run(m.type)}>
            {state.kind === "loading" && state.mode === m.type ? "Summarizing…" : m.label}
          </button>
        ))}
      </div>
      {state.kind === "error" ? <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert">{state.message}</div> : null}
      <div aria-live="polite">
        {state.kind === "result" ? <Result result={state.result} snapshot={state.snapshot} /> : null}
      </div>
    </section>
  );
}

function Result({ result, snapshot }: { result: RunResult; snapshot: Snapshot | null }) {
  if (result.status === "policy_denied") return <div className="app-alert" style={{ marginTop: 12 }}>AI is disabled for this workspace ({result.decision}).</div>;
  if (result.status !== "ok" || !result.data) return <div className="app-alert" style={{ marginTop: 12 }}>AI is unavailable; the deterministic counts below remain accurate.{snapshot ? <SnapshotRow s={snapshot} /> : null}</div>;
  const d = result.data;
  const lists: Array<[string, string[]]> = [
    ["Affected workflows", d.affectedWorkflows], ["Failure groups", d.failureGroups],
    ["Queue / SLA observations", d.queueOrSlaObservations], ["Configuration gaps", d.configurationGaps],
    ["Suggested actions (require your confirmation)", d.suggestedActions],
  ];
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
      {snapshot ? <SnapshotRow s={snapshot} /> : null}
      <p style={{ margin: 0 }}>{d.operationalSummary}</p>
      {lists.map(([label, items]) => items?.length ? (
        <div key={label}>
          <strong>{label}</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ) : null)}
      <CopilotCitationList citations={d.citations} />
      <p style={{ fontSize: 12, opacity: 0.7 }}>{d.advisoryBoundary}</p>
    </div>
  );
}

function SnapshotRow({ s }: { s: Snapshot }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
      <span className="app-chip">TSA failed: {s.tsaFailedCount}</span>
      <span className="app-chip">OTS pending: {s.otsPendingCount}</span>
      <span className="app-chip">Signed w/o report: {s.signedWithoutReportCount}</span>
      <span className="app-chip">Open reviews: {s.openReviewWorkflowCount}</span>
      <span style={{ opacity: 0.6 }}>as of {new Date(s.snapshotAtUtc).toLocaleTimeString()}</span>
    </div>
  );
}
