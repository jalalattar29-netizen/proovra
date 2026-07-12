"use client";

/**
 * Phase D3/D4/D6 (UI) — Reviewer Copilot inside the Review Workspace.
 *
 * Advisory only. Explicit evidence scope; human-authored versioned criteria
 * shown before invocation; per-observation Accept / Edit / Reject with the
 * original AI text preserved; the final reviewer decision stays in its
 * canonical human-authored flow — never pre-filled or auto-submitted here.
 * Renders only bounded schema-typed fields + server-validated citations.
 */
import { useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";
import { CopilotCitationList, type CopilotCitationData } from "./CopilotCitation";

type CriteriaSetOption = {
  id: string;
  name: string;
  status: string;
  versions: Array<{ id: string; version: number; publishedAt: string | null; title: string }>;
};

export type ReviewerCopilotEvidence = {
  id: string;
  title: string;
  version: number;
  status: string;
  stale?: boolean;
};

type ReviewerCopilotData = {
  reviewBrief: string;
  criteriaObservations: string[];
  missingContext: string[];
  custodyObservations: string[];
  verificationSignalObservations: string[];
  unresolvedQuestions: string[];
  conflictingMetadata: string[];
  suggestedChecklist: string[];
  escalationPreparation: string[];
  citations: CopilotCitationData[];
  advisoryBoundary: string;
};

type RunResult = {
  status: string;
  decision?: string;
  data?: ReviewerCopilotData;
  droppedCitations?: number;
  versionMeta?: {
    outputSchemaVersion?: string;
    criteriaVersion?: string;
    contextObjectVersions?: Array<{ id: string; version: number | null }>;
  };
};

type ObservationState = "PENDING" | "ACCEPTED" | "EDITED" | "REJECTED";
type ObservationReview = { state: ObservationState; editedText?: string };

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "result"; result: RunResult };

const OBS_SECTIONS: Array<{ key: keyof ReviewerCopilotData; label: string }> = [
  { key: "criteriaObservations", label: "Per-criterion observations" },
  { key: "missingContext", label: "Missing context" },
  { key: "custodyObservations", label: "Custody observations" },
  { key: "verificationSignalObservations", label: "Verification-signal observations" },
  { key: "unresolvedQuestions", label: "Unresolved questions" },
  { key: "conflictingMetadata", label: "Conflicting metadata" },
  { key: "suggestedChecklist", label: "Suggested checklist" },
  { key: "escalationPreparation", label: "Escalation preparation" },
];

export function ReviewerCopilotPanel({
  reviewId,
  evidence,
  criteriaVersion = "v1",
  aiEnabled = true,
  onInteraction,
}: {
  reviewId: string;
  evidence: ReviewerCopilotEvidence[];
  criteriaVersion?: string;
  aiEnabled?: boolean;
  /** D4 — bounded interaction callback (observationId, state, editedText). */
  onInteraction?: (observationId: string, state: ObservationState, editedText?: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [reviews, setReviews] = useState<Record<string, ObservationReview>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Phase P6 — published human-authored criteria sets (server-resolved).
  const teamId = useActiveWorkspaceId();
  const [criteriaSets, setCriteriaSets] = useState<CriteriaSetOption[]>([]);
  const [criteriaSetId, setCriteriaSetId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    if (!teamId) return;
    (async () => {
      try {
        const res = (await apiFetch(`/v1/reviewer-criteria?teamId=${teamId}`)) as { sets?: CriteriaSetOption[] };
        if (!cancelled) setCriteriaSets((res.sets ?? []).filter((s) => s.status === "PUBLISHED"));
      } catch { /* catalog optional */ }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  const selectable = evidence.filter((e) => !e.stale);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setObservation(obsId: string, review: ObservationReview) {
    setReviews((prev) => ({ ...prev, [obsId]: review }));
    onInteraction?.(obsId, review.state, review.editedText);
  }

  async function run() {
    if (selected.size === 0 || state.kind === "loading") return;
    setState({ kind: "loading" });
    setReviews({});
    try {
      const res = (await apiFetch(`/v1/ai/reviewer/${reviewId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedEvidenceIds: [...selected],
          criteriaVersion,
          ...(criteriaSetId ? { criteriaSetId } : {}),
          idempotencyKey: `${reviewId}:${criteriaSetId || criteriaVersion}:${[...selected].sort().join(",")}`,
        }),
      })) as { data?: RunResult };
      setState({ kind: "result", result: res.data ?? (res as RunResult) });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code ?? String(err.statusCode), message: friendly(err.statusCode) });
      } else {
        setState({ kind: "error", code: "NETWORK", message: "Could not reach the AI service. Review workflows are unaffected." });
      }
    }
  }

  if (!aiEnabled) {
    return (
      <section className="app-card" aria-label="Reviewer Copilot">
        <Header criteriaVersion={criteriaVersion} />
        <p style={{ opacity: 0.7 }}>AI is turned off for this workspace by policy.</p>
      </section>
    );
  }

  return (
    <section className="app-card" aria-label="Reviewer Copilot">
      <Header criteriaVersion={criteriaVersion} />

      {/* Evidence scope (explicit selection) */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Evidence in scope</strong>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="app-btn app-btn--ghost" onClick={() => setSelected(new Set(selectable.map((e) => e.id)))} disabled={selectable.length === 0}>Select all</button>
            <button className="app-btn app-btn--ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Clear</button>
          </span>
        </div>
        {evidence.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No evidence is available to this review.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {evidence.map((e) => (
              <li key={e.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", opacity: e.stale ? 0.5 : 1 }}>
                <input type="checkbox" checked={selected.has(e.id)} disabled={e.stale} onChange={() => toggle(e.id)} aria-label={`Select ${e.title}`} />
                <span style={{ flex: 1 }}>{e.title}</span>
                <span className="app-chip">v{e.version}</span>
                <span className="app-chip">{e.status}</span>
                {e.stale ? <span className="app-chip app-chip--warn">stale</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Phase P6 — human-authored criteria selection (published sets only). */}
      {criteriaSets.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            <strong>Review criteria</strong>
            <select value={criteriaSetId} onChange={(e) => setCriteriaSetId(e.target.value)} aria-label="Select review criteria set">
              <option value="">Default ({criteriaVersion})</option>
              {criteriaSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} (v{s.versions[0]?.version ?? 1})
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.6, fontSize: 12 }}>Human-authored · immutable after publish</span>
          </label>
        </div>
      ) : null}

      {/* Pre-run preview */}
      {selected.size > 0 ? (
        <div className="app-card app-card--muted" style={{ marginTop: 12 }}>
          <strong>Before you run</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
            <li>{selected.size} record(s) · criteria {criteriaVersion} · metadata only · external AI provider (advisory) · 1 operation</li>
            <li>The Copilot prepares your review. It never makes or pre-fills the review decision.</li>
            <li>Advisory results are retained as bounded metadata per workspace retention policy.</li>
          </ul>
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button className="app-btn app-btn--primary" onClick={run} disabled={selected.size === 0 || state.kind === "loading"} aria-busy={state.kind === "loading"}>
          {state.kind === "loading" ? "Preparing brief…" : state.kind === "result" ? "Re-run" : "Run Reviewer Copilot"}
        </button>
        <span aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {state.kind === "loading" ? "Preparing reviewer brief" : state.kind === "result" ? "Reviewer Copilot result ready" : ""}
        </span>
      </div>

      {state.kind === "error" ? (
        <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert">
          {state.message} <span style={{ opacity: 0.6 }}>({state.code})</span>
        </div>
      ) : null}

      {/* Phase P2-lifecycle — stale-criteria warning: never silently replace
          criteria; the reviewer keeps the original version or explicitly reruns. */}
      {state.kind === "result" && criteriaSetId ? (() => {
        const set = criteriaSets.find((s) => s.id === criteriaSetId);
        const latest = set?.versions[0]?.version;
        const usedLabel = state.result.versionMeta?.criteriaVersion ?? "";
        const stale = set && latest != null && !usedLabel.endsWith(`v${latest}`);
        return stale ? (
          <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="status">
            A newer version of “{set.name}” (v{latest}) has been published since this brief was
            generated ({usedLabel}). The result below remains linked to its original criteria
            version.{" "}
            <button className="app-btn app-btn--ghost" onClick={run}>Re-run with v{latest}</button>
          </div>
        ) : null;
      })() : null}

      {state.kind === "result" ? (
        <ResultView
          result={state.result}
          reviews={reviews}
          editing={editing}
          editText={editText}
          onAccept={(id) => setObservation(id, { state: "ACCEPTED" })}
          onReject={(id) => setObservation(id, { state: "REJECTED" })}
          onStartEdit={(id, original) => { setEditing(id); setEditText(reviews[id]?.editedText ?? original); }}
          onSaveEdit={(id) => { setObservation(id, { state: "EDITED", editedText: editText }); setEditing(null); }}
          onCancelEdit={() => setEditing(null)}
          onEditTextChange={setEditText}
        />
      ) : null}
    </section>
  );
}

function Header({ criteriaVersion }: { criteriaVersion: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <h3 style={{ margin: 0 }}>Reviewer Copilot</h3>
      <span style={{ display: "flex", gap: 6 }}>
        <span className="app-chip app-chip--ai">AI-generated</span>
        <span className="app-chip">Advisory only</span>
        <span className="app-chip">Metadata only</span>
        <span className="app-chip">Criteria {criteriaVersion}</span>
      </span>
    </div>
  );
}

function ResultView(props: {
  result: RunResult;
  reviews: Record<string, ObservationReview>;
  editing: string | null;
  editText: string;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onStartEdit: (id: string, original: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onEditTextChange: (t: string) => void;
}) {
  const { result } = props;
  if (result.status === "provider_unavailable") {
    return <div className="app-alert" style={{ marginTop: 12 }}>AI is currently unavailable. Review workflows are unaffected.</div>;
  }
  if (result.status === "policy_denied") {
    return <div className="app-alert" style={{ marginTop: 12 }}>Reviewer Copilot is disabled for this workspace ({result.decision}).</div>;
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
        <strong>Review brief</strong>
        <p style={{ margin: "4px 0 0" }}>{data.reviewBrief}</p>
      </div>
      {OBS_SECTIONS.map(({ key, label }) => {
        const items = data[key] as string[];
        if (!Array.isArray(items) || items.length === 0) return null;
        return (
          <div key={key}>
            <strong>{label}</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {items.map((text, i) => {
                const obsId = `${key}:${i}`;
                const review = props.reviews[obsId];
                const isEditing = props.editing === obsId;
                return (
                  <li key={obsId} style={{ marginBottom: 6 }}>
                    {review?.state === "EDITED" ? (
                      <>
                        <span>{review.editedText}</span>{" "}
                        <span className="app-chip">edited</span>{" "}
                        <details style={{ display: "inline" }}>
                          <summary style={{ display: "inline", cursor: "pointer", fontSize: 12, opacity: 0.6 }}>original AI text</summary>
                          <span style={{ fontSize: 12, opacity: 0.7 }}> {text}</span>
                        </details>
                      </>
                    ) : (
                      <span style={{ textDecoration: review?.state === "REJECTED" ? "line-through" : undefined, opacity: review?.state === "REJECTED" ? 0.5 : 1 }}>
                        {text}
                      </span>
                    )}
                    {review?.state === "ACCEPTED" ? <span className="app-chip" style={{ marginLeft: 6 }}>accepted</span> : null}
                    {isEditing ? (
                      <span style={{ display: "block", marginTop: 4 }}>
                        <textarea value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} maxLength={600} rows={2} style={{ width: "100%" }} aria-label="Edit observation" />
                        <button className="app-btn app-btn--primary" onClick={() => props.onSaveEdit(obsId)} style={{ marginRight: 6 }}>Save edit</button>
                        <button className="app-btn app-btn--ghost" onClick={props.onCancelEdit}>Cancel</button>
                      </span>
                    ) : (
                      <span style={{ marginLeft: 8, display: "inline-flex", gap: 4 }}>
                        <button className="app-btn app-btn--ghost" onClick={() => props.onAccept(obsId)} aria-label={`Accept observation ${obsId}`}>Accept</button>
                        <button className="app-btn app-btn--ghost" onClick={() => props.onStartEdit(obsId, text)} aria-label={`Edit observation ${obsId}`}>Edit</button>
                        <button className="app-btn app-btn--ghost" onClick={() => props.onReject(obsId)} aria-label={`Reject observation ${obsId}`}>Reject</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div>
        <strong>Validated sources</strong>
        <div style={{ marginTop: 4 }}><CopilotCitationList citations={data.citations} /></div>
        {result.droppedCitations ? <p style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{result.droppedCitations} unverifiable citation(s) were removed.</p> : null}
      </div>
      <p style={{ fontSize: 12, opacity: 0.7, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>
        {data.advisoryBoundary} The final review decision remains yours and is recorded separately.
      </p>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>Technical details</summary>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          Output schema v{result.versionMeta?.outputSchemaVersion ?? "1"} · criteria {result.versionMeta?.criteriaVersion ?? "v1"} · analyzed {result.versionMeta?.contextObjectVersions?.length ?? 0} object version(s)
        </div>
      </details>
    </div>
  );
}

function friendly(status: number): string {
  switch (status) {
    case 401: return "Please sign in again.";
    case 403: return "You are not permitted to run AI on this review, or it is disabled by policy.";
    case 404: return "The review or an evidence record is no longer accessible.";
    case 429: return "Too many AI requests. Please wait a moment.";
    case 502:
    case 503: return "AI is temporarily unavailable. Review workflows are unaffected.";
    default: return "The AI request could not be completed. Review workflows are unaffected.";
  }
}
