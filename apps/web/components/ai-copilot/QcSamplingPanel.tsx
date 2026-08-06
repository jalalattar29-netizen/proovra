"use client";
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

import { apiFetch, ApiError } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";

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
function qcChip(s: Pick<QcSample, "myQcState" | "latestQcState" | "qcReviewerCount">): { label: string; cls: string } {
  const stateLabel = (state: string | null): string | null => {
    switch (state) {
      case "ACCEPTED": return "accepted";
      case "REJECTED": return "skipped";
      case "EDITED": return "reviewed";
      default: return null;
    }
  };
  const mine = stateLabel(s.myQcState);
  if (mine) return { label: `Your QC: ${mine}`, cls: "app-chip--ok" };
  const latest = stateLabel(s.latestQcState);
  if (latest) {
    const suffix = s.qcReviewerCount > 1 ? ` (${s.qcReviewerCount} reviewers)` : "";
    return { label: `Latest QC: ${latest}${suffix}`, cls: "app-chip--ok" };
  }
  return { label: "awaiting QC", cls: "app-chip--warn" };
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
      setState(err instanceof ApiError && err.statusCode === 403 ? { kind: "denied" } : { kind: "error" });
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

  return (
    <section className="app-card" style={{ marginTop: 16 }} aria-label="AI QC sampling">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>AI QC sampling</h3>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="app-chip">Human quality control</span>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} aria-label="Sampling strategy">
              {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </span>
      </div>
      <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
        Sampled Copilot runs for human quality control. Sampling uses operational
        signals only (edits, rejections, dropped citations, blocks) — never a claim
        about evidence truth or reliability.
      </p>

      {state.kind === "loading" ? <p style={{ opacity: 0.6 }} aria-live="polite">Loading samples…</p> : null}
      {state.kind === "denied" ? <div className="app-alert" role="alert">You are not a member of this workspace.</div> : null}
      {state.kind === "error" ? <div className="app-alert app-alert--warn" role="alert">QC sampling is unavailable right now. Review workflows are unaffected.</div> : null}
      {state.kind === "ready" && !state.catalogAvailable ? (
        <div className="app-alert">The AI run catalog is not provisioned in this environment yet.</div>
      ) : null}
      {state.kind === "ready" && state.catalogAvailable && state.samples.length === 0 ? (
        <div className="app-alert">No Copilot runs match this sampling strategy yet.</div>
      ) : null}

      {state.kind === "ready" && state.samples.length > 0 ? (
        <>
          <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {state.samples.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => {
              const chip = qcChip(s);
              return (
                <li key={s.id} style={{ borderTop: "1px solid var(--app-border,#eee)", padding: "8px 0" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{FEATURE_LABEL[s.feature] ?? s.feature}</strong>
                    <span className="app-chip">{s.status}</span>
                    <span className={`app-chip ${chip.cls}`}>{chip.label}</span>
                    <span style={{ fontSize: 12, opacity: 0.6 }}>{formatUserDateTime(s.generatedAt)}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    {s.interactionCount} human interaction(s) · {s.editedCount} edited · {s.rejectedCount} rejected
                    {s.criteriaVersion ? <> · criteria {s.criteriaVersion}</> : null}
                    {s.reviewId ? <> · <Link className="app-link" href={`/reviewer-ops/${s.reviewId}`}>Open review</Link></> : null}
                    {s.caseId ? <> · <Link className="app-link" href={`/cases/${s.caseId}`}>Open case</Link></> : null}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button className="app-btn app-btn--primary" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_ACCEPTED")}>Accept</button>
                    <button className="app-btn app-btn--ghost" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_REVIEWED")}>Mark reviewed</button>
                    <button className="app-btn app-btn--ghost" disabled={busyId === s.id} onClick={() => void decide(s.id, "QC_SKIPPED")}>Skip</button>
                  </div>
                </li>
              );
            })}
          </ul>
          {state.samples.length > PAGE_SIZE ? (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <button className="app-btn app-btn--ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span style={{ fontSize: 12, opacity: 0.6 }}>Page {page + 1} of {Math.ceil(state.samples.length / PAGE_SIZE)}</span>
              <button className="app-btn app-btn--ghost" disabled={(page + 1) * PAGE_SIZE >= state.samples.length} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          ) : null}
        </>
      ) : null}
      <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8 }}>
        Every decision is recorded with your identity in the audit log.
      </p>
    </section>
  );
}
