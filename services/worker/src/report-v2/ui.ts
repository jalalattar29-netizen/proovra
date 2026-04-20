import { escapeHtml } from "./formatters.js";
import { CalloutModel, InfoCard, InventoryRow, KeyValueRow, TimelineRow, Tone } from "./types.js";

function toneClass(tone?: Tone): string {
  return tone ? ` tone-${tone}` : " tone-neutral";
}

export function renderPageSection(
  title: string,
  body: string,
  opts?: { pageBreakBefore?: boolean }
): string {
  return `
    <section class="report-section${opts?.pageBreakBefore ? " page-break-before" : ""}">
      <div class="section-rule"></div>
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <div class="section-body">
        ${body}
      </div>
    </section>
  `;
}

export function renderCallout(callout: CalloutModel): string {
  return `
    <div class="callout${toneClass(callout.tone)}">
      <div class="callout-title">${escapeHtml(callout.title)}</div>
      <div class="callout-body">${escapeHtml(callout.body)}</div>
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
              <div class="info-card-value">${escapeHtml(card.value)}</div>
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
              <div class="kv-value">${escapeHtml(row.value)}</div>
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
          <th>#</th>
          <th>Item</th>
          <th>Kind</th>
          <th>MIME / Size</th>
          <th>SHA-256</th>
          <th>Role / Preview</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.indexLabel)}</td>
                <td>${escapeHtml(row.itemLabel)}</td>
                <td>${escapeHtml(row.kindLabel)}</td>
                <td>${row.mimeAndSize}</td>
                <td>${escapeHtml(row.shortHash)}</td>
                <td>${row.roleAndPreview}</td>
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
          <th>Seq</th>
          <th>At (UTC)</th>
          <th>Event</th>
          <th>Summary</th>
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
                <td>${row.summary}</td>
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