import { ReportViewModel, TimelineRow } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

/** The custody introduction, in full. */
export const CUSTODY_INTRO =
  "This PDF shows a curated forensic subset in chain order. The verification package contains the complete custody chain, hashes and access records.";

/**
 * Items rendered so that neither end of a list is stranded alone on a page:
 * the first two and the last two travel together (break-inside: avoid).
 */
export function keepEndsTogether(items: string[], className: string): string {
  if (items.length < 4) return `<div class="${className} report-keep-together">${items.join("")}</div>`;
  const head = items.slice(0, 2).join("");
  const body = items.slice(2, -2).join("");
  const tail = items.slice(-2).join("");
  return `<div class="${className} report-keep-together">${head}</div>${body}<div class="${className} report-keep-together">${tail}</div>`;
}

function renderLifecycleSummary(vm: ReportViewModel): string {
  const anchoringStatus = vm.storageRows.find(
    (row) => row.label === "Bitcoin Anchoring Status"
  )?.value;

  const timestampStatus = vm.storageRows.find(
    (row) => row.label === "RFC 3161 Status"
  )?.value;

  // The canonical Bitcoin anchoring label ("Bitcoin anchored", "Bitcoin
  // anchoring pending", …), the same state the trust card shows.
  const anchoringStep = String(anchoringStatus ?? "Bitcoin anchoring unavailable");

  return `
    <div class="custody-lifecycle-summary">
      <div class="custody-lifecycle-label">Lifecycle summary</div>
      <div class="custody-lifecycle-flow">
        <span>Created</span>
        <span>Identity recorded</span>
        <span>Upload completed</span>
        <span>Signed</span>
        <span>${
          // "Timestamped" only for a VALIDATED token (the presented status).
          String(timestampStatus ?? "").toUpperCase() === "STAMPED" ||
          /validated/i.test(String(timestampStatus ?? "")) && !/not validated/i.test(String(timestampStatus ?? ""))
            ? "Timestamped"
            : "Timestamp not validated"
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

function renderForensicTimeline(
  rows: TimelineRow[],
  opts: {
    sequenceOffset: number;
    anchoringCompletesLater: boolean;
    pendingNoteAlreadyRendered: boolean;
  }
): { html: string; pendingNoteRendered: boolean } {
  let pendingNoteRendered = opts.pendingNoteAlreadyRendered;

  if (rows.length === 0) {
    return { html: "", pendingNoteRendered };
  }

  const items = rows.map((row, index) => {
          const displaySequence = String(opts.sequenceOffset + index + 1);

          const shouldShowPendingNote =
            !pendingNoteRendered &&
            opts.anchoringCompletesLater &&
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
        });
  const html = `<div class="timeline-list custody-forensic-timeline">${keepEndsTogether(items, "custody-timeline-group")}</div>`;

  return { html, pendingNoteRendered };
}

export function renderCustodySection(vm: ReportViewModel): string {
  if (vm.forensicRows.length === 0) {
    return renderPageSection(
      "Chain of Custody",
      `
        <div class="custody-page">
          <div class="custody-intro">${escapeHtml(CUSTODY_INTRO)}</div>
          ${renderCallout({
            title: "No forensic custody events returned",
            body: "This report received no forensic custody events for this record; that is not proof that no handling occurred.",
            tone: "warning",
          })}
        </div>
      `,
      { pageBreakBefore: true, className: "custody-section" }
    );
  }

  // ONE flowing timeline: it continues onto as many pages as it needs, and
  // no page is cut to a fixed number of events.
  const timeline = renderForensicTimeline(vm.forensicRows, {
    sequenceOffset: 0,
    anchoringCompletesLater: hasAnchoringCompletion(vm.forensicRows),
    pendingNoteAlreadyRendered: false,
  });
  return renderPageSection(
    "Chain of Custody",
    `
      <div class="custody-page">
        <div class="custody-intro">${escapeHtml(CUSTODY_INTRO)}</div>
        ${renderLifecycleSummary(vm)}
        <div class="custody-timeline-panel">
          ${timeline.html}
        </div>
      </div>
    `,
    { pageBreakBefore: true, className: "custody-section" }
  );
}
