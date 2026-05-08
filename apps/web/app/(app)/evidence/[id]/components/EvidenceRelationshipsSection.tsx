"use client";

import { Button } from "../../../../../components/ui";

type RelationshipItem = {
  id: string;
  relationshipType: string;
  note: string | null;
  direction: "outbound" | "inbound";
  linkedEvidence: {
    id: string;
    title: string;
    status: string;
  };
};

export function EvidenceRelationshipsSection({
  caseName,
  relatedEvidenceCount,
  multipart,
  itemCount,
  note,
  items,
  actionBusy,
  onAssignCase,
  onRemoveCase,
  onOpenRelationshipEditor,
  onOpenLinkedEvidence,
}: {
  caseName: string | null;
  relatedEvidenceCount: number | null;
  multipart: boolean;
  itemCount: number;
  note: string | null;
  items: RelationshipItem[];
  actionBusy: boolean;
  onAssignCase: () => void;
  onRemoveCase: (() => void) | null;
  onOpenRelationshipEditor: () => void;
  onOpenLinkedEvidence: (id: string) => void;
}) {
  return (
    <section id="relationships" className="evidence-detail-card">
      <div className="evidence-detail-card-header">
        <div>
          <p className="evidence-detail-kicker">Case &amp; Relationships</p>
          <h2>Operational linkage</h2>
        </div>
        <div className="evidence-detail-inline-actions">
          <Button variant="secondary" onClick={onAssignCase}>
            {caseName ? "Reassign case" : "Assign case"}
          </Button>
          {onRemoveCase ? (
            <Button variant="secondary" onClick={onRemoveCase} disabled={actionBusy}>
              Remove case
            </Button>
          ) : null}
          <Button onClick={onOpenRelationshipEditor} disabled={actionBusy}>
            Manage relationships
          </Button>
        </div>
      </div>

      <div className="evidence-detail-data-grid">
        <div className="evidence-detail-data-cell">
          <span>Case assignment</span>
          <strong>{caseName || "Unassigned"}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Related evidence in case</span>
          <strong>{relatedEvidenceCount != null ? String(relatedEvidenceCount) : "Not available"}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Structure</span>
          <strong>{multipart ? "Multipart package" : "Single record"}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Item count</span>
          <strong>{String(itemCount)}</strong>
        </div>
      </div>

      {note ? <p className="evidence-detail-muted">{note}</p> : null}

      <div className="evidence-detail-subsection">
        <div className="evidence-detail-subsection__header">
          <strong>Linked evidence relationships</strong>
          <span>{items.length} recorded</span>
        </div>
        {items.length === 0 ? (
          <p className="evidence-detail-muted">No linked evidence relationships recorded.</p>
        ) : (
          <div className="evidence-detail-related-list">
            {items.map((item) => (
              <article key={item.id} className="evidence-detail-related-card">
                <div className="evidence-detail-item-row">
                  <strong>{item.linkedEvidence.title}</strong>
                  <span className="evidence-detail-pill neutral">
                    {item.relationshipType.replace(/_/g, " ")}
                  </span>
                </div>
                <p>
                  {item.direction === "outbound" ? "Links from this record" : "Links to this record"} •{" "}
                  {item.linkedEvidence.status.replace(/_/g, " ")}
                </p>
                {item.note ? <p>{item.note}</p> : null}
                <div className="evidence-detail-inline-actions">
                  <Button variant="secondary" onClick={() => onOpenLinkedEvidence(item.linkedEvidence.id)}>
                    Open linked evidence
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
