import { REPORT_BRAND } from "../brand.js";

export function getReportCss(): string {
  const c = REPORT_BRAND.colors;

  return `
    @page {
      size: A4;
      margin: 9mm 8mm 10mm 8mm;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: ${c.paper};
      color: ${c.ink};
      font-family: "Inter", "IBM Plex Sans", "Segoe UI", Arial, Helvetica, sans-serif;
      font-size: 10.8px;
      line-height: 1.48;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      overflow: visible;
    }

    body {
      background: ${c.paper} !important;
    }

    .report-root {
      width: 100%;
      color: ${c.ink};
    }

    .page-break-before {
      break-before: page;
      page-break-before: always;
    }

    .report-header-band {
      height: 8px;
      background: ${c.accent} !important;
      border-radius: 0 0 12px 12px;
      margin-bottom: 12px;
    }

    .report-page,
    .report-cover {
      display: block;
      width: 100%;
      overflow: visible;
      margin: 0 0 14px;
      break-after: auto;
      page-break-after: auto;
    }

    .report-cover {
      break-after: page;
      page-break-after: always;
    }

    .report-cover-premium {
      display: block;
    }

    .cover-certificate-card,
    .section-sheet {
      border: 1px solid ${c.line};
      background: ${c.white} !important;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: none;
    }

    .cover-certificate-card {
      min-height: 265mm;
      display: flex;
      flex-direction: column;
    }

    .cover-certificate-top {
      min-height: 66px;
      background: ${c.accent} !important;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 15px 20px;
      border-bottom: 3px solid ${c.accentMetal};
    }

    .cover-brand-lockup {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .cover-brand-mini {
      color: #ffffff;
      font-size: 16px;
      font-weight: 950;
      letter-spacing: 0.1em;
    }

    .cover-brand-sub {
      color: rgba(255,255,255,0.78);
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .cover-top-badge {
      max-width: 320px;
      text-align: center;
    }

    .cover-premium-body {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1.42fr) minmax(245px, 0.78fr);
      gap: 20px;
      align-items: stretch;
      padding: 22px 20px 18px;
    }

    .cover-left-column,
    .cover-right-column {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 13px;
    }

    .cover-eyebrow,
    .section-kicker {
      color: ${c.subtle};
      font-size: 9.2px;
      font-weight: 900;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .cover-certificate-title {
      margin: 0;
      font-size: 30px;
      line-height: 1.08;
      font-weight: 950;
      color: ${c.accent};
      letter-spacing: -0.035em;
      word-break: break-word;
    }

    .cover-certificate-subtitle {
      font-size: 12.5px;
      font-weight: 650;
      color: ${c.muted};
      line-height: 1.52;
      max-width: 96%;
      word-break: break-word;
    }

    .cover-hero-summary,
    .cover-meta-grid,
    .info-cards,
    .kv-grid,
    .technical-status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
    }

    .cover-hero-summary-item,
    .cover-meta-card,
    .info-card,
    .kv-item,
    .technical-status-card,
    .verification-link-panel,
    .callout,
    .appendix-section,
    .mono-block,
    .gallery-card,
    .gallery-secondary-item,
    .cover-status-panel,
    .cover-verify-box,
    .cover-evidence-panel {
      border: 1px solid ${c.softLine};
      background: ${c.white} !important;
      border-radius: 14px;
      box-shadow: none;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-hero-summary-item,
    .cover-meta-card,
    .info-card,
    .kv-item {
      padding: 11px 12px;
      min-height: 61px;
    }

    .cover-meta-card-wide {
      grid-column: 1 / -1;
    }

    .cover-hero-summary-label,
    .cover-meta-label,
    .info-card-label,
    .kv-label,
    .gallery-meta-label,
    .verification-link-panel-label,
    .technical-status-kicker,
    .cover-status-name {
      color: ${c.subtle};
      font-size: 8.8px;
      font-weight: 950;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 5px;
    }

    .cover-hero-summary-value,
    .cover-meta-value,
    .info-card-value,
    .kv-value,
    .technical-status-value,
    .cover-status-value {
      color: ${c.ink};
      font-size: 11.2px;
      font-weight: 760;
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .cover-meta-value-code,
    .hash-text,
    .mono-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      word-break: break-all;
      overflow-wrap: anywhere;
    }

    .cover-meta-value-code {
      font-size: 9.6px;
      line-height: 1.48;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 9.3px;
      font-weight: 900;
      border: 1px solid transparent;
      width: fit-content;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1.1;
    }

    .badge-success {
      background: ${c.successSoft};
      color: ${c.success};
      border-color: rgba(33, 117, 93, 0.24);
    }

    .badge-warning {
      background: ${c.warningSoft};
      color: ${c.warning};
      border-color: rgba(138, 106, 47, 0.24);
    }

    .badge-danger {
      background: ${c.dangerSoft};
      color: ${c.danger};
      border-color: rgba(181, 71, 56, 0.22);
    }

    .badge-neutral {
      background: ${c.neutralSoft};
      color: ${c.ink};
      border-color: ${c.line};
    }

    .cover-evidence-panel {
      display: grid;
      grid-template-columns: 155px minmax(0, 1fr);
      gap: 13px;
      padding: 12px;
      align-items: stretch;
    }

    .cover-evidence-visual {
      min-height: 128px;
      background: ${c.neutralSoft} !important;
      border: 1px solid ${c.softLine};
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .cover-evidence-visual img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #ffffff;
    }

    .cover-evidence-placeholder {
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      text-align: center;
    }

    .cover-evidence-placeholder-kind {
      font-size: 11px;
      font-weight: 950;
      letter-spacing: 0.05em;
      color: ${c.accent};
    }

    .cover-evidence-placeholder-note {
      font-size: 8.9px;
      line-height: 1.42;
      color: ${c.muted};
      font-weight: 700;
    }

    .cover-evidence-meta {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      justify-content: center;
    }

    .cover-evidence-name {
      font-size: 14px;
      font-weight: 950;
      line-height: 1.28;
      color: ${c.accent};
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-evidence-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      color: ${c.muted};
      font-size: 9px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .cover-verify-box {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: stretch;
      justify-content: center;
      min-height: 214px;
    }

    .cover-verify-qr-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .qr-inline-block {
      border: 1px solid ${c.softLine};
      background: #ffffff !important;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 10px;
      min-width: 128px;
      border-radius: 14px;
    }

    .qr-inline-block img {
      width: 108px;
      height: 108px;
      object-fit: contain;
      display: block;
      background: white;
    }

    .qr-inline-label {
      font-size: 8.8px;
      color: ${c.subtle};
      font-weight: 850;
      text-align: center;
    }

    .cover-verify-title {
      color: ${c.accent};
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      text-align: center;
    }

    .cover-verify-url,
    .verification-link-panel-value {
      color: ${c.muted};
      font-size: 8.9px;
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .cover-status-panel {
      overflow: hidden;
    }

    .cover-status-row {
      display: grid;
      grid-template-columns: 112px 1fr;
      gap: 10px;
      padding: 10px 12px;
      border-top: 1px solid ${c.softLine};
      align-items: start;
    }

    .cover-status-row:first-child {
      border-top: none;
    }

    .cover-certificate-bottom {
      min-height: 44px;
      background: ${c.accent} !important;
      border-top: 3px solid ${c.accentMetal};
      padding: 9px 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      color: #ffffff;
      font-size: 9px;
      font-weight: 760;
    }

    .cover-certificate-bottom span {
      white-space: nowrap;
      padding-left: 10px;
      border-left: 1px solid rgba(255,255,255,0.25);
    }

    .cover-certificate-bottom span:first-child {
      padding-left: 0;
      border-left: none;
    }

    .report-section {
      margin: 0 0 14px;
    }

    .section-sheet {
      padding: 16px 16px 14px;
      overflow: visible;
      break-inside: auto;
      page-break-inside: auto;
    }

    .section-title {
      margin: 0;
      font-size: 18.5px;
      line-height: 1.12;
      font-weight: 950;
      color: ${c.accent};
      letter-spacing: -0.025em;
      break-after: avoid;
      page-break-after: avoid;
    }

    .section-rule {
      height: 1px;
      background: ${c.line};
      margin: 10px 0 12px;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .sheet-footer {
      margin-top: 12px;
      padding-top: 9px;
      border-top: 1px solid ${c.softLine};
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: ${c.subtle};
      font-size: 8.4px;
    }

    .callout {
      padding: 11px 12px;
    }

    .tone-success {
      background: ${c.successSoft} !important;
      border-color: rgba(33, 117, 93, 0.22);
    }

    .tone-warning {
      background: ${c.warningSoft} !important;
      border-color: rgba(138, 106, 47, 0.22);
    }

    .tone-danger {
      background: ${c.dangerSoft} !important;
      border-color: rgba(181, 71, 56, 0.20);
    }

    .tone-neutral {
      background: ${c.neutralSoft} !important;
      border-color: ${c.line};
    }

    .callout-title {
      font-size: 10.8px;
      font-weight: 950;
      margin-bottom: 5px;
      color: ${c.ink};
    }

    .callout-body {
      font-size: 10px;
      color: ${c.muted};
      white-space: pre-wrap;
      line-height: 1.56;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .executive-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(250px, 0.9fr);
      gap: 12px;
      align-items: start;
    }

    .executive-main,
    .executive-side {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }

    .evidence-strip,
    .review-strip,
    .appendix-compact-note {
      border: 1px solid ${c.softLine};
      background: ${c.neutralSoft} !important;
      border-radius: 14px;
      padding: 11px 12px;
      color: ${c.muted};
      font-size: 10px;
      line-height: 1.55;
    }

    .report-table,
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid ${c.line};
      border-radius: 12px;
      background: ${c.white} !important;
      table-layout: fixed;
      break-inside: auto;
      page-break-inside: auto;
      overflow: hidden;
    }

    .report-table thead,
    table thead {
      display: table-header-group;
    }

    .report-table thead th {
      background: ${c.accentSoft} !important;
      color: ${c.accent};
      font-size: 8.4px;
      font-weight: 950;
      text-align: left;
      padding: 7px 8px;
      border-bottom: 1px solid ${c.line};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      vertical-align: top;
    }

    .report-table tbody td {
      padding: 7px 8px;
      font-size: 8.8px;
      color: ${c.ink};
      border-bottom: 1px solid ${c.softLine};
      vertical-align: top;
      line-height: 1.42;
      word-break: break-word;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .report-table tbody tr:last-child td {
      border-bottom: none;
    }

    .gallery-primary {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .gallery-support-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .gallery-card {
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .gallery-card-header {
      padding: 10px 12px 9px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: ${c.white} !important;
      border-bottom: 1px solid ${c.softLine};
    }

    .gallery-card-topline {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .gallery-card-index,
    .gallery-card-role {
      font-size: 8.5px;
      font-weight: 950;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .gallery-card-index {
      color: ${c.subtle};
    }

    .gallery-card-role {
      color: ${c.accent};
    }

    .gallery-card-file-name {
      font-size: 12.2px;
      font-weight: 950;
      color: ${c.accent};
      line-height: 1.3;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-card-display-label {
      font-size: 9px;
      color: ${c.subtle};
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-thumb {
      height: 205px;
      background: ${c.neutralSoft} !important;
      border-bottom: 1px solid ${c.softLine};
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .gallery-thumb-emphasis {
      height: 348px;
    }

    .gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #ffffff;
    }

    .gallery-thumb-placeholder {
      padding: 14px;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 7px;
      align-items: center;
      justify-content: center;
    }

    .gallery-thumb-placeholder-title {
      font-size: 10px;
      color: ${c.accent};
      font-weight: 950;
    }

    .gallery-thumb-placeholder-note {
      font-size: 9px;
      color: ${c.muted};
      font-weight: 650;
      line-height: 1.45;
      max-width: 88%;
    }

    .gallery-card-meta {
      padding: 10px 12px 12px;
      display: grid;
      gap: 6px;
    }

    .gallery-meta-row {
      display: grid;
      grid-template-columns: 108px 1fr;
      gap: 9px;
      align-items: start;
      padding-top: 6px;
      border-top: 1px solid ${c.softLine};
    }

    .gallery-meta-row:first-child {
      border-top: none;
      padding-top: 0;
    }

    .gallery-meta-value {
      font-size: 9px;
      font-weight: 720;
      color: ${c.ink};
      line-height: 1.4;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .gallery-secondary-list {
      display: grid;
      gap: 8px;
    }

    .gallery-secondary-item {
      padding: 11px 12px;
    }

    .gallery-secondary-name {
      font-size: 11px;
      font-weight: 950;
      color: ${c.accent};
      line-height: 1.35;
      margin-bottom: 7px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-secondary-grid {
      display: grid;
      grid-template-columns: 108px 1fr;
      gap: 7px 10px;
    }

    .timeline {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    .timeline-item {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 10px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .timeline-index {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: ${c.accentSoft};
      color: ${c.accent};
      border: 1px solid ${c.line};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 950;
      margin-top: 3px;
    }

    .timeline-card {
      border: 1px solid ${c.softLine};
      background: ${c.white};
      border-radius: 13px;
      padding: 10px 11px;
    }

    .timeline-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 5px;
    }

    .timeline-event {
      font-size: 11px;
      font-weight: 950;
      color: ${c.ink};
      line-height: 1.3;
    }

    .timeline-time {
      font-size: 8.7px;
      color: ${c.subtle};
      font-weight: 800;
      white-space: nowrap;
    }

    .timeline-summary {
      font-size: 9.6px;
      color: ${c.muted};
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .custody-hash-table th,
    .custody-hash-table td {
      font-size: 6.8px !important;
      line-height: 1.15 !important;
      padding: 4px 5px !important;
    }

    .custody-hash-table .hash-text {
      font-size: 6.5px !important;
      line-height: 1.15 !important;
      letter-spacing: -0.01em;
    }

    .mono-label {
      padding: 8px 10px;
      font-size: 8.7px;
      font-weight: 950;
      color: ${c.subtle};
      background: ${c.accentSoft} !important;
      border-bottom: 1px solid ${c.softLine};
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .mono-value {
      margin: 0;
      padding: 10px;
      font-size: 8.8px;
      line-height: 1.45;
      color: ${c.ink};
      background: #ffffff !important;
      white-space: pre-wrap;
    }

    .hash-text {
      font-size: 8.4px;
      line-height: 1.4;
      color: ${c.ink};
      white-space: pre-wrap;
    }

    .appendix-section {
      padding: 11px 12px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .appendix-section-title {
      margin: 0 0 9px;
      font-size: 11px;
      font-weight: 950;
      color: ${c.accent};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      break-after: avoid;
      page-break-after: avoid;
    }

    .technical-status-card {
      padding: 11px 12px;
      min-height: 92px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .technical-status-title {
      font-size: 10px;
      font-weight: 950;
      color: ${c.accent};
      line-height: 1.26;
    }

    .technical-status-note {
      font-size: 8.9px;
      color: ${c.muted};
      line-height: 1.42;
      margin-top: auto;
    }

    .bullet-list {
      margin: 0;
      padding-left: 16px;
      color: ${c.muted};
    }

    .bullet-list li {
      margin: 0 0 4px;
    }

    .report-footer-note {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid ${c.line};
      font-size: 8.4px;
      color: ${c.subtle};
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }

    .avoid-break {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    @media print {
      body {
        overflow: visible;
      }

      .report-root > .report-section:last-of-type .report-page {
        break-after: auto;
        page-break-after: auto;
        margin-bottom: 0;
      }

      .report-footer-note {
        position: static;
      }

      .callout,
      .info-card,
      .kv-item,
      .cover-meta-card,
      .cover-hero-summary-item,
      .cover-status-panel,
      .gallery-card,
      .gallery-secondary-item,
      .mono-block,
      .technical-status-card,
      .verification-link-panel,
      .cover-evidence-panel,
      .cover-verify-box,
      .timeline-item {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .report-table,
      table,
      .section-sheet,
      .appendix-section {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

      .report-table thead,
      table thead {
        display: table-header-group !important;
      }
    }
  `;
}