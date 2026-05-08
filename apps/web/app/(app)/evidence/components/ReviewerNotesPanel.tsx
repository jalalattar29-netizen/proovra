import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { safeText } from "../lib/evidence-library-formatters";
import { ReviewerCommentsPanel } from "./ReviewerCommentsPanel";
import { LegalNotesPanel } from "./LegalNotesPanel";
import { AnnotationPanel } from "./AnnotationPanel";

export function ReviewerNotesPanel({
  item,
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  const evidenceId = detail.evidence?.id ?? item.id;
  const defaultPartId = detail.parts.find((part) => part.isPrimary)?.id ?? detail.parts[0]?.id ?? null;

  return (
    <>
      <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Reviewer notes and overlays</strong>
          <p>
            Operational notes, legal notes, and annotations stay separate from cryptographic integrity,
            custody chronology, and public verification materials.
          </p>
        </div>
      </div>

      <div className="evidence-library-note-grid">
        <div className="evidence-library-note-card">
          <strong>Internal notes</strong>
          <p>{safeText(detail.evidence?.internalNotes, "No internal notes are recorded.")}</p>
        </div>
        <div className="evidence-library-note-card">
          <strong>Review boundary</strong>
          <p>
            Reviewer notes and overlays support operational review. They do not modify preserved evidence or
            determine legal outcome, authorship, identity, or evidentiary weight.
          </p>
        </div>
      </div>
      </section>

      <ReviewerCommentsPanel evidenceId={evidenceId} />
      <LegalNotesPanel evidenceId={evidenceId} />
      <AnnotationPanel evidenceId={evidenceId} defaultPartId={defaultPartId} />
    </>
  );
}
