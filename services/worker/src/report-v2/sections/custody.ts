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
        <div class="custody-stat-label">Hash Chain</div>
        <div class="custody-stat-value">${
          vm.custodyHashRows.length > 0 ? "Recorded" : "Not reported"
        }</div>
      </div>
      <div class="custody-stat-card">
        <div class="custody-stat-label">Access Activity</div>
        <div class="custody-stat-value">Verify page</div>
      </div>
    </div>
  `;
}

function renderLifecycleSummary(vm: ReportViewModel): string {
  const anchoringStatus = vm.storageRows.find(
    (row) => row.label === "Public Anchoring Status"
  )?.value;

const normalizedAnchoringStatus = String(anchoringStatus ?? "").toLowerCase();

const anchoringStep =
  normalizedAnchoringStatus.includes("pending")
    ? "Anchoring pending"
    : normalizedAnchoringStatus.includes("not recorded") ||
        normalizedAnchoringStatus.includes("not reported")
      ? "Anchoring not recorded"
      : normalizedAnchoringStatus.includes("recorded") ||
          normalizedAnchoringStatus.includes("anchored") ||
          normalizedAnchoringStatus.includes("published") ||
          normalizedAnchoringStatus.includes("verified")
        ? "Anchoring recorded"
        : "Anchoring not recorded";

  return `
    <div class="custody-lifecycle-summary">
      <div class="custody-lifecycle-label">Lifecycle summary</div>
      <div class="custody-lifecycle-flow">
        <span>Created</span>
        <span>Identity recorded</span>
        <span>Upload completed</span>
        <span>Signed</span>
<span>${
  vm.storageRows
    .find((row) => row.label === "RFC 3161 Status")
    ?.value.toLowerCase()
    .includes("failed")
    ? "Timestamp unavailable"
    : "Timestamped"
}</span>
        <span>Locked</span>
        <span>Report generated</span>
        <span>${escapeHtml(anchoringStep)}</span>
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
  .map((row, index) => {
    const displaySequence = String(index + 1);

    const shouldShowPendingNote =
      !pendingNoteRendered &&
      anchoringCompletesLater &&
      isOtsPendingRow(row);

    if (shouldShowPendingNote) pendingNoteRendered = true;

    return `
      <article class="timeline-card custody-forensic-event">
        <div class="timeline-seq">${escapeHtml(displaySequence)}</div>
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

  return renderPageSection(
    "Chain of Custody",
    `
      <div class="custody-page">
        ${renderCallout({
          title: "Recorded Forensic Lifecycle",
          body:
            "The events below show the system-recorded custody path of the evidence package. Routine viewing, download, and verification access activity is intentionally kept out of this PDF and should be reviewed through the verification page or internal audit trail when needed.",
          tone: "neutral",
        })}

        ${renderCustodyStats(vm)}

        ${renderLifecycleSummary(vm)}

        <div class="custody-timeline-panel">
          ${forensicBlock}
        </div>
      </div>
    `,
    { pageBreakBefore: true, className: "custody-section" }
  );
}