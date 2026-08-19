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
    <section
      id="access"
      className="evidence-detail-review-section"
      data-evidence-section="reviewer-audit"
    >
      <div className="evidence-detail-review-head">
        <h2 className="evidence-detail-review-head__title">
          Workspace review activity
        </h2>
        {items.length > 0 ? (
          <span className="evidence-detail-review-head__count">
            {items.length} recorded
          </span>
        ) : null}
      </div>

      {/* Upright, not italic: this is an operational boundary statement, and
          it is deliberately NOT the Custody timeline. Reviewer audit records
          workspace review actions only. */}
      <p className="evidence-detail-review-note">
        Reviewer audit is separate from forensic custody and records workspace
        review actions only.
      </p>

      {items.length === 0 ? (
        <p className="evidence-detail-review-note" data-evidence-audit-empty>
          No reviewer audit activity recorded yet.
        </p>
      ) : (
        <ul className="evidence-detail-audit-list">
          {items.map((item) => (
            <li key={item.id} className="evidence-detail-audit-row">
              <span className="evidence-detail-audit-row__marker" aria-hidden="true" />
              <span className="evidence-detail-audit-row__label">
                {item.eventType.replace(/_/g, " ")}
                <span className="evidence-detail-audit-row__actor">
                  {item.actor?.displayName || item.actor?.email || "Workspace user"}
                  {item.metadata && Object.keys(item.metadata).length > 0
                    ? " • metadata recorded"
                    : ""}
                </span>
              </span>
              <span className="evidence-detail-audit-row__time">
                {formatDateTime(item.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
