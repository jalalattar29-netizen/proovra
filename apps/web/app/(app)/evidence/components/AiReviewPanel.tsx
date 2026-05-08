import type { DetailWorkspaceState } from "../lib/evidence-library-types";
import { ComparisonPanel } from "./ComparisonPanel";
import { DuplicateDetectionPanel } from "./DuplicateDetectionPanel";
import { AiCategorizationPanel } from "./AiCategorizationPanel";

export function AiReviewPanel({ detail }: { detail: DetailWorkspaceState }) {
  if (!detail.evidence?.id) {
    return null;
  }

  return (
    <>
      <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Advanced review tools</strong>
          <p>
            Comparison, duplicate detection, and AI categorization are loaded only when opened so the review
            workspace stays fast for high-volume evidence operations.
          </p>
        </div>
      </div>
      </section>

      <ComparisonPanel evidenceId={detail.evidence.id} />
      <DuplicateDetectionPanel evidenceId={detail.evidence.id} />
      <AiCategorizationPanel evidenceId={detail.evidence.id} />
    </>
  );
}
