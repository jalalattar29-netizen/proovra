
import { escapeHtml } from "./formatters.js";
import {
  getReviewerRelianceLabel,
  getTrustDecisionLabel,
  getTrustSignalPresentationLabel,
} from "@proovra/shared";
import {
  CalloutModel,
  CustodyHashRow,
  InfoCard,
  InventoryRow,
  KeyValueRow,
  TimelineRow,
  Tone,
  ReportTrustDecision,
  ReportTrustSignal,
} from "./types.js";
function toneClass(tone?: Tone): string {
  return tone ? ` tone-${tone}` : " tone-neutral";
}

function renderMultilineText(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function sanitizeClassName(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean)
    .join(" ");
}

export function renderPageSection(
  title: string,
  body: string,
  opts?: { pageBreakBefore?: boolean; className?: string }
): string {
  const extraClass = opts?.className
    ? ` ${escapeHtml(sanitizeClassName(opts.className))}`
    : "";

  return `
    <section class="report-section${opts?.pageBreakBefore ? " page-break-before" : ""}${extraClass}">
      <div class="report-page">
        <div class="section-sheet">
          <header class="section-heading">
            <div class="section-kicker">
              <span>PROOVRA Verification Report</span>
            </div>
            <h2 class="section-title">${escapeHtml(title)}</h2>
          </header>

          <div class="section-body">
            ${body}
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderCallout(callout: CalloutModel): string {
  return `
    <div class="callout${toneClass(callout.tone)}">
      <div class="callout-title">${escapeHtml(callout.title)}</div>
      <div class="callout-body">${renderMultilineText(callout.body)}</div>
    </div>
  `;
}

export function renderInfoCards(cards: InfoCard[]): string {
  if (cards.length === 0) return "";

  return `
    <div class="info-cards">
      ${cards
        .map(
          (card) => `
            <article class="info-card${toneClass(card.tone)}">
              <div class="info-card-label">${escapeHtml(card.label)}</div>
              <div class="info-card-value">${renderMultilineText(card.value)}</div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderKeyValueGrid(rows: KeyValueRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="kv-grid">
      ${rows
        .map(
          (row) => `
            <div class="kv-item">
              <div class="kv-label">${escapeHtml(row.label)}</div>
              <div class="kv-value">${renderMultilineText(row.value)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

/**
 * Unified enterprise field-card grid. Renders an optional accent title above
 * the SAME two-column field-card grid used by the Web Capture Executive
 * Summary (`renderKeyValueGrid` → `.kv-grid`/`.kv-item`/`.kv-label`/
 * `.kv-value`). This is the single helper for label-above-value metadata
 * grids (Evidence Acquisition, Camera/EXIF, etc.) so every surface matches.
 *
 * Contract:
 *   - null / empty / "N/A" / "UNKNOWN" values are dropped (no empty cards).
 *   - returns "" when nothing meaningful remains (never an empty section).
 *   - each card is break-inside:avoid; the grid itself may flow across pages
 *     (both inherited from `.kv-grid` CSS) — no clipped rows, no footer
 *     overlap, no half-split cards.
 */
export function renderFieldGrid(
  fields: ReadonlyArray<{ label: string; value: string | null | undefined }>,
  opts?: { title?: string; className?: string },
): string {
  const rows: KeyValueRow[] = [];
  for (const f of fields) {
    const value = (f.value ?? "").toString().trim();
    if (!value) continue;
    const upper = value.toUpperCase();
    if (upper === "N/A" || upper === "UNKNOWN") continue;
    rows.push({ label: f.label, value });
  }
  if (rows.length === 0) return "";

  const titleHtml = opts?.title
    ? `<h3 class="field-grid-title subsection-title">${escapeHtml(opts.title)}</h3>`
    : "";
  const extraClass = opts?.className
    ? ` ${escapeHtml(sanitizeClassName(opts.className))}`
    : "";
  return `<section class="field-grid-section${extraClass}">${titleHtml}${renderKeyValueGrid(rows)}</section>`;
}

export function renderCompactKeyValueList(rows: KeyValueRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="compact-kv-list">
      ${rows
        .map(
          (row) => `
            <div class="compact-kv-row">
              <div class="compact-kv-label">${escapeHtml(row.label)}</div>
              <div class="compact-kv-value">${renderMultilineText(row.value)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderBulletList(items: string[]): string {
  if (items.length === 0) return "";

  return `
    <ul class="bullet-list">
      ${items.map((item) => `<li><span>${escapeHtml(item)}</span></li>`).join("")}
    </ul>
  `;
}

export function renderInventoryTable(rows: InventoryRow[]): string {
  if (rows.length === 0) return "";

  return `
    <table class="report-table inventory-table">
      <thead>
        <tr>
          <th style="width: 6%">#</th>
          <th style="width: 27%">File</th>
          <th style="width: 11%">Type</th>
          <th style="width: 15%">Format / Size</th>
          <th style="width: 27%">Item SHA-256</th>
          <th style="width: 14%">Role</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.indexLabel)}</td>
                <td>
                  <div class="manifest-file-name">${escapeHtml(row.fileName)}</div>
                  ${
                    row.displayLabel
                      ? `<div class="manifest-display-label">${renderMultilineText(row.displayLabel)}</div>`
                      : ""
                  }
                </td>
                <td>${escapeHtml(row.kindLabel)}</td>
                <td>${renderMultilineText(row.formatAndSize)}</td>
                <td><span class="hash-text">${escapeHtml(row.sha256)}</span></td>
                <td>${renderMultilineText(row.roleAndStatus)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

export function renderTimelineTable(rows: TimelineRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="timeline-list">
      ${rows
        .map(
          (row) => `
            <article class="timeline-card">
              <div class="timeline-seq">${escapeHtml(row.sequence)}</div>
              <div class="timeline-content">
                <div class="timeline-top">
                  <div class="timeline-event">${escapeHtml(row.eventLabel)}</div>
                  <div class="timeline-time">${escapeHtml(row.atUtc)}</div>
                </div>
                <div class="timeline-summary">${renderMultilineText(row.summary)}</div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderAccessActivityList(rows: TimelineRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="custody-access-list">
      ${rows
        .map(
          (row) => `
            <article class="custody-access-event">
              <div class="custody-access-marker">Access<br/>event</div>
              <div class="custody-access-content">
                <div class="custody-access-top">
                  <div class="custody-access-title">${escapeHtml(row.eventLabel)}</div>
                  <div class="custody-access-time">${escapeHtml(row.atUtc)}</div>
                </div>
                <div class="custody-access-summary">${renderMultilineText(row.summary)}</div>
                <div class="custody-access-sequence">
                  Original custody sequence: ${escapeHtml(row.sequence)}
                </div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderCustodyHashTable(rows: CustodyHashRow[]): string {
  if (rows.length === 0) return "";

  return `
    <table class="report-table custody-hash-table custody-hash-chain-table">
      <thead>
        <tr>
          <th style="width: 6%">Seq</th>
          <th style="width: 14%">At (UTC)</th>
          <th style="width: 16%">Event</th>
<th style="width: 32%">Previous Custody Event Hash</th>
<th style="width: 32%">Custody Event Hash</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.sequence)}</td>
                <td>${escapeHtml(row.atUtc)}</td>
                <td>${escapeHtml(row.eventLabel)}</td>
                <td><span class="hash-text">${escapeHtml(row.prevEventHash || "N/A")}</span></td>
                <td><span class="hash-text">${escapeHtml(row.eventHash || "N/A")}</span></td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

export function renderMonoBlock(label: string, value: string): string {
  return `
    <div class="mono-block">
      <div class="mono-label">${escapeHtml(label)}</div>
      <pre class="mono-value">${escapeHtml(value)}</pre>
    </div>
  `;
}

export function renderInlineQrBlock(
  dataUrl: string | null | undefined,
  label: string
): string {
  if (!dataUrl) {
    return `
      <div class="qr-inline-block">
        <div class="cover-verify-placeholder">QR unavailable</div>
        <div class="qr-inline-label">${escapeHtml(label)}</div>
      </div>
    `;
  }

  return `
    <div class="qr-inline-block">
      <img src="${dataUrl}" alt="${escapeHtml(label)}" />
      <div class="qr-inline-label">${escapeHtml(label)}</div>
    </div>
  `;
}

function trustSignalMark(signal: ReportTrustSignal): string {
  switch (signal.status) {
    case "passed":
      return "✓";
    case "partial":
    case "pending":
      return "!";
    case "failed":
      return "!";
    case "missing":
    default:
      return "i";
  }
}

export function renderTrustDecisionHero(decision: ReportTrustDecision): string {
  return `
    <section class="trust-decision-hero trust-decision-${escapeHtml(decision.level)} tone-${decision.tone}">
      <div class="trust-decision-main">
        <div class="trust-decision-kicker">Overall trust decision</div>
        <div class="trust-decision-title">${escapeHtml(
          getTrustDecisionLabel(decision)
        )}</div>
        <div class="trust-decision-summary">${renderMultilineText(decision.summary)}</div>
      </div>

      <div class="trust-score-card">
        <div class="trust-score-value">${escapeHtml(
          getTrustDecisionLabel(decision)
        )}</div>
        <div class="trust-score-label">Trust classification</div>
        <div class="trust-score-reliance">Reviewer reliance: ${escapeHtml(
          getReviewerRelianceLabel(decision.relianceLevel)
        )}</div>
      </div>
    </section>
  `;
}

export function renderTrustSignalGrid(signals: ReportTrustSignal[]): string {
  if (signals.length === 0) return "";

  return `
    <div class="trust-signal-grid">
      ${signals
        .map(
          (signal) => `
            <article class="trust-signal-card tone-${signal.tone}">
              <div class="trust-signal-mark">${escapeHtml(trustSignalMark(signal))}</div>
              <div class="trust-signal-content">
                <div class="trust-signal-top">
                  <div class="trust-signal-label">${escapeHtml(signal.label)}</div>
                  <div class="trust-signal-score">${escapeHtml(
                    getTrustSignalPresentationLabel(signal)
                  )}</div>
                </div>
                <div class="trust-signal-summary">${escapeHtml(signal.summary)}</div>
                <div class="trust-signal-detail">${escapeHtml(signal.detail)}</div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderTrustDecisionCompact(decision: ReportTrustDecision): string {
  return `
    <section class="trust-decision-compact tone-${decision.tone}">
      <div>
        <div class="trust-decision-compact-kicker">Trust decision</div>
        <div class="trust-decision-compact-title">${escapeHtml(
          getTrustDecisionLabel(decision)
        )} <span>${escapeHtml(
          `Reviewer reliance: ${getReviewerRelianceLabel(decision.relianceLevel)}`
        )}</span></div>
        <div class="trust-decision-compact-body">${escapeHtml(
          decision.primaryReason
        )}</div>
      </div>
    </section>
  `;
}
