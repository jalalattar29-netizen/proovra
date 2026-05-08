import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { formatUtcDateTime } from "../lib/evidence-library-formatters";

export function CustodyPanel({
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  const intelligence = detail.evidence?.evidenceIntelligence ?? null;
  const custodyEvents = intelligence?.custodyTimeline ?? [];
  const accessEvents = intelligence?.accessActivity.recentEvents ?? [];

  return (
    <>
      <section className="evidence-library-panel">
        <div className="evidence-library-panel__header">
          <div>
            <strong>Custody chronology</strong>
            <p>Forensic custody events are shown separately from access activity.</p>
          </div>
        </div>

        <div className="evidence-library-timeline-panel">
          <div className="evidence-library-key-card">
            <span>Forensic custody count</span>
            <strong>{intelligence?.events.forensic ?? "Not available"}</strong>
            <p>
              {intelligence?.events.chainIntegrity.valid
                ? "Chain integrity is recorded as valid."
                : intelligence?.events.chainIntegrity.reason ?? "Detailed custody chronology is available in the full evidence record."}
            </p>
          </div>

          {custodyEvents.length > 0 ? (
            <ul className="evidence-library-timeline">
              {custodyEvents.slice(0, 6).map((event) => (
                <li key={`${event.eventType}-${event.timestampUtc}`}>
                  <strong>{event.label}</strong>
                  <span>{formatUtcDateTime(event.timestampUtc)}</span>
                  <p>{event.description}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="evidence-library-muted">
              Detailed custody chronology is available in the full evidence record.
            </p>
          )}
        </div>
      </section>

      <section className="evidence-library-panel">
        <div className="evidence-library-panel__header">
          <div>
            <strong>Access activity</strong>
            <p>Views, downloads, and public verification opens are treated as access activity, not forensic custody.</p>
          </div>
        </div>

        <div className="evidence-library-timeline-panel">
          <div className="evidence-library-key-card">
            <span>Access activity count</span>
            <strong>{intelligence?.events.access ?? "Not available"}</strong>
            <p>
              Latest view {formatUtcDateTime(intelligence?.accessActivity.lastViewedAtUtc ?? null)}
            </p>
          </div>

          {accessEvents.length > 0 ? (
            <ul className="evidence-library-timeline">
              {accessEvents.slice(0, 6).map((event) => (
                <li key={`${event.eventType}-${event.timestampUtc}`}>
                  <strong>{event.label}</strong>
                  <span>{formatUtcDateTime(event.timestampUtc)}</span>
                  <p>{event.description}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="evidence-library-muted">
              No recent access activity is recorded in this library view.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
