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
import { AppStatusText } from "../app-primitives/AppStatusText";
import { AppListbox } from "../app-primitives/AppListbox";
import { useEffect, useState } from "react";

import { buildCopilotIdempotencyKey, identifierLabel } from "@proovra/shared";
import { aiPanelFailure } from "../../lib/ai/assistant-state";

import { apiFetch, isApiResponseError } from "../../lib/api";
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
  /**
   * THE CONCURRENCY AUTHORITY — opaque, server-computed, carried verbatim.
   *
   * This was `version: number`, and the one page that mounts this panel
   * passed a literal `0` — so the field said nothing, and the route it fed
   * had no concurrency guard to say it to. `undefined` means the projection
   * carried no revision, which makes the record ineligible rather than
   * analyzable against a guess.
   */
  analysisRevision: string | undefined;
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
    contextObjectRevisions?: Array<{ id: string; revision: string }>;
  };
};

type ObservationState = "PENDING" | "ACCEPTED" | "EDITED" | "REJECTED";
type ObservationReview = {
  state: ObservationState;
  editedText?: string;
  /**
   * PHASE 12 POINT 1 / B1 — persistence status of THIS verdict against
   * `POST /v1/ai/copilot-runs/:runId/observations`. A verdict that is not
   * `SAVED` has not been recorded on the defensibility record and is
   * labelled as such; the UI never implies a durable record it does not have.
   */
  sync?: "SAVING" | "SAVED" | "FAILED";
};

/**
 * PHASE 12 POINT 1 / B1 — the server's response to a recorded observation
 * verdict. Sourced from the canonical AI policy + disclosure authorities;
 * this surface renders it verbatim and never composes its own AI claims.
 */
type ObservationDisclosure = {
  capability: string;
  provider: string | null;
  dataCategory: string | null;
  rawContent: boolean | null;
  operationalStatus: string | null;
  trainingMode: string | null;
  retentionMode: string | null;
};

type ObservationAck = {
  aiPolicy?: {
    decision?: string | null;
    allowed?: boolean | null;
    policyVersion?: string | null;
    runPolicyVersion?: string | null;
  } | null;
  disclosure?: ObservationDisclosure[] | null;
  advisoryBoundary?: string | null;
};

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string; settingsHref?: string | null }
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
  // T-091 (stage D) — one record is pre-selected (no Select all / Clear for a
  // list of one); the panel is collapsed until the reviewer opens it.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const only = evidence.length === 1 ? evidence[0] : undefined;
    return only && !only.stale && only.analysisRevision !== undefined ? new Set([only.id]) : new Set();
  });
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [reviews, setReviews] = useState<Record<string, ObservationReview>>({});
  // PHASE 12 POINT 1 / B1 — the persisted run this panel's verdicts attach to.
  const [runId, setRunId] = useState<string | null>(null);
  const [ack, setAck] = useState<ObservationAck | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
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

  // A record with no revision cannot be compared, so it cannot be selected.
  // FAIL CLOSED: the alternative is offering a selection the server will
  // refuse, which is how an operator learns about a contract by being
  // blocked by it.
  const selectable = evidence.filter(
    (e) => !e.stale && e.analysisRevision !== undefined,
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * PHASE 12 POINT 1 / B1 — record a human Accept / Edit / Reject on the
   * DEFENSIBILITY RECORD, not just in local component state.
   *
   * The verdict is applied optimistically so the reviewer is never made to
   * wait on the network mid-review, then persisted through
   * `POST /v1/ai/copilot-runs/:runId/observations`. If persistence fails the
   * row is marked FAILED and offers a retry — the verdict is NEVER silently
   * dropped, and the UI never claims a durable record it does not have.
   *
   * The original AI text is always sent alongside an edit so the record keeps
   * what the model actually said next to what the human made of it.
   */
  async function setObservation(
    obsId: string,
    review: ObservationReview,
    originalText: string,
  ) {
    setReviews((prev) => ({ ...prev, [obsId]: { ...review, sync: runId ? "SAVING" : undefined } }));
    onInteraction?.(obsId, review.state, review.editedText);
    if (!runId || review.state === "PENDING") return;
    setAckError(null);
    try {
      const res = (await apiFetch(`/v1/ai/copilot-runs/${runId}/observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          observationId: obsId,
          state: review.state,
          originalText: originalText.slice(0, 1000),
          ...(review.state === "EDITED" && review.editedText
            ? { editedText: review.editedText.slice(0, 600) }
            : {}),
        }),
      })) as ObservationAck;
      setReviews((prev) =>
        prev[obsId] ? { ...prev, [obsId]: { ...prev[obsId], sync: "SAVED" } } : prev,
      );
      setAck({
        aiPolicy: res?.aiPolicy ?? null,
        disclosure: Array.isArray(res?.disclosure) ? res.disclosure : [],
        advisoryBoundary: res?.advisoryBoundary ?? null,
      });
    } catch (err) {
      setReviews((prev) =>
        prev[obsId] ? { ...prev, [obsId]: { ...prev[obsId], sync: "FAILED" } } : prev,
      );
      setAckError(
        isApiResponseError(err)
          ? friendly(err.statusCode ?? 0)
          : "Your verdict was not recorded. The review decision itself is unaffected.",
      );
    }
  }

  async function run() {
    if (selected.size === 0 || state.kind === "loading") return;
    // Only records whose revision is known may be sent. A record without one
    // cannot be compared, so sending it would ask the server to analyze
    // something nobody can say is current.
    const revisions: Record<string, string> = {};
    for (const e of evidence) {
      if (selected.has(e.id) && e.analysisRevision !== undefined) {
        revisions[e.id] = e.analysisRevision;
      }
    }
    setState({ kind: "loading" });
    setReviews({});
    setRunId(null);
    setAck(null);
    setAckError(null);
    try {
      const res = (await apiFetch(`/v1/ai/reviewer/${reviewId}/copilot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedEvidenceIds: [...selected],
          // Every selected record's revision. The route requires one per id
          // and refuses the run otherwise.
          selectedEvidenceRevisions: revisions,
          criteriaVersion,
          ...(criteriaSetId ? { criteriaSetId } : {}),
          // BOUNDED, by the same authority the Case panel uses. This built
          // `${reviewId}:${criteriaSetId}:${ids.join(",")}` against the route's
          // `z.string().max(80)` — a review id and a criteria-set id are 73
          // characters before a single evidence id is added, so this panel
          // failed at even ONE selection, exactly as the Case panel failed at
          // two.
          idempotencyKey: buildCopilotIdempotencyKey({
            scope: "reviewer",
            scopeId: reviewId,
            selection: [...selected],
            // REVISION-AWARE, so a retry after a genuine change cannot be
            // de-duplicated into the answer from the previous state.
            revisions,
            qualifier: criteriaSetId || String(criteriaVersion),
          }),
        }),
      })) as { data?: RunResult; runId?: string | null };
      setRunId(typeof res?.runId === "string" ? res.runId : null);
      const result = res.data ?? (res as RunResult);
      // T-091 — an outage answered with HTTP 200 is an error, never an empty result.
      if (result?.status === "provider_unavailable") {
        setState({ kind: "error", code: "provider_unavailable", message: "The AI service is unavailable right now. Nothing was run; review workflows are unaffected." });
        return;
      }
      setState({ kind: "result", result });
    } catch (err) {
      if (isApiResponseError(err)) {
        // PRO-AI1C-04 — the shared classifier, code first.
        const failure = aiPanelFailure(err, friendly);
        setState({ kind: "error", code: err.code ?? String(err.statusCode), message: failure.message, settingsHref: failure.settingsHref });
      } else {
        setState({ kind: "error", code: "NETWORK", message: "Could not reach the AI service. Review workflows are unaffected." });
      }
    }
  }

  const selectedSet = criteriaSets.find((x) => x.id === criteriaSetId) ?? null;
  const criteriaLabel = selectedSet
    ? `${selectedSet.name} v${selectedSet.versions[0]?.version ?? 1}`
    : "No criteria set";
  const runBlockedReason =
    state.kind === "loading"
      ? null
      : selected.size === 0
        ? selectable.length === 0
          ? "No record here can be analysed right now: its state is unavailable or out of date."
          : "Select a record first."
        : null;

  if (!aiEnabled) {
    return (
      <section className="app-panel app-panel__body" aria-label="Reviewer Copilot">
        <Header criteriaLabel={criteriaLabel} expanded onToggle={() => {}} />
        <p style={{ opacity: 0.7 }}>
          The Reviewer Copilot is not available to you in this workspace: the workspace AI policy turns it off, or
          does not allow it for your role or plan. An owner can change this in Settings → AI.
        </p>
      </section>
    );
  }

  return (
    <section className="app-panel app-panel__body" aria-label="Reviewer Copilot" data-copilot-expanded={expanded ? "true" : "false"}>
      <Header criteriaLabel={criteriaLabel} expanded={expanded} onToggle={() => setExpanded((x) => !x)} />

      {expanded ? (
      <>
      {/* Evidence scope (explicit selection) */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <strong>Evidence in scope</strong>
          {evidence.length > 1 ? (
            <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="app-ghost-action" onClick={() => setSelected(new Set(selectable.map((e) => e.id)))} disabled={selectable.length === 0} title={selectable.length === 0 ? "No record can be selected." : undefined}>Select all</button>
              <button type="button" className="app-ghost-action" onClick={() => setSelected(new Set())} disabled={selected.size === 0} title={selected.size === 0 ? "Nothing is selected." : undefined}>Clear</button>
            </span>
          ) : null}
        </div>
        {evidence.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No evidence is available to this review.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {evidence.map((e) => (
              <li key={e.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "4px 0", opacity: e.stale || e.analysisRevision === undefined ? 0.5 : 1 }}>
                <input
                  type="checkbox"
                  checked={selected.has(e.id)}
                  // A record with no revision cannot be compared, so it cannot
                  // be selected. This rendered `v{e.version}` from a literal
                  // `0` the page hard-coded, which said nothing about anything.
                  disabled={e.stale || e.analysisRevision === undefined}
                  onChange={() => toggle(e.id)}
                  aria-label={`Select ${e.title}`}
                />
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{e.title}</span>
                <AppStatusText tone="slate">{identifierLabel(e.status)}</AppStatusText>
                {/*
                  The revision itself is never shown: it is a digest, and an
                  operator cannot act on one. What they can act on is whether
                  this record is currently comparable.
                */}
                {e.analysisRevision === undefined ? (
                  <AppStatusText tone="amber">state unavailable</AppStatusText>
                ) : null}
                {e.stale ? <AppStatusText tone="amber">out of date</AppStatusText> : null}
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
            <AppListbox
              value={criteriaSetId}
              options={[
                { value: "", label: "No criteria set" },
                ...criteriaSets.map((s) => ({ value: s.id, label: `${s.name} (v${s.versions[0]?.version ?? 1})` })),
              ]}
              onChange={(next) => setCriteriaSetId(next)}
              ariaLabel={"Select review criteria set"}
            />
            <span style={{ opacity: 0.6, fontSize: 12 }}>Human-authored · immutable after publish</span>
          </label>
        </div>
      ) : null}

      {/* Pre-run preview */}
      {selected.size > 0 ? (
        <div className="app-inner-surface app-panel__body" style={{ marginTop: 12 }}>
          <strong>Before you run</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
            <li>{selected.size} {selected.size === 1 ? "record" : "records"} · {criteriaLabel} · metadata only · external AI provider (advisory) · 1 operation</li>
            <li>The Copilot prepares your review. It never makes or pre-fills the review decision.</li>
            <li>Advisory results are retained as bounded metadata per workspace retention policy.</li>
          </ul>
        </div>
      ) : null}

      {/* TEAM-UI-SPEC §2 — secondary: the inspector's one primary is the
          decision panel's submit; the Copilot never competes with it. */}
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="app-secondary-action"
          onClick={run}
          disabled={selected.size === 0 || state.kind === "loading"}
          aria-busy={state.kind === "loading"}
          aria-describedby={runBlockedReason ? "reviewer-copilot-run-reason" : undefined}
          data-copilot-run
        >
          {state.kind === "loading" ? "Preparing brief…" : state.kind === "result" ? "Re-run" : "Run Reviewer Copilot"}
        </button>
        {runBlockedReason ? (
          <span id="reviewer-copilot-run-reason" className="app-field-help" style={{ margin: 0 }} data-copilot-run-reason>
            {runBlockedReason}
          </span>
        ) : null}
        <span aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {state.kind === "loading" ? "Preparing reviewer brief" : state.kind === "result" ? "Reviewer Copilot result ready" : ""}
        </span>
      </div>

      {state.kind === "error" ? (
        <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert">
          {state.message}
          {state.settingsHref ? (
            <>
              {" "}
              <a href={state.settingsHref} className="app-link">See AI usage in Settings</a>
            </>
          ) : null}
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
            <button type="button" className="app-secondary-action" onClick={run}>Re-run with v{latest}</button>
          </div>
        ) : null;
      })() : null}

      {/* PHASE 12 POINT 1 / B1 — persistence failure is surfaced, never
          swallowed. The reviewer's own decision flow is unaffected. */}
      {ackError ? (
        <div className="app-alert app-alert--warn" style={{ marginTop: 12 }} role="alert" data-copilot-observation-error>
          {ackError}
        </div>
      ) : null}

      {state.kind === "result" ? (
        <ResultView
          result={state.result}
          reviews={reviews}
          editing={editing}
          editText={editText}
          persistable={Boolean(runId)}
          onAccept={(id, original) => void setObservation(id, { state: "ACCEPTED" }, original)}
          onReject={(id, original) => void setObservation(id, { state: "REJECTED" }, original)}
          onStartEdit={(id, original) => { setEditing(id); setEditText(reviews[id]?.editedText ?? original); }}
          onSaveEdit={(id, original) => { void setObservation(id, { state: "EDITED", editedText: editText }, original); setEditing(null); }}
          onCancelEdit={() => setEditing(null)}
          onEditTextChange={setEditText}
        />
      ) : null}

      {/* PHASE 12 POINT 1 / B1 — the server's answer to the recorded verdict:
          which policy governed the run, and the canonical disclosure for the
          reviewer capability. Rendered verbatim from the API. */}
      {ack ? (
        <div className="app-inner-surface app-panel__body" style={{ marginTop: 12 }} data-copilot-observation-ack>
          <strong style={{ fontSize: 13 }}>Recorded on the AI defensibility record</strong>
          {ack.aiPolicy ? (
            <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.75 }}>
              Run governed by policy {ack.aiPolicy.runPolicyVersion ?? "—"}
              {ack.aiPolicy.policyVersion && ack.aiPolicy.policyVersion !== ack.aiPolicy.runPolicyVersion
                ? ` · workspace policy is now ${ack.aiPolicy.policyVersion}`
                : ""}
              {ack.aiPolicy.decision ? ` · ${identifierLabel(ack.aiPolicy.decision)}` : ""}
            </p>
          ) : null}
          {ack.disclosure && ack.disclosure.length > 0 ? (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, opacity: 0.75 }}>
              {ack.disclosure.map((d) => (
                <li key={d.capability}>
                  {identifierLabel(d.capability)}
                  {d.provider ? ` · ${identifierLabel(d.provider)}` : ""}
                  {d.dataCategory ? ` · ${d.dataCategory}` : ""}
                  {d.trainingMode ? ` · training: ${d.trainingMode}` : ""}
                  {d.retentionMode ? ` · retention: ${d.retentionMode}` : ""}
                  {d.operationalStatus ? ` · ${d.operationalStatus}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {ack.advisoryBoundary ? (
            <p style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.7 }}>{ack.advisoryBoundary}</p>
          ) : null}
        </div>
      ) : null}
      </>
      ) : null}
    </section>
  );
}

/**
 * T-091 (stage D) — the header says what is true before a run: advisory,
 * metadata only, and WHICH criteria (the selected set and version, or "No
 * criteria set"). "AI-generated" labels results only. Plain status text.
 */
function Header({ criteriaLabel, expanded, onToggle }: { criteriaLabel: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <h2 className="app-panel__title" style={{ margin: 0 }}>Reviewer Copilot</h2>
      <span className="app-status-text-row" style={{ minWidth: 0 }}>
        <AppStatusText tone="slate">Advisory only</AppStatusText>
        <AppStatusText tone="slate">Metadata only</AppStatusText>
        <AppStatusText tone="slate" data-copilot-criteria-label>{criteriaLabel}</AppStatusText>
        <button type="button" className="app-ghost-action" aria-expanded={expanded} onClick={onToggle} data-copilot-toggle>
          {expanded ? "Hide" : "Open Copilot"}
        </button>
      </span>
    </div>
  );
}

function ResultView(props: {
  result: RunResult;
  reviews: Record<string, ObservationReview>;
  editing: string | null;
  editText: string;
  /** True when the run persisted and verdicts can attach to a record. */
  persistable: boolean;
  onAccept: (id: string, original: string) => void;
  onReject: (id: string, original: string) => void;
  onStartEdit: (id: string, original: string) => void;
  onSaveEdit: (id: string, original: string) => void;
  onCancelEdit: () => void;
  onEditTextChange: (t: string) => void;
}) {
  const { result } = props;
  if (result.status === "provider_unavailable") {
    return <div className="app-alert" style={{ marginTop: 12 }}>AI is currently unavailable. Review workflows are unaffected.</div>;
  }
  if (result.status === "policy_denied") {
    return <div className="app-alert" style={{ marginTop: 12 }}>Reviewer Copilot is disabled for this workspace {result.decision ? ` (${identifierLabel(result.decision)})` : ""}.</div>;
  }
  if (result.status === "schema_error") {
    return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI response could not be validated and was discarded. Please try again.</div>;
  }
  const data = result.data;
  if (result.status === "blocked_prohibited_claim" || !data) {
    return <div className="app-alert app-alert--warn" style={{ marginTop: 12 }}>The AI output contained language PROOVRA cannot present and was blocked. AI cannot determine truth, authenticity, or admissibility.</div>;
  }
  return (
    <div style={{ marginTop: 12, display: "grid", gap: 12 }} data-copilot-result>
      <AppStatusText tone="purple" data-copilot-ai-generated>AI-generated</AppStatusText>
      <div>
        <strong>Review brief</strong>
        <p style={{ margin: "4px 0 0" }}>{data.reviewBrief}</p>
      </div>
      {/* PHASE 12 POINT 1 / B1 — when the run did not persist there is no
          record to attach verdicts to. Say so rather than implying one. */}
      {!props.persistable ? (
        <div className="app-alert" role="status" data-copilot-observation-unrecorded>
          This brief was not written to the AI defensibility record, so your
          Accept / Edit / Reject marks stay on this screen only.
        </div>
      ) : null}
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
                        <AppStatusText tone="slate">edited</AppStatusText>{" "}
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
                    {review?.state === "ACCEPTED" ? <AppStatusText tone="green">accepted</AppStatusText> : null}
                    {/* PHASE 12 POINT 1 / B1 — honest persistence state. */}
                    {review?.sync === "SAVING" ? (
                      <AppStatusText tone="slate" data-copilot-observation-sync="SAVING">recording…</AppStatusText>
                    ) : review?.sync === "SAVED" ? (
                      <AppStatusText tone="green" data-copilot-observation-sync="SAVED">recorded</AppStatusText>
                    ) : review?.sync === "FAILED" ? (
                      <AppStatusText tone="amber" data-copilot-observation-sync="FAILED">not recorded</AppStatusText>
                    ) : null}
                    {isEditing ? (
                      <span style={{ display: "block", marginTop: 4 }}>
                        <textarea className="app-input app-textarea" value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} maxLength={600} rows={2} style={{ boxSizing: "border-box" }} aria-label="Edit observation" />
                        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                          <button type="button" className="app-secondary-action app-secondary-action--filled" onClick={() => props.onSaveEdit(obsId, text)}>Save edit</button>
                          <button type="button" className="app-secondary-action" onClick={props.onCancelEdit}>Cancel</button>
                        </span>
                      </span>
                    ) : (
                      <span style={{ marginLeft: 8, display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                        <button type="button" className="app-secondary-action" onClick={() => props.onAccept(obsId, text)} aria-label={`Accept observation ${obsId}`}>{review?.sync === "FAILED" && review.state === "ACCEPTED" ? "Retry accept" : "Accept"}</button>
                        <button type="button" className="app-secondary-action" onClick={() => props.onStartEdit(obsId, text)} aria-label={`Edit observation ${obsId}`}>Edit</button>
                        <button type="button" className="app-secondary-action" onClick={() => props.onReject(obsId, text)} aria-label={`Reject observation ${obsId}`}>{review?.sync === "FAILED" && review.state === "REJECTED" ? "Retry reject" : "Reject"}</button>
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
        <div className="app-copilot-sources"><CopilotCitationList citations={data.citations} /></div>
        {result.droppedCitations ? <p style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{result.droppedCitations} unverifiable citation(s) were removed.</p> : null}
      </div>
      <p style={{ fontSize: 12, opacity: 0.7, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>
        {data.advisoryBoundary} The final review decision remains yours and is recorded separately.
      </p>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>Technical details</summary>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          Output schema v{result.versionMeta?.outputSchemaVersion ?? "1"} · criteria {result.versionMeta?.criteriaVersion ?? "v1"} · analyzed {result.versionMeta?.contextObjectRevisions?.length ?? 0} record revision(s)
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
