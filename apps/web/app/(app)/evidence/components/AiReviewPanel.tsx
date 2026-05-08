import type { DetailWorkspaceState } from "../lib/evidence-library-types";

export function AiReviewPanel({ detail }: { detail: DetailWorkspaceState }) {
  const reviewerDecision = detail.evidence?.evidenceIntelligence?.reviewerDecision ?? null;

  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>AI and comparison workspace</strong>
          <p>No new AI endpoints or duplicate-analysis services are called from this page.</p>
        </div>
      </div>

      {reviewerDecision ? (
        <div className="evidence-library-note-card">
          <strong>{reviewerDecision.label}</strong>
          <p>{reviewerDecision.summary}</p>
        </div>
      ) : (
        <div className="evidence-library-note-card is-disabled">
          <strong>AI review assistant</strong>
          <p>AI review assistant is not enabled for this evidence library view.</p>
        </div>
      )}

      <div className="evidence-library-note-grid">
        <div className="evidence-library-note-card is-disabled">
          <strong>Duplicate detection</strong>
          <p>Duplicate analysis is not configured for this workspace.</p>
        </div>
        <div className="evidence-library-note-card is-disabled">
          <strong>Evidence comparison</strong>
          <p>Original/export comparison requires opening the full evidence record.</p>
        </div>
      </div>
    </section>
  );
}
