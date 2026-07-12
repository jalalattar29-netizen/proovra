"use client";

/**
 * Phase D1/D2/C5/C6 (UI) — Case Copilot on the Case page.
 *
 * Advisory only. No auto-run. User explicitly selects linked evidence; a D2
 * pre-run panel shows scope before any provider call. Renders only bounded,
 * schema-typed fields with validated citations — never raw JSON, never an
 * uncited substantive observation.
 */
import { useMemo, useState } from "react";

import { apiFetch, ApiError } from "../../lib/api";
import { CopilotCitationList, type CopilotCitationData } from "./CopilotCitation";

export type CaseCopilotEvidence = {
  id: string;
  title: string;
  type: string;
  version: number;
  status: string;
  stale?: boolean;
};

type CaseCopilotData = {
  caseSummary: string;
  timelineHighlights: string[];
  missingEvidenceCategories: string[];
  workflowGaps: string[];
  conflictingMetadata: string[];
  reviewerPreparation: string[];
  disclosureChecklist: string[];
  unresolvedQuestions: string[];
  citations: CopilotCitationData[];
  advisoryBoundary: string;
};

type RunResult = {
  status: string;
  decision?: string;
  data?: CaseCopilotData;
  droppedCitations?: number;
  advisoryBoundary?: string;
  versionMeta?: { outputSchemaVersion?: string; contextObjectVersions?: Array<{ id: string; version: number | null }> };
};

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "result"; result: RunResult };

const SECTIONS: Array<{ key: keyof CaseCopilotData; label: string }> = [
  { key: "timelineHighlights", label: "Timeline highlights" },
  { key: "missingEvidenceCategories", label: "Missing evidence categories" },
  { key: "workflowGaps", label: "Workflow gaps" },
  { key: "conflictingMetadata", label: "Conflicting metadata" },
  { key: "reviewerPreparation", label: "Reviewer preparation" },
  { key: "disclosureChecklist", label: "Disclosure checklist" },
  { key: "unresolvedQuestions", label: "Unresolved questions" },
];

export function CaseCopilotPanel({
  caseId,
  linkedEvidence,
  aiEnabled = true,
}: {
  caseId: string;
  linkedEvidence: CaseCopilotEvidence[];
  aiEnabled?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<UiState>({ kind: "idle" });

  const selectableIds = useMemo(
    () => linkedEvidence.filter((e) => !e.stale).map((e) => e.id),
    [linkedEvidence],
  );
  const selectedList = linkedEvidence.filter((e) => selected.has(e.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run() {
    if (selected.size === 0 || state.kind === "loading") return;
    setState({ kind: "loading" });
    const versions: Record<string, number> = {};
    for (const e of selectedList) versions[e.id] = e.version;
    try {
      const res = (await apiFetch(`/v1/ai/case/${caseId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedEvidenceIds: [...selected],
          selectedEvidenceVersions: versions,
          processingMode: "METADATA_ONLY",
          idempotencyKey: `${caseId}:${[...selected].sort().join(",")}`,
        }),
      })) as { data?: RunResult; status?: string };
      const result: RunResult = res.data ?? (res as RunResult);
      setState({ kind: "result", result });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code ?? String(err.statusCode), message: friendly(err.statusCode) });
      } else {
        setState({ kind: "error", code: "NETWORK", message: "Could not reach the AI service. Evidence workflows are unaffected." });
      }
    }
  }

  if (!aiEnabled) {
    return (
      <section className="app-card">
        <Header />
        <p style={{ opacity: 0.7 }}>AI is turned off for this workspace by policy.</p>
      </section>
    );
  }

  return (
    <section className="app-card" aria-label="Case Copilot">
      <Header />

      {/* Selection */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Select evidence to analyze</strong>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="app-btn app-btn--ghost" onClick={() => setSelected(new Set(selectableIds))} disabled={selectableIds.length === 0}>Select all</button>
            <button className="app-btn app-btn--ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Clear</button>
          </span>
        </div>
        {linkedEvidence.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No evidence is linked to this case yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {linkedEvidence.map((e) => (
              <li key={e.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", opacity: e.stale ? 0.5 : 1 }}>
                <input type="checkbox" checked={selected.has(e.id)} disabled={e.stale} onChange={() => toggle(e.id)} aria-label={`Select ${e.title}`} />
                <span style={{ flex: 1 }}>{e.title}</span>
                <span className="app-chip">{e.type}</span>
                <span className="app-chip">v{e.version}</span>
                <span className="app-chip">{e.status}</span>
                {e.stale ? <span className="app-chip app-chip--warn">stale</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* D2 pre-run preview */}
      {selected.size > 0 ? (
        <div className="app-card app-card--muted" style={{ marginTop: 12 }}>
          <strong>Before you run</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
            <li>{selected.size} record(s): {selectedList.map((e) => e.title).join(", ")}</li>
            <li>Data mode: Metadata only (no raw evidence content sent)</li>
            <li>Processing: external AI provider (advisory, no-training)</li>
            <li>Estimated: 1 AI operation</li>
            <li>Workspace policy governs availability; AI output is advisory and never a legal/forensic determination.</li>
            <li>Advisory results are retained as bounded metadata per workspace retention policy.</li>
          </ul>
        </div>
      ) : null}

      {/* Controls */}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button className="app-btn app-btn--primary" onClick={run} disabled={selected.size === 0 || state.kind === "loading"} aria-busy={state.kind === "loading"}>
          {state.kind === "loading" ? "Analyzing…" : state.kind === "result" ? "Re-run" : "Run Case Copilot"}
        </button>
        {state.kind === "loading" ? <span style={{ alignSelf: "center", opacity: 0.7 }} aria-live="polite">Advisory only — this does not change any record.</span> : null}
      </div>

      {/* States */}
      {state.kind === "error" ? (
        <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert">
          {state.message} <span style={{ opacity: 0.6 }}>({state.code})</span>
        </div>
      ) : null}

      {state.kind === "result" ? <ResultView result={state.result} /> : null}
    </section>
  );
}

function Header() {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <h3 style={{ margin: 0 }}>Evidence Operations Copilot</h3>
      <span style={{ display: "flex", gap: 6 }}>
        <span className="app-chip app-chip--ai">AI-generated</span>
        <span className="app-chip">Advisory only</span>
        <span className="app-chip">Metadata only</span>
      </span>
    </div>
  );
}

function ResultView({ result }: { result: RunResult }) {
  if (result.status === "provider_unavailable") {
    return <div className="app-alert" style={{ marginTop: 12 }}>AI is currently unavailable. Case workflows are unaffected.</div>;
  }
  if (result.status === "policy_denied") {
    return <div className="app-alert" style={{ marginTop: 12 }}>Case Copilot is disabled for this workspace ({result.decision}).</div>;
  }
  if (result.status === "no_selection") {
    return <div className="app-alert" style={{ marginTop: 12 }}>Select at least one evidence record to analyze.</div>;
  }
  if (result.status === "schema_error") {
    return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI response could not be validated and was discarded. Please try again.</div>;
  }
  const data = result.data;
  if (result.status === "blocked_prohibited_claim" || !data) {
    return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI output contained language PROOVRA cannot present and was blocked. AI cannot determine truth, authenticity, or admissibility.</div>;
  }
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
      <div>
        <strong>Case summary</strong>
        <p style={{ margin: "4px 0 0" }}>{data.caseSummary}</p>
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
      <p style={{ fontSize: 12, opacity: 0.7, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>{data.advisoryBoundary}</p>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>Technical details</summary>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          Output schema v{result.versionMeta?.outputSchemaVersion ?? "1"} · analyzed {result.versionMeta?.contextObjectVersions?.length ?? 0} object version(s)
        </div>
      </details>
    </div>
  );
}

function friendly(status: number): string {
  switch (status) {
    case 400: return "Invalid selection.";
    case 401: return "Please sign in again.";
    case 403: return "You are not permitted to run AI on this case, or it is disabled by policy.";
    case 404: return "The case or an evidence record is no longer accessible.";
    case 409: return "A selected record changed (stale version). Refresh and re-select.";
    case 429: return "Too many AI requests. Please wait a moment.";
    case 502:
    case 503: return "AI is temporarily unavailable. Case workflows are unaffected.";
    default: return "The AI request could not be completed. Case workflows are unaffected.";
  }
}
