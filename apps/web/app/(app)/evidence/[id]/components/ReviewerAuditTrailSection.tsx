"use client";

type ReviewerAuditItem = {
  id: string;
  eventType: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: {
    id: string;
    email: string | null;
    displayName: string | null;
  } | null;
};

export function ReviewerAuditTrailSection({
  items,
  formatDateTime,
}: {
  items: ReviewerAuditItem[];
  formatDateTime: (value: string | null | undefined) => string;
}) {
  return (
    <section id="access" className="evidence-detail-card">
      <div className="evidence-detail-card-header">
        <div>
          <p className="evidence-detail-kicker">Reviewer Audit Trail</p>
          <h2>Workspace review activity</h2>
        </div>
      </div>

      <p className="evidence-detail-muted">
        Reviewer audit is separate from forensic custody and records workspace review actions only.
      </p>

      {items.length === 0 ? (
        <p className="evidence-detail-muted">No reviewer audit activity recorded yet.</p>
      ) : (
        <div className="evidence-detail-timeline evidence-detail-timeline--compact">
          {items.map((item) => (
            <article key={item.id} className="evidence-detail-timeline-item">
              <div className="evidence-detail-timeline-dot" aria-hidden="true" />
              <div>
                <div className="evidence-detail-item-row">
                  <strong>{item.eventType.replace(/_/g, " ")}</strong>
                  <span>{formatDateTime(item.createdAt)}</span>
                </div>
                <p>
                  {item.actor?.displayName || item.actor?.email || "Workspace user"}
                  {item.metadata && Object.keys(item.metadata).length > 0 ? " • metadata recorded" : ""}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
