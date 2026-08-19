"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { ChevronDown, Sparkles } from "lucide-react";
import { useId, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import type {
  EvidenceAiCategorization,
  EvidenceAiCategorizationResponse,
} from "../lib/evidence-library-types";

export function AiCategorizationPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
          setError(toSafeUserError(loadError, { message: "AI categorization unavailable" }).message);
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
      setError(toSafeUserError(runError, { message: "AI categorization failed" }).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="evidence-detail-tool" data-evidence-tool="ai-categorization">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary
          className="evidence-detail-tool__summary"
          aria-expanded={open}
          aria-controls={panelId}
        >
          <Sparkles
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="evidence-detail-tool__icon"
          />
          <span className="evidence-detail-tool__title">AI categorization</span>
          <ChevronDown
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="evidence-detail-tool__chevron"
          />
        </summary>
        <div
          id={panelId}
          role="region"
          aria-label="AI categorization"
          className="evidence-detail-tool__panel"
        >
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
          <div className="evidence-detail-tool__actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void runCategorization()}
              disabled={running}
            >
              {running ? "Running..." : "Run metadata-only AI categorization"}
            </button>
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
              className="evidence-detail-tool__actions"
              data-ai-categorization-rerun
            >
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => void runCategorization()}
                disabled={running}
                data-ai-categorization-rerun-button
              >
                {running ? "Refreshing…" : "Re-run AI advisory review"}
              </button>
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
        </div>
      </details>
    </section>
  );
}
