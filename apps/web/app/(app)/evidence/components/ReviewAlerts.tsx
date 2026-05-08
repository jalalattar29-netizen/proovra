import type { ReviewAlert } from "../lib/evidence-library-types";

export function ReviewAlerts({
  alerts,
  nextActions,
}: {
  alerts: ReviewAlert[];
  nextActions: string[];
}) {
  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Review alerts and reviewer actions</strong>
          <p>Operational guidance is separated from technical integrity concerns.</p>
        </div>
      </div>

      <div className="evidence-library-alert-grid">
        {alerts.length > 0 ? (
          alerts.map((alert) => (
            <div
              key={`${alert.label}-${alert.detail}`}
              className={`evidence-library-alert evidence-library-alert--${alert.severity}`}
            >
              <strong>{alert.label}</strong>
              <p>{alert.detail}</p>
            </div>
          ))
        ) : (
          <div className="evidence-library-alert evidence-library-alert--stable">
            <strong>No flagged reviewer alerts</strong>
            <p>No critical or operational issues are currently surfaced in this view.</p>
          </div>
        )}
      </div>

      <div className="evidence-library-next-actions">
        <strong>Suggested next actions</strong>
        {nextActions.length > 0 ? (
          <ul>
            {nextActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        ) : (
          <p>No explicit reviewer next actions are recorded for this selection.</p>
        )}
      </div>
    </section>
  );
}
