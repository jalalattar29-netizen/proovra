"use client";

/**
 * Phase P4 (UI) — Evidence Copilot on the Evidence detail page.
 * Structured Evidence-Operations assistant for ONE authorized record.
 * Advisory only; deterministic integrity facts are explained, never decided.
 */
import { useState } from "react";

import { apiFetch, ApiError } from "../../lib/api";
import { CopilotCitationList, type CopilotCitationData } from "./CopilotCitation";

type EvidenceCopilotData = {
  operationalSummary: string;
  missingContext: string[];
  integritySignalExplanations: string[];
  custodyObservations: string[];
  timestampingObservations: string[];
  reportReadiness: string[];
  packageReadiness: string[];
  reviewerPreparation: string[];
  workflowGaps: string[];
  suggestedNavigation: string[];
  suggestedActions: string[];
  citations: CopilotCitationData[];
  advisoryBoundary: string;
};

type RunResult = {
  status: string;
  decision?: string;
  data?: EvidenceCopilotData;
  droppedCitations?: number;
  versionMeta?: { outputSchemaVersion?: string; contextObjectVersions?: Array<{ id: string; version: number | null }> };
};

type ServerAction = {
  suggestionId: string;
  actionType: string;
  displayLabel: string;
  reason: string;
  riskLevel: string;
};

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "result"; result: RunResult; serverActions: ServerAction[] };

const SECTIONS: Array<{ key: keyof EvidenceCopilotData; label: string }> = [
  { key: "missingContext", label: "Missing context" },
  { key: "integritySignalExplanations", label: "Integrity signals (explained)" },
  { key: "custodyObservations", label: "Custody observations" },
  { key: "timestampingObservations", label: "Timestamping (TSA / OTS)" },
  { key: "reportReadiness", label: "Report readiness" },
  { key: "packageReadiness", label: "Verification Package readiness" },
  { key: "reviewerPreparation", label: "Reviewer preparation" },
  { key: "workflowGaps", label: "Workflow gaps" },
  { key: "suggestedNavigation", label: "Where to look next" },
  { key: "suggestedActions", label: "Operational guidance" },
];

/**
 * Phase P4 — human-confirmed suggested action. AI proposes; the HUMAN sees the
 * exact change and confirms; the EXISTING canonical endpoint executes with
 * normal authorization + audit. Never one-click, never automatic.
 */
function ConfirmedActionBar({ evidenceId, serverActions }: { evidenceId: string; serverActions: ServerAction[] }) {
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canGenerateReport = serverActions.some((a) => a.actionType === "GENERATE_REPORT" || a.actionType === "RETRY_ELIGIBLE_REPORT");

  async function executeRegenerateReport() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/reports/regenerate`, { method: "POST" });
      setOutcome("Report regeneration was queued through the standard audited workflow.");
    } catch (err) {
      setOutcome(
        err instanceof ApiError && err.statusCode === 403
          ? "You are not permitted to regenerate this report."
          : err instanceof ApiError && err.statusCode === 409
            ? "This record is not currently eligible for report regeneration."
            : "The action could not be completed. The standard evidence workflow is unaffected.",
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div style={{ borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>
      <strong>Suggested actions</strong>
      <p style={{ fontSize: 12, opacity: 0.65, margin: "2px 0 6px" }}>
        Actions run through the standard PROOVRA workflow with your normal permissions and audit logging. Nothing runs without your confirmation.
      </p>
      {serverActions.filter((a) => a.actionType === "OPEN_MISSING_METADATA").map((a) => (
        <a key={a.suggestionId} className="app-secondary-action" href={`/evidence/${evidenceId}`} style={{ marginRight: 6 }}>
          {a.displayLabel}
        </a>
      ))}
      {serverActions.filter((a) => a.actionType === "OPEN_REVIEWER_ASSIGNMENT").map((a) => (
        <a key={a.suggestionId} className="app-secondary-action" href="/review" style={{ marginRight: 6 }} title={a.reason}>
          {a.displayLabel}
        </a>
      ))}
      {!canGenerateReport ? null : !confirming ? (
        <button className="app-secondary-action" onClick={() => setConfirming(true)} disabled={busy}>
          Generate / regenerate Report…
        </button>
      ) : (
        <div
          className="app-inner-surface app-panel__body"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm report regeneration"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) setConfirming(false);
          }}
        >
          <p style={{ margin: "0 0 6px", fontSize: 13 }}>
            <strong>Confirm:</strong> queue report regeneration for this evidence record via the standard endpoint. This creates a new report version; it does not alter evidence bytes, hashes, custody, or verification state.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {/* autoFocus moves keyboard/screen-reader focus into the dialog. */}
            <button className="app-primary-action" onClick={() => void executeRegenerateReport()} disabled={busy} aria-busy={busy} autoFocus>
              {busy ? "Queuing…" : "Confirm and run"}
            </button>
            <button className="app-secondary-action" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      {outcome ? <div className="app-alert" style={{ marginTop: 8 }} role="status" aria-live="polite">{outcome}</div> : null}
    </div>
  );
}

export function EvidenceCopilotPanel({
  evidenceId,
  evidenceVersion,
  aiEnabled = true,
}: {
  evidenceId: string;
  evidenceVersion?: number;
  aiEnabled?: boolean;
}) {
  const [state, setState] = useState<UiState>({ kind: "idle" });

  async function run() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(`/v1/ai/evidence/${evidenceId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evidenceVersion,
          processingMode: "METADATA_ONLY",
          idempotencyKey: `${evidenceId}:${evidenceVersion ?? 0}`,
        }),
      })) as { data?: RunResult; status?: string; serverActions?: ServerAction[] };
      setState({ kind: "result", result: res.data ?? (res as RunResult), serverActions: res.serverActions ?? [] });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code ?? String(err.statusCode), message: friendly(err.statusCode) });
      } else {
        setState({ kind: "error", code: "NETWORK", message: "Could not reach the AI service. Evidence workflows are unaffected." });
      }
    }
  }

  if (!aiEnabled) return null;

  return (
    <section className="app-panel app-panel__body" aria-label="Evidence Copilot" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Evidence Copilot</h3>
        <span style={{ display: "flex", gap: 6 }}>
          <span className="app-chip app-chip--ai">AI-generated</span>
          <span className="app-chip">Advisory only</span>
          <span className="app-chip">Metadata only</span>
        </span>
      </div>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
        Explains this record&apos;s operational state — missing context, deterministic
        integrity/custody/timestamping signals, and report/package readiness. It never
        determines truth, authenticity, or admissibility.
      </p>
      <div style={{ marginTop: 8 }}>
        <button className="app-primary-action" onClick={run} disabled={state.kind === "loading"} aria-busy={state.kind === "loading"}>
          {state.kind === "loading" ? "Analyzing…" : state.kind === "result" ? "Re-run" : "Run Evidence Copilot"}
        </button>
        <span aria-live="polite" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {state.kind === "loading" ? "Analyzing evidence record" : state.kind === "result" ? "Evidence Copilot result ready" : ""}
        </span>
      </div>

      {state.kind === "error" ? (
        <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert">
          {state.message} <span style={{ opacity: 0.6 }}>({state.code})</span>
        </div>
      ) : null}
      {state.kind === "result" ? <ResultView result={state.result} serverActions={state.serverActions} /> : null}
    </section>
  );
}

function ResultView({ result, serverActions }: { result: RunResult; serverActions: ServerAction[] }) {
  if (result.status === "provider_unavailable") return <div className="app-alert" style={{ marginTop: 12 }}>AI is currently unavailable. Evidence workflows are unaffected.</div>;
  if (result.status === "policy_denied") return <div className="app-alert" style={{ marginTop: 12 }}>Evidence AI is disabled for this workspace ({result.decision}).</div>;
  if (result.status === "schema_error") return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI response could not be validated and was discarded. Please try again.</div>;
  const data = result.data;
  if (result.status === "blocked_prohibited_claim" || !data) {
    return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI output contained language PROOVRA cannot present and was blocked.</div>;
  }
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
      <div>
        <strong>Operational summary</strong>
        <p style={{ margin: "4px 0 0" }}>{data.operationalSummary}</p>
      </div>
      {SECTIONS.map(({ key, label }) => {
        const items = data[key] as string[];
        if (!Array.isArray(items) || items.length === 0) return null;
        return (
          <div key={key}>
            <strong>{label}</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {items.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        );
      })}
      <div>
        <strong>Validated sources</strong>
        <div style={{ marginTop: 4 }}><CopilotCitationList citations={data.citations} /></div>
        {result.droppedCitations ? <p style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{result.droppedCitations} unverifiable citation(s) were removed.</p> : null}
      </div>
      <ConfirmedActionBar evidenceId={evidenceIdOfResult(result)} serverActions={serverActions} />
      <p style={{ fontSize: 12, opacity: 0.7, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>{data.advisoryBoundary}</p>
    </div>
  );
}

function evidenceIdOfResult(result: RunResult): string {
  return result.versionMeta?.contextObjectVersions?.[0]?.id ?? "";
}

function friendly(status: number): string {
  switch (status) {
    case 401: return "Please sign in again.";
    case 403: return "You are not permitted to run AI on this record, or it is disabled by policy.";
    case 404: return "This evidence record is no longer accessible.";
    case 409: return "The record changed since this page loaded. Refresh and try again.";
    case 429: return "Too many AI requests. Please wait a moment.";
    default: return "The AI request could not be completed. Evidence workflows are unaffected.";
  }
}
