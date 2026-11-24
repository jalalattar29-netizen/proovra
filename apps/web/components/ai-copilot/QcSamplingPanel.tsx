"use client";
import { AppListbox } from "../app-primitives/AppListbox";
import { AppStatusText } from "../app-primitives/AppStatusText";
import { identifierLabel } from "@proovra/shared";
import { formatUserDateTime } from "../../lib/date";

/**
 * Phase QC (UI) — Reviewer Operations QC Sampling panel.
 *
 * Consumes ONLY the existing backend routes:
 *   GET  /v1/ai/qc/samples?teamId&strategy
 *   POST /v1/ai/qc/samples/:runId/decision
 *
 * QC verdicts are human decisions persisted on the canonical
 * AiCopilotObservationReview model (observationId "qc") and audit-logged
 * server-side. AI "confidence" is never presented as truth confidence —
 * sampling keys on operational signals (edit/reject rates, blocks, failures).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch, isApiResponseError } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";
import "../reviewer-experience/review-surfaces.css";

const STRATEGIES = [
  { value: "RISK_BASED", label: "Risk-based" },
  { value: "RANDOM", label: "Random" },
  { value: "HIGH_EDIT_RATE", label: "High edit rate" },
  { value: "LOW_CITATION", label: "Dropped citations" },
  { value: "DISAGREEMENT", label: "Disagreement" },
  { value: "POLICY_BLOCK", label: "Policy blocks" },
  { value: "PROVIDER_FAILURE", label: "Provider failures" },
] as const;

type QcSample = {
  id: string;
  feature: string;
  status: string;
  generatedAt: string;
  observationCount: number;
  editedCount: number;
  rejectedCount: number;
  interactionCount: number;
  qcState: string | null;
  myQcState: string | null;
  latestQcState: string | null;
  qcReviewerCount: number;
  caseId: string | null;
  reviewId: string | null;
  criteriaVersion: string | null;
};

type UiState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error" }
  | { kind: "ready"; samples: QcSample[]; catalogAvailable: boolean };

const FEATURE_LABEL: Record<string, string> = {
  CASE_COPILOT: "Case Copilot",
  REVIEWER_COPILOT: "Reviewer Copilot",
  EVIDENCE_COPILOT: "Evidence Copilot",
  OPERATIONS_INTELLIGENCE: "Operations Intelligence",
};

/**
 * Phase F-5 — deterministic QC state rendering: the CURRENT USER's own
 * verdict wins; otherwise the LATEST verdict across QC reviewers (with the
 * reviewer count shown). Never an arbitrary first reviewer.
 */
function qcChip(s: Pick<QcSample, "myQcState" | "latestQcState" | "qcReviewerCount">): { label: string; tone: "green" | "amber" } {
  const stateLabel = (state: string | null): string | null => {
    switch (state) {
      case "ACCEPTED": return "accepted";
      case "REJECTED": return "skipped";
      case "EDITED": return "reviewed";
      default: return null;
    }
  };
  const mine = stateLabel(s.myQcState);
  if (mine) return { label: `Your QC: ${mine}`, tone: "green" };
  const latest = stateLabel(s.latestQcState);
  if (latest) {
    const suffix = s.qcReviewerCount > 1 ? ` (${s.qcReviewerCount} reviewers)` : "";
    return { label: `Latest QC: ${latest}${suffix}`, tone: "green" };
  }
  return { label: "awaiting QC", tone: "amber" };
}

export function QcSamplingPanel() {
  const teamId = useActiveWorkspaceId();
  const [strategy, setStrategy] = useState<string>("RISK_BASED");
  const [state, setState] = useState<UiState>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 5;

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(
        `/v1/ai/qc/samples?teamId=${teamId}&strategy=${strategy}`,
      )) as { samples: QcSample[]; catalogAvailable?: boolean };
      setState({ kind: "ready", samples: res.samples, catalogAvailable: res.catalogAvailable !== false });
      setPage(0);
    } catch (err) {
      setState(isApiResponseError(err) && err.statusCode === 403 ? { kind: "denied" } : { kind: "error" });
    }
  }, [teamId, strategy]);
  useEffect(() => { void load(); }, [load]);

  async function decide(runId: string, decision: "QC_ACCEPTED" | "QC_SKIPPED" | "QC_REVIEWED") {
    if (busyId) return;
    setBusyId(runId);
    try {
      await apiFetch(`/v1/ai/qc/samples/${runId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch {
      setState({ kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  if (!teamId) return null;

  // TEAM-UI-SPEC §1 — one app-panel; every per-sample action is secondary
  // (Accept is the sample's forward step but sits in a repeated row, so no
  // row carries a primary); Skip is ghost. Chips wrap on a phone.
  return (
    <section className="app-panel review-qc-panel" aria-labelledby="qc-sampling-title" data-qc-sampling-panel>
      <div className="app-panel__head">
        <h3 className="app-panel__title" id="qc-sampling-title">Sampled Copilot runs</h3>
        <span className="review-chip-row">
          <AppListbox
            value={strategy}
            options={[
              ...STRATEGIES.map((s) => ({ value: s.value, label: s.label })),
            ]}
            onChange={(next) => setStrategy(next)}
            ariaLabel={"Sampling strategy"}
          />
        </span>
      </div>
      <div className="app-panel__body">
        <p className="app-field-help">
          Sampled Copilot runs for human quality control. Sampling uses operational
          signals only (edits, rejections, dropped citations, blocks) — never a claim
          about evidence truth or reliability.
        </p>

        {state.kind === "loading" ? <p className="app-field-help" aria-live="polite">Loading samples…</p> : null}
        {state.kind === "denied" ? <div className="app-alert" role="alert">Your role in this workspace does not include QC sampling.</div> : null}
        {state.kind === "error" ? <div className="app-alert app-alert--warn" role="alert">QC sampling is unavailable right now. Review workflows are unaffected.</div> : null}
        {state.kind === "ready" && !state.catalogAvailable ? (
          <div className="app-alert">The AI run catalog is not provisioned in this environment yet.</div>
        ) : null}
        {state.kind === "ready" && state.catalogAvailable && state.samples.length === 0 ? (
          <div className="app-alert">No Copilot runs match this sampling strategy yet.</div>
        ) : null}

        {state.kind === "ready" && state.samples.length > 0 ? (
          <>
            <ul className="review-sample-list">
              {state.samples.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => {
                const chip = qcChip(s);
                return (
                  <li key={s.id} data-qc-sample={s.id}>
                    <div className="review-chip-row">
                      <strong>{FEATURE_LABEL[s.feature] ?? s.feature}</strong>
                      <AppStatusText tone="slate">{identifierLabel(s.status)}</AppStatusText>
                      <AppStatusText tone={chip.tone}>{chip.label}</AppStatusText>
                      <span className="app-table__muted">{formatUserDateTime(s.generatedAt)}</span>
                    </div>
                    <div className="app-table__muted review-chip-row">
                      <span>
                        {s.interactionCount} human interaction(s) · {s.editedCount} edited · {s.rejectedCount} rejected
                        {s.criteriaVersion ? <> · criteria {s.criteriaVersion}</> : null}
                      </span>
                      {s.reviewId ? <Link className="app-link" href={`/reviewer-ops/${s.reviewId}`}>Open review</Link> : null}
                      {s.caseId ? <Link className="app-link" href={`/cases/${s.caseId}`}>Open case</Link> : null}
                    </div>
                    <div className="review-chip-row">
                      <button type="button" className="app-secondary-action" data-qc-decision="QC_ACCEPTED" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_ACCEPTED")}>Accept</button>
                      <button type="button" className="app-secondary-action" data-qc-decision="QC_REVIEWED" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_REVIEWED")}>Mark reviewed</button>
                      <button type="button" className="app-ghost-action" data-qc-decision="QC_SKIPPED" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_SKIPPED")}>Skip</button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {state.samples.length > PAGE_SIZE ? (
              <div className="review-chip-row">
                <button type="button" className="app-secondary-action" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span className="app-table__muted">Page {page + 1} of {Math.ceil(state.samples.length / PAGE_SIZE)}</span>
                <button type="button" className="app-secondary-action" disabled={(page + 1) * PAGE_SIZE >= state.samples.length} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            ) : null}
          </>
        ) : null}
        <p className="app-field-help">
          Every decision is recorded with your identity in the audit log.
        </p>
      </div>
    </section>
  );
}
