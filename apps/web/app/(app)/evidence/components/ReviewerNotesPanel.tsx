import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { safeText } from "../lib/evidence-library-formatters";

export function ReviewerNotesPanel({
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Reviewer notes</strong>
          <p>Operational notes are separated from unsupported annotations or legal commentary features.</p>
        </div>
      </div>

      <div className="evidence-library-note-grid">
        <div className="evidence-library-note-card">
          <strong>Internal notes</strong>
          <p>{safeText(detail.evidence?.internalNotes, "No internal notes are recorded.")}</p>
        </div>
        <div className="evidence-library-note-card is-disabled">
          <strong>Reviewer comments</strong>
          <p>Reviewer comments — not configured in this library view</p>
        </div>
        <div className="evidence-library-note-card is-disabled">
          <strong>Annotations</strong>
          <p>Annotations — not configured in this library view</p>
        </div>
        <div className="evidence-library-note-card is-disabled">
          <strong>Legal notes</strong>
          <p>Legal notes — not configured in this library view</p>
        </div>
      </div>
    </section>
  );
}
