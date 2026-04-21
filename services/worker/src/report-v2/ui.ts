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

export function renderPageSection(
  title: string,
  body: string,
  opts?: { pageBreakBefore?: boolean }
): string {
  return `
    <section class="report-section${opts?.pageBreakBefore ? " page-break-before" : ""}">
      <div class="report-page">
        <div class="section-sheet">
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <div class="section-rule"></div>
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

export function renderBulletList(items: string[]): string {
  return `
    <ul class="bullet-list">
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

export function renderInventoryTable(rows: InventoryRow[]): string {
  return `
    <table class="report-table inventory-table">
      <thead>
        <tr>
          <th style="width: 6%">#</th>
          <th style="width: 27%">Original File Name</th>
          <th style="width: 11%">Type</th>
          <th style="width: 16%">Format / Size</th>
          <th style="width: 24%">SHA-256</th>
          <th style="width: 16%">Role / Access</th>
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
                      ? `<div class="manifest-display-label">${renderMultilineText(
                          row.displayLabel
                        )}</div>`
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
  return `
    <table class="report-table timeline-table">
      <thead>
        <tr>
          <th style="width: 8%">Seq</th>
          <th style="width: 22%">At (UTC)</th>
          <th style="width: 18%">Event</th>
          <th style="width: 52%">Summary</th>
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
                <td>${renderMultilineText(row.summary)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

export function renderCustodyHashTable(rows: CustodyHashRow[]): string {
  return `
    <table class="report-table timeline-table custody-hash-table">
      <thead>
        <tr>
          <th style="width: 8%">Seq</th>
          <th style="width: 46%">Prev Event Hash</th>
          <th style="width: 46%">Event Hash</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.sequence)}</td>
                <td><span class="hash-text">${escapeHtml(row.prevEventHash)}</span></td>
                <td><span class="hash-text">${escapeHtml(row.eventHash)}</span></td>
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
