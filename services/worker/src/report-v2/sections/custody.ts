import { ReportViewModel, TimelineRow } from "../types.js";
import { escapeHtml } from "../formatters.js";
import {
  renderAccessActivityList,
  renderCallout,
  renderPageSection,
} from "../ui.js";

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

function renderAccessSection(vm: ReportViewModel): string {
  if (vm.accessRows.length === 0) return "";

  return renderPageSection(
    "Access Activity Log",
    `
      <div class="custody-page custody-access-page">
        ${renderCallout({
          title: "Access activity is separate from forensic custody",
          body:
            "Viewing, download, and verification events are listed separately so routine access history does not get confused with integrity-relevant custody events. Access activity uses original event sequence numbers in a reduced style.",
          tone: "neutral",
        })}

        <div class="custody-access-note">
          Access events are reviewer-visible audit records, but they are not forensic custody milestones. Original sequence numbers are preserved for traceability.
        </div>

        ${renderAccessActivityList(vm.accessRows)}
      </div>
    `,
    { pageBreakBefore: true, className: "custody-access-section" }
  );
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

  const custodySection = renderPageSection(
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
      </div>
    `,
    { pageBreakBefore: true, className: "custody-section" }
  );

  return custodySection + renderAccessSection(vm);
}