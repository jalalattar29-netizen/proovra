import { ReportViewModel, TimelineRow } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

function renderCustodyStats(vm: ReportViewModel): string {
  return `
    <div class="custody-stats-grid">
      <div class="custody-stat-card">
        <div class="custody-stat-label">Forensic Events</div>
        <div class="custody-stat-value">${vm.forensicRows.length}</div>
      </div>
      <div class="custody-stat-card">
        <div class="custody-stat-label">Access Events</div>
        <div class="custody-stat-value">${vm.accessRows.length}</div>
      </div>
      <div class="custody-stat-card">
        <div class="custody-stat-label">Hash Chain</div>
        <div class="custody-stat-value">${
          vm.custodyHashRows.length > 0 ? "Recorded" : "Not reported"
        }</div>
      </div>
    </div>
  `;
}

function renderLifecycleSummary(): string {
  return `
    <div class="custody-lifecycle-summary">
      <div class="custody-lifecycle-label">Lifecycle summary</div>
      <div class="custody-lifecycle-flow">
        <span>Created</span>
        <span>Identity recorded</span>
        <span>Upload completed</span>
        <span>Signed</span>
        <span>Timestamped</span>
        <span>Locked</span>
        <span>Report generated</span>
        <span>Anchoring completed</span>
      </div>
    </div>
  `;
}

function isOtsPendingRow(row: TimelineRow): boolean {
  const text = `${row.eventLabel} ${row.summary}`.toLowerCase();
  return (
    (text.includes("opentimestamp") || text.includes("ots")) &&
    text.includes("pending")
  );
}

function hasAnchoringCompletion(rows: TimelineRow[]): boolean {
  return rows.some((row) => {
    const text = `${row.eventLabel} ${row.summary}`.toLowerCase();
    return (
      (text.includes("opentimestamp") || text.includes("ots")) &&
      (text.includes("anchored") || text.includes("completed"))
    );
  });
}

function renderForensicTimeline(rows: TimelineRow[]): string {
  if (rows.length === 0) return "";

  const anchoringCompletesLater = hasAnchoringCompletion(rows);
  let pendingNoteRendered = false;

  return `
    <div class="timeline-list custody-forensic-timeline">
      ${rows
        .map((row) => {
          const shouldShowPendingNote =
            !pendingNoteRendered &&
            anchoringCompletesLater &&
            isOtsPendingRow(row);

          if (shouldShowPendingNote) pendingNoteRendered = true;

          return `
            <article class="timeline-card custody-forensic-event">
              <div class="timeline-seq">${escapeHtml(row.sequence)}</div>
              <div class="timeline-content">
                <div class="timeline-top">
                  <div class="timeline-event">${escapeHtml(row.eventLabel)}</div>
                  <div class="timeline-time">${escapeHtml(row.atUtc)}</div>
                </div>
                <div class="timeline-summary">${escapeHtml(row.summary)}</div>
                ${
                  shouldShowPendingNote
                    ? `
                      <div class="custody-inline-note">
                        Later OpenTimestamps events show anchoring completion.
                      </div>
                    `
                    : ""
                }
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAccessTimeline(rows: TimelineRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="custody-access-note">
      Access activity uses original event sequence numbers, shown in a reduced style because these events are not forensic custody milestones.
    </div>

    <div class="custody-access-list">
      ${rows
        .map(
          (row) => `
            <article class="custody-access-event">
              <div class="custody-access-marker">Access event</div>
              <div class="custody-access-content">
                <div class="custody-access-top">
                  <div class="custody-access-title">${escapeHtml(row.eventLabel)}</div>
                  <div class="custody-access-time">${escapeHtml(row.atUtc)}</div>
                </div>
                <div class="custody-access-summary">${escapeHtml(row.summary)}</div>
                <div class="custody-access-sequence">Original sequence: ${escapeHtml(
                  row.sequence
                )}</div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderCustodySection(vm: ReportViewModel): string {
  const forensicBlock =
    vm.forensicRows.length === 0
      ? renderCallout({
          title: "No forensic custody events returned",
          body:
            "This report did not receive internal forensic custody-event entries for this evidence record. That means no system-recorded forensic chain was available in this output; it should not be treated as proof that no handling occurred outside the recorded workflow.",
          tone: "warning",
        })
      : renderForensicTimeline(vm.forensicRows);

  const accessBlock =
    vm.accessRows.length === 0
      ? ""
      : `
        <div class="custody-access-section">
          ${renderCallout({
            title: "Access activity is separate from forensic custody",
            body:
              "Viewing, download, and verification events are listed separately so routine access history does not get confused with integrity-relevant custody events.",
            tone: "neutral",
          })}
          ${renderAccessTimeline(vm.accessRows)}
        </div>
      `;

  return renderPageSection(
    "Chain of Custody",
    `
      <div class="custody-page">
        ${renderCallout({
          title: "Recorded Forensic Lifecycle",
          body:
            "The events below show the system-recorded custody path of the evidence package. Access activity is separated so routine viewing or downloads are not confused with integrity-relevant custody events.",
          tone: "neutral",
        })}

        ${renderCustodyStats(vm)}

        ${renderLifecycleSummary()}

        <div class="custody-timeline-panel">
          ${forensicBlock}
        </div>

        ${accessBlock}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-section" }
  );
}