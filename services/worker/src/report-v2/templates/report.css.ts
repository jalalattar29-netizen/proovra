import { REPORT_BRAND } from "../brand.js";

export function getReportCss(): string {
  const c = REPORT_BRAND.colors;

  return `
    @page {
      size: A4;
      margin: 12mm 10mm 13mm 10mm;
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
      font-family: "Segoe UI", Arial, Helvetica, sans-serif;
      font-size: 10.4px;
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
      height: 7px;
      background: ${c.accent};
      border-radius: 0 0 8px 8px;
      margin-bottom: 12px;
    }

    .report-cover {
      width: 100%;
      margin: 0 0 16px;
      break-after: page;
      page-break-after: always;
    }

    .report-page {
      width: 100%;
      margin-bottom: 14px;
      overflow: visible;
    }

    .section-sheet,
    .cover-certificate-card {
      background: ${c.white};
      border: 1px solid ${c.line};
      border-radius: 10px;
      box-shadow: none;
      overflow: visible;
    }

    .section-sheet {
      padding: 14px 14px 12px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .section-heading {
      break-after: avoid;
      page-break-after: avoid;
    }

    .section-kicker {
      margin-bottom: 3px;
      color: ${c.subtle};
      font-size: 8.2px;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .section-title {
      margin: 0 0 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid ${c.line};
      font-size: 17px;
      font-weight: 850;
      color: ${c.accent};
      letter-spacing: -0.01em;
      break-after: avoid;
      page-break-after: avoid;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .cover-certificate-card {
      display: flex;
      flex-direction: column;
      min-height: 258mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-certificate-top,
    .cover-certificate-bottom {
      background: ${c.accent} !important;
      color: #ffffff;
    }

    .cover-certificate-top {
      min-height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 11px 16px;
      border-bottom: 2px solid ${c.accentMetal};
      border-radius: 10px 10px 0 0;
    }

    .cover-brand-lockup {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .cover-brand-mini {
      color: #ffffff;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }

    .cover-brand-sub {
      color: rgba(255,255,255,0.82);
      font-size: 9px;
      font-weight: 750;
      letter-spacing: 0.055em;
      text-transform: uppercase;
    }

    .cover-premium-body {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1.48fr) minmax(230px, 0.82fr);
      gap: 16px;
      align-items: start;
      padding: 20px 18px 16px;
    }

    .cover-left-column,
    .cover-right-column {
      display: flex;
      flex-direction: column;
      gap: 11px;
      min-width: 0;
    }

    .cover-eyebrow {
      color: ${c.subtle};
      font-size: 9px;
      font-weight: 850;
      letter-spacing: 0.075em;
      text-transform: uppercase;
    }

    .cover-certificate-title {
      margin: 0;
      font-size: 25px;
      line-height: 1.14;
      font-weight: 900;
      color: ${c.accent};
      letter-spacing: -0.025em;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-certificate-subtitle {
      font-size: 11.4px;
      font-weight: 600;
      color: ${c.muted};
      line-height: 1.48;
      max-width: 96%;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 8.9px;
      font-weight: 850;
      border: 1px solid transparent;
      width: fit-content;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      line-height: 1.2;
    }

    .cover-top-badge {
      max-width: 245px;
      text-align: center;
      background: rgba(255,255,255,0.12);
      color: #ffffff;
      border-color: rgba(255,255,255,0.2);
    }

    .badge-success,
    .tone-success {
      background: ${c.successSoft} !important;
      color: ${c.success};
      border-color: rgba(33, 117, 93, 0.22) !important;
    }

    .badge-warning,
    .tone-warning {
      background: ${c.warningSoft} !important;
      color: ${c.warning};
      border-color: rgba(138, 106, 47, 0.22) !important;
    }

    .badge-danger,
    .tone-danger {
      background: ${c.dangerSoft} !important;
      color: ${c.danger};
      border-color: rgba(181, 71, 56, 0.2) !important;
    }

    .badge-neutral,
    .tone-neutral {
      background: ${c.neutralSoft} !important;
      color: ${c.ink};
      border-color: ${c.softLine} !important;
    }

    .cover-decision-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-decision-indicator {
      border: 1px solid ${c.softLine};
      border-radius: 10px;
      padding: 10px 9px;
      min-height: 64px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-decision-label {
      font-size: 8.2px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .cover-decision-value {
      font-size: 11px;
      font-weight: 900;
      line-height: 1.25;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-hero-summary,
    .cover-meta-grid,
    .info-cards,
    .kv-grid,
    .technical-status-grid,
    .integrity-control-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .executive-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 9px;
    }

    .executive-main,
    .executive-side {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .cover-hero-summary-item,
    .cover-meta-card,
    .info-card,
    .kv-item,
    .technical-status-card,
    .integrity-control-card,
    .callout,
    .verification-link-panel,
    .mono-block,
    .appendix-section,
    .cover-status-panel,
    .cover-verify-box,
    .cover-evidence-panel,
    .gallery-card,
    .gallery-secondary-item,
    .timeline-card {
      background: ${c.white};
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      box-shadow: none;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-hero-summary-item {
      padding: 10px 11px;
      min-height: 58px;
    }

    .cover-hero-summary-label,
    .cover-meta-label,
    .info-card-label,
    .kv-label,
    .gallery-meta-label,
    .technical-status-kicker,
    .integrity-control-kicker,
    .verification-link-panel-label,
    .mono-label,
    .appendix-section-title,
    .cover-status-name,
    .compact-kv-label {
      color: ${c.subtle};
      font-size: 8.6px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .cover-hero-summary-value {
      display: block;
      margin-top: 5px;
      font-size: 11px;
      font-weight: 800;
      color: ${c.ink};
      line-height: 1.36;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-evidence-panel {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: 10px;
      padding: 10px;
    }

    .cover-evidence-visual {
      height: 102px;
      background: ${c.neutralSoft};
      border: 1px solid ${c.softLine};
      border-radius: 7px;
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
      background: #f8fafc;
    }

    .cover-evidence-placeholder {
      flex-direction: column;
      text-align: center;
      padding: 10px;
      gap: 6px;
    }

    .cover-evidence-placeholder-kind {
      font-size: 10px;
      font-weight: 900;
      color: ${c.accent};
      letter-spacing: 0.04em;
    }

    .cover-evidence-placeholder-note {
      font-size: 8.4px;
      color: ${c.muted};
      line-height: 1.35;
      font-weight: 650;
    }

    .cover-evidence-meta {
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-width: 0;
    }

    .cover-evidence-name {
      font-size: 13px;
      font-weight: 850;
      line-height: 1.3;
      color: ${c.accent};
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-evidence-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: ${c.muted};
      font-size: 8.6px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.035em;
    }

    .cover-meta-card {
      padding: 10px 11px;
      min-height: 58px;
    }

    .cover-meta-card-wide {
      grid-column: 1 / -1;
    }

    .cover-meta-value,
    .cover-status-value,
    .verification-link-panel-value,
    .kv-value,
    .info-card-value,
    .gallery-meta-value,
    .technical-status-value,
    .integrity-control-value,
    .compact-kv-value {
      color: ${c.ink};
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .cover-meta-value {
      margin-top: 5px;
      font-size: 10.7px;
      font-weight: 700;
      line-height: 1.42;
    }

    .cover-meta-value-code,
    .hash-text,
    .mono-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      word-break: break-all;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .cover-meta-value-code {
      font-size: 8.4px;
      line-height: 1.42;
    }

    .cover-verify-box {
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      min-height: 210px;
    }

    .cover-verify-qr-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .qr-inline-block {
      border: 1px solid ${c.softLine};
      background: ${c.white};
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 10px;
      min-width: 124px;
      border-radius: 8px;
    }

    .qr-inline-block img {
      width: 104px;
      height: 104px;
      object-fit: contain;
      display: block;
      background: white;
    }

    .qr-inline-label {
      font-size: 8.8px;
      color: ${c.subtle};
      font-weight: 800;
      text-align: center;
    }

    .cover-verify-placeholder {
      width: 104px;
      height: 104px;
      border: 1px dashed ${c.line};
      background: ${c.neutralSoft};
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${c.subtle};
      font-size: 9px;
      font-weight: 700;
      text-align: center;
      padding: 10px;
      border-radius: 8px;
    }

    .cover-verify-title {
      color: ${c.accent};
      font-size: 10px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: 0.045em;
      text-align: center;
    }

    .cover-verify-url {
      margin-top: 5px;
      color: ${c.subtle};
      font-size: 8.3px;
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .cover-status-panel {
      overflow: hidden;
    }

    .cover-status-row {
      display: grid;
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 9px;
      padding: 9px 10px;
      border-top: 1px solid ${c.softLine};
      align-items: start;
    }

    .cover-status-row:first-child {
      border-top: none;
    }

    .cover-status-value {
      font-size: 10px;
      font-weight: 700;
      line-height: 1.42;
    }

    .cover-certificate-bottom {
      min-height: 39px;
      border-top: 2px solid ${c.accentMetal};
      padding: 9px 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 9px;
      font-weight: 750;
      border-radius: 0 0 10px 10px;
    }

    .cover-certificate-bottom span {
      white-space: nowrap;
      padding-left: 10px;
      border-left: 1px solid rgba(255,255,255,0.3);
    }

    .cover-certificate-bottom span:first-child {
      padding-left: 0;
      border-left: none;
    }

    .callout {
      padding: 10px 11px;
    }

    .callout-title {
      font-size: 10.4px;
      font-weight: 850;
      margin-bottom: 5px;
      color: ${c.ink};
    }

    .callout-body {
      font-size: 9.8px;
      color: ${c.muted};
      white-space: pre-wrap;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .info-card {
      padding: 10px 11px;
      min-height: 70px;
    }

    .info-card-value {
      margin-top: 6px;
      font-size: 11.8px;
      font-weight: 850;
      line-height: 1.32;
    }

    .kv-item {
      padding: 9px 10px;
      min-height: 54px;
    }

    .kv-value {
      margin-top: 5px;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.42;
    }

    .compact-kv-list {
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      overflow: hidden;
      background: ${c.white};
    }

    .compact-kv-row {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: 10px;
      padding: 8px 10px;
      border-top: 1px solid ${c.softLine};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .compact-kv-row:first-child {
      border-top: none;
    }

    .compact-kv-value {
      font-size: 9.6px;
      font-weight: 700;
      line-height: 1.42;
    }

    .evidence-strip {
      border: 1px solid ${c.line};
      border-left: 4px solid ${c.accent};
      background: ${c.neutralSoft};
      color: ${c.muted};
      border-radius: 9px;
      padding: 10px 12px;
      font-size: 10.2px;
      line-height: 1.5;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .gallery-primary {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-support-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-card {
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .gallery-card-header {
      padding: 9px 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: ${c.white};
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
      font-weight: 850;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .gallery-card-role {
      color: ${c.accent};
    }

    .gallery-card-file-name {
      font-size: 11.5px;
      font-weight: 850;
      color: ${c.accent};
      line-height: 1.3;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-card-display-label {
      font-size: 8.9px;
      color: ${c.subtle};
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-thumb {
      height: 178px;
      background: ${c.neutralSoft};
      border-bottom: 1px solid ${c.softLine};
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .gallery-thumb-emphasis {
      height: 295px;
    }

    .gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #f8fafc;
    }

    .gallery-thumb-text {
      align-items: stretch;
      justify-content: stretch;
    }

    .gallery-thumb-text-inner {
      width: 100%;
      height: 100%;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      overflow: hidden;
      background: ${c.white};
    }

    .gallery-thumb-text-title {
      font-size: 8.8px;
      font-weight: 850;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .gallery-thumb-text-body {
      font-size: 9.2px;
      color: ${c.ink};
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      overflow: hidden;
    }

    .gallery-thumb-placeholder {
      padding: 12px;
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
      font-weight: 850;
      letter-spacing: 0.035em;
    }

    .gallery-thumb-placeholder-note {
      font-size: 9px;
      color: ${c.muted};
      font-weight: 650;
      line-height: 1.4;
      max-width: 88%;
    }

    .gallery-card-meta {
      padding: 9px 10px 10px;
      display: grid;
      gap: 5px;
    }

    .gallery-meta-row {
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding-top: 5px;
      border-top: 1px solid ${c.softLine};
    }

    .gallery-meta-row:first-child {
      border-top: none;
      padding-top: 0;
    }

    .gallery-meta-value {
      font-size: 8.8px;
      font-weight: 700;
      line-height: 1.38;
    }

    .gallery-secondary-list {
      display: grid;
      gap: 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-secondary-item {
      padding: 10px;
    }

    .gallery-secondary-name {
      font-size: 10.8px;
      font-weight: 850;
      color: ${c.accent};
      line-height: 1.35;
      margin-bottom: 7px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-secondary-grid {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 6px 10px;
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .timeline-card {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 9px;
      padding: 9px 10px;
    }

    .timeline-seq {
      width: 26px;
      height: 26px;
      border-radius: 999px;
      background: ${c.accentSoft};
      color: ${c.accent};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 900;
    }

    .timeline-content {
      min-width: 0;
    }

    .timeline-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
      margin-bottom: 4px;
    }

    .timeline-event {
      color: ${c.accent};
      font-size: 10px;
      font-weight: 850;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .timeline-time {
      color: ${c.subtle};
      font-size: 8.4px;
      font-weight: 750;
      text-align: right;
      white-space: nowrap;
    }

    .timeline-summary {
      color: ${c.muted};
      font-size: 9.3px;
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .integrity-control-card {
      padding: 10px;
      min-height: 82px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .integrity-control-title {
      color: ${c.accent};
      font-size: 10.2px;
      font-weight: 850;
      line-height: 1.3;
    }

    .integrity-control-value {
      font-size: 11.8px;
      font-weight: 900;
      line-height: 1.25;
    }

    .integrity-control-note {
      color: ${c.muted};
      font-size: 8.8px;
      line-height: 1.38;
      margin-top: auto;
    }

    .report-table,
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid ${c.line};
      background: ${c.white};
      table-layout: fixed;
      break-inside: auto;
      page-break-inside: auto;
    }

    .report-table thead,
    table thead {
      display: table-header-group;
    }

    .report-table th {
      background: ${c.accentSoft};
      color: ${c.accent};
      font-size: 8.2px;
      font-weight: 850;
      text-align: left;
      padding: 6px 7px;
      border-bottom: 1px solid ${c.line};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      vertical-align: top;
    }

    .report-table td {
      padding: 6px 7px;
      font-size: 8.5px;
      color: ${c.ink};
      border-bottom: 1px solid ${c.softLine};
      vertical-align: top;
      line-height: 1.35;
      word-break: break-word;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .report-table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-table tbody tr:last-child td {
      border-bottom: none;
    }

    .manifest-file-name {
      font-size: 9.4px;
      font-weight: 850;
      color: ${c.ink};
      line-height: 1.34;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .manifest-display-label {
      margin-top: 3px;
      font-size: 8.6px;
      color: ${c.subtle};
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .custody-hash-table th {
      padding: 4px 5px;
      font-size: 6.8px;
      line-height: 1.1;
    }

    .custody-hash-table td {
      padding: 4px 5px;
      font-size: 6.1px;
      line-height: 1.12;
    }

    .custody-hash-table .hash-text {
      font-size: 6.1px;
      line-height: 1.12;
      letter-spacing: -0.02em;
    }

    .hash-text {
      font-size: 7.8px;
      line-height: 1.32;
      color: ${c.ink};
      word-break: break-all;
      overflow-wrap: anywhere;
    }

    .appendix-section {
      padding: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .appendix-section-title {
      margin: 0 0 8px;
      font-size: 10px;
      color: ${c.accent};
      break-after: avoid;
      page-break-after: avoid;
    }

    .technical-status-card {
      padding: 10px;
      min-height: 88px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .technical-status-title {
      font-size: 9.6px;
      font-weight: 850;
      color: ${c.accent};
      line-height: 1.3;
    }

    .technical-status-value {
      font-size: 12px;
      font-weight: 850;
      line-height: 1.25;
    }

    .technical-status-note {
      font-size: 8.7px;
      color: ${c.muted};
      line-height: 1.38;
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

    .bullet-list li span {
      color: ${c.muted};
    }

    .verification-link-panel {
      padding: 10px 11px;
    }

    .verification-link-panel-value {
      margin-top: 5px;
      font-size: 9.2px;
      font-weight: 700;
      line-height: 1.42;
    }

    .mono-block {
      overflow: visible;
    }

    .mono-label {
      padding: 8px 10px;
      background: ${c.accentSoft};
      border-bottom: 1px solid ${c.softLine};
    }

    .mono-value {
      margin: 0;
      padding: 9px 10px;
      font-size: 7.7px;
      line-height: 1.36;
      white-space: pre-wrap;
      color: ${c.ink};
      background: ${c.white};
      word-break: break-all;
      overflow-wrap: anywhere;
    }

    .report-footer-note {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid ${c.line};
      font-size: 8.3px;
      color: ${c.subtle};
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }

    @media print {
      body {
        overflow: visible;
      }

      .report-footer-note {
        position: static;
      }

      .info-cards,
      .kv-grid,
      .technical-status-grid,
      .integrity-control-grid,
      .gallery-support-grid,
      .gallery-secondary-grid,
      .gallery-primary,
      .cover-premium-body,
      .cover-meta-grid,
      .cover-hero-summary,
      .cover-decision-grid,
      .executive-layout {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

      .callout,
      .info-card,
      .kv-item,
      .cover-meta-card,
      .cover-hero-summary-item,
      .cover-decision-indicator,
      .cover-status-panel,
      .gallery-card,
      .gallery-secondary-item,
      .mono-block,
      .technical-status-card,
      .integrity-control-card,
      .verification-link-panel,
      .cover-evidence-panel,
      .cover-verify-box,
      .evidence-strip,
      .timeline-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .report-table,
      table {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

      .report-table thead,
      table thead {
        display: table-header-group !important;
      }

      .report-table tr,
      .report-table td,
      .report-table th {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      p,
      li,
      .callout-body,
      .kv-value,
      .gallery-meta-value,
      .cover-meta-value,
      .cover-status-value,
      .verification-link-panel-value,
      .gallery-thumb-text-body,
      .mono-value,
      .technical-status-note,
      .timeline-summary {
        orphans: 3;
        widows: 3;
      }
    }
  `;
}