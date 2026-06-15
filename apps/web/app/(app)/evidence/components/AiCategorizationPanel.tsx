"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import type {
  EvidenceAiCategorization,
  EvidenceAiCategorizationResponse,
} from "../lib/evidence-library-types";

export function AiCategorizationPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EvidenceAiCategorization | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = (await apiFetch(
          `/v1/evidence/${evidenceId}/ai-categorization`
        )) as EvidenceAiCategorizationResponse;
        if (!cancelled) {
          setData(response.categorization ?? null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "AI categorization unavailable");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [evidenceId, open]);

  const runCategorization = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = (await apiFetch(`/v1/evidence/${evidenceId}/ai-categorization/run`, {
        method: "POST",
      })) as EvidenceAiCategorizationResponse;
      setData(response.categorization ?? null);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "AI categorization failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">AI categorization</summary>
        <p className="evidence-library-muted">
          AI categorization is advisory and metadata-only. It does not determine factual truth, authorship,
          integrity, or legal outcome.
        </p>

        {loading ? <p className="evidence-library-muted">Loading AI categorization...</p> : null}
        {error ? <p className="evidence-library-muted">{error}</p> : null}

        {!loading && data?.status === "DISABLED" ? (
          // Phase EVIDENCE-LIBRARY-AI-DEDUPE (FIX 5) — the canonical
          // AI advisory sits at the top of this `<details>` block;
          // we used to repeat the backend-stamped `data.legalDisclaimer`
          // here too, which made the user read the same caveat twice.
          // The single inline disclaimer carries the legal floor.
          <div className="evidence-library-disabled-placeholder">
            <strong>AI categorization is not active for this record.</strong>
          </div>
        ) : null}

        {!loading && (!data || data.status === "FAILED") ? (
          <div className="evidence-library-panel__actions">
            <Button onClick={() => void runCategorization()} disabled={running}>
              {running ? "Running..." : "Run metadata-only AI categorization"}
            </Button>
          </div>
        ) : null}

        {data && data.status === "COMPLETED" ? (
          <>
            {/* Phase 2.1 — Re-run affordance. The Run button below is
                conditional on null/FAILED; once a COMPLETED record
                exists there was previously no way to ask AI for a
                fresh advisory pass (e.g. after adding evidence parts,
                changing case linkage, or simply wanting an updated
                summary). The backend cost guard
                (`evidenceAiCostGuard.canCategorizeEvidence`) still
                enforces per-user / per-evidence limits; the UI
                surfaces 429 messages from that guard on retry. */}
            <div
              className="evidence-library-panel__actions"
              data-ai-categorization-rerun
            >
              <Button
                variant="secondary"
                onClick={() => void runCategorization()}
                disabled={running}
                data-ai-categorization-rerun-button
              >
                {running ? "Refreshing…" : "Re-run AI advisory review"}
              </Button>
            </div>
          <div className="evidence-library-note-grid">
            <div className="evidence-library-note-card">
              <strong>Summary</strong>
              <p>{data.summary ?? "No summary recorded."}</p>
            </div>
            <div className="evidence-library-note-card">
              <strong>Suggested categories</strong>
              <p>{data.categories.length ? data.categories.join(", ") : "No categories recorded."}</p>
            </div>
            <div className="evidence-library-note-card">
              <strong>Suggested tags</strong>
              <p>{data.suggestedTags.length ? data.suggestedTags.join(", ") : "No suggested tags recorded."}</p>
            </div>
            <div className="evidence-library-note-card">
              <strong>Risk flags</strong>
              {data.riskFlags.length ? (
                <div className="evidence-library-result-list">
                  {data.riskFlags.map((flag) => (
                    <div key={`${flag.severity}-${flag.title}`} className="evidence-library-result-row">
                      <strong>{flag.title}</strong>
                      <span>{flag.detail}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No AI risk flags recorded.</p>
              )}
            </div>
            <div className="evidence-library-note-card">
              <strong>Model and timing</strong>
              <p>
                {data.model ?? "Model not recorded"} • {data.updatedAt ?? "No update timestamp"}
              </p>
            </div>
            {/* Phase EVIDENCE-LIBRARY-AI-DEDUPE (FIX 5) — the
                "Legal boundary" card here duplicated the canonical
                inline disclaimer at the top of this panel. Removed
                to stop the user reading the same caveat twice; the
                legal protection is unchanged. */}
          </div>
          </>
        ) : null}
      </details>
    </section>
  );
}
