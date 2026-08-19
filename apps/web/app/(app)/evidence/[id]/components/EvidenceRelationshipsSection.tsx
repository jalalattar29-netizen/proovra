"use client";

import { Unlink } from "lucide-react";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";

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
  canManageRelationships = true,
  onAssignCase,
  onRemoveCase,
  onOpenRelationshipEditor,
  onOpenLinkedEvidence,
  // Phase 2.1 — surfaces `DELETE /v1/evidence/:id/relationships/:relId`
  // which already existed in the backend but had no UI affordance.
  // Optional so parents that don't yet wire it continue to render
  // without the Remove button.
  onRemoveRelationship,
}: {
  caseName: string | null;
  relatedEvidenceCount: number | null;
  multipart: boolean;
  itemCount: number;
  note: string | null;
  items: RelationshipItem[];
  actionBusy: boolean;
  /**
   * Phase EVIDENCE-RELATIONSHIPS-GATE — when false (Personal /
   * non-investigation workspaces), the Manage button + per-row
   * Remove buttons are hidden. Items still render as read-only
   * when present. Defaults to `true` for back-compat with any
   * caller that hasn't yet passed it.
   */
  canManageRelationships?: boolean;
  onAssignCase: () => void;
  onRemoveCase: (() => void) | null;
  onOpenRelationshipEditor: () => void;
  onOpenLinkedEvidence: (id: string) => void;
  onRemoveRelationship?: (relationshipId: string) => void | Promise<void>;
}) {
  const { confirm } = useConfirmAction();
  return (
    <section
      id="relationships"
      className="evidence-detail-review-section"
      data-evidence-section="case-relationships"
    >
      {/* Case actions stay permission-gated exactly as before: Remove case is
          rendered only when the parent supplies a handler (i.e. a case is
          attached), Manage relationships only where the workspace can manage
          them, and both disable while a mutation is in flight. */}
      <div className="evidence-detail-review-head">
        <h2 className="evidence-detail-review-head__title">Case &amp; relationships</h2>
        <div className="evidence-detail-review-head__actions">
          <button
            type="button"
            className="app-ghost-action"
            onClick={onAssignCase}
            data-evidence-action="assign-case"
          >
            {caseName ? "Reassign case" : "Assign case"}
          </button>
          {onRemoveCase ? (
            <button
              type="button"
              className="app-ghost-action evidence-detail-destructive-action"
              onClick={onRemoveCase}
              disabled={actionBusy}
              data-evidence-action="remove-case"
            >
              Remove case
            </button>
          ) : null}
          {canManageRelationships ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={onOpenRelationshipEditor}
              disabled={actionBusy}
              data-evidence-action="manage-relationships"
            >
              Manage relationships
            </button>
          ) : null}
        </div>
      </div>

      {/* Tracks come from the container, so a long case name wraps inside its
          own card and can never widen the grid or push a neighbour. */}
      <div className="evidence-detail-facts-grid" data-evidence-facts-grid>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Case assignment</span>
          <span className="evidence-detail-fact__value evidence-detail-fact__value--clamp">
            {caseName || "Unassigned"}
          </span>
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Related evidence</span>
          <span className="evidence-detail-fact__value">
            {relatedEvidenceCount != null
              ? `${relatedEvidenceCount} item${relatedEvidenceCount === 1 ? "" : "s"}`
              : "Not available"}
          </span>
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Structure</span>
          <span className="evidence-detail-fact__value">
            {multipart ? "Multipart package" : "Single record"}
          </span>
        </div>
        <div className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">Item count</span>
          <span className="evidence-detail-fact__value">{String(itemCount)}</span>
        </div>
      </div>

      {note ? <p className="evidence-detail-review-note">{note}</p> : null}

      <div className="evidence-detail-linked">
        <div className="evidence-detail-review-head evidence-detail-review-head--sub">
          <h3 className="evidence-detail-review-head__title">
            Linked evidence relationships
          </h3>
          <span className="evidence-detail-review-head__count">
            {items.length} recorded
          </span>
        </div>
        {items.length === 0 ? (
          // Canonical dashed empty state. It reports the absence; it never
          // invents a relationship that the response does not carry.
          <div className="evidence-detail-empty" data-evidence-linked-empty>
            <Unlink size={26} strokeWidth={1.75} aria-hidden="true" />
            <p>No linked evidence relationships recorded.</p>
          </div>
        ) : (
          <div className="evidence-detail-linked-list">
            {items.map((item) => (
              <article key={item.id} className="evidence-detail-linked-card">
                <div className="evidence-detail-linked-card__head">
                  <h4 className="evidence-detail-linked-card__title">
                    {item.linkedEvidence.title}
                  </h4>
                  <span className="app-chip">
                    {item.relationshipType.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="evidence-detail-linked-card__meta">
                  {item.direction === "outbound"
                    ? "Links from this record"
                    : "Links to this record"}{" "}
                  •{" "}
                  {item.linkedEvidence.status.replace(/_/g, " ")}
                </p>
                {item.note ? (
                  <p className="evidence-detail-linked-card__meta">{item.note}</p>
                ) : null}
                <div className="evidence-detail-linked-card__actions">
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() => onOpenLinkedEvidence(item.linkedEvidence.id)}
                    aria-label={`Open linked evidence: ${item.linkedEvidence.title}`}
                  >
                    Open linked evidence
                  </button>
                  {onRemoveRelationship && canManageRelationships ? (
                    <button
                      type="button"
                      className="app-ghost-action evidence-detail-destructive-action"
                      disabled={actionBusy}
                      data-evidence-relationship-remove={item.id}
                      onClick={() => {
                        // D-3 closure — destructive relationship removal
                        // routed through ConfirmActionModal. The DELETE
                        // endpoint is audited server-side
                        // (RELATIONSHIP_DELETED reviewer-audit event).
                        void (async () => {
                          const ok = await confirm({
                            title: "Remove this relationship?",
                            description: `Remove the "${item.relationshipType.replace(/_/g, " ").toLowerCase()}" relationship with "${item.linkedEvidence.title}"? The linked evidence record itself is not affected.`,
                            confirmLabel: "Remove relationship",
                            tone: "warning",
                            testId: "evidence-relationship-remove",
                          });
                          if (ok) await onRemoveRelationship(item.id);
                        })();
                      }}
                    >
                      Remove relationship
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
