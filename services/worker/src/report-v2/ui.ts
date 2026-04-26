import { reportAssetDataUrl } from "./asset-data-url.js";
import { escapeHtml } from "./formatters.js";
import {
  CalloutModel,
  CustodyHashRow,
  InfoCard,
  InventoryRow,
  KeyValueRow,
  TimelineRow,
  Tone,
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

const reportIconUrl = reportAssetDataUrl("icon-192.png");

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
              <img class="report-brand-icon" src="${escapeHtml(reportIconUrl)}" alt="" />
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