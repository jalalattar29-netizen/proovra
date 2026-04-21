import { REPORT_BRAND } from "../brand.js";

export function getReportCss(): string {
  const c = REPORT_BRAND.colors;

  return `
    @page {
      size: A4;
      margin: 10mm 9mm 10mm 9mm;
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
      font-family: "IBM Plex Sans", "Segoe UI", Arial, Helvetica, sans-serif;
      font-size: 11.2px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      overflow: visible;
    }

    body {
      background:
        radial-gradient(circle at top right, rgba(20, 72, 70, 0.06), transparent 24%),
        linear-gradient(180deg, ${c.paper} 0%, #EEF3F2 100%);
    }

    .report-root {
      width: 100%;
      color: ${c.ink};
    }

    .page-break-before {
      break-before: page;
      page-break-before: always;
    }

    .report-page {
      display: block;
      width: 100%;
      min-height: auto;
      height: auto;
      overflow: visible;
      margin-bottom: 18px;
      break-after: auto;
      page-break-after: auto;
    }

    .report-header-band {
      height: 10px;
      background: linear-gradient(
        90deg,
        ${c.accent} 0%,
        ${c.accentStrong} 52%,
        ${c.accentMetal} 100%
      );
      border-radius: 0 0 10px 10px;
      margin-bottom: 14px;
      box-shadow: 0 8px 18px rgba(13, 28, 31, 0.08);
    }

    .report-cover {
      display: block;
      width: 100%;
      min-height: auto;
      height: auto;
      overflow: visible;
      margin: 0 0 18px;
      break-after: page;
      page-break-after: always;
    }

    .report-cover-premium {
      display: flex;
      align-items: stretch;
      justify-content: center;
    }

    .cover-certificate-card {
      width: 100%;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.996) 0%, rgba(249,251,251,0.995) 100%);
      border: 1px solid ${c.line};
      box-shadow:
        0 16px 36px rgba(13, 28, 31, 0.07),
        inset 0 1px 0 rgba(255,255,255,0.95);
      display: flex;
      flex-direction: column;
      overflow: visible;
      position: relative;
      border-radius: 12px;
      break-inside: avoid-page;
      page-break-inside: avoid;
    }

    .cover-certificate-top {
      position: relative;
      z-index: 1;
      min-height: 62px;
      background: linear-gradient(
        180deg,
        ${c.accent} 0%,
        ${c.accentStrong} 100%
      );
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 12px 18px;
      border-bottom: 2px solid rgba(197, 164, 120, 0.9);
    }

    .cover-brand-lockup {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .cover-brand-mini {
      color: #F5F7F8;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }

    .cover-brand-sub {
      color: rgba(245,247,248,0.82);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .cover-top-badge {
      max-width: 260px;
      justify-content: center;
      text-align: center;
      background: rgba(255,255,255,0.10);
      color: #F5F7F8;
      border: 1px solid rgba(255,255,255,0.18);
    }

    .cover-premium-body {
      position: relative;
      z-index: 1;
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(250px, 0.9fr);
      gap: 20px;
      align-items: start;
      padding: 24px 22px 20px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .cover-left-column {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
    }

    .cover-right-column {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }

    .cover-eyebrow {
      color: ${c.subtle};
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .cover-certificate-title {
      margin: 0;
      font-size: 28px;
      line-height: 1.14;
      font-weight: 900;
      color: ${c.accent};
      letter-spacing: -0.02em;
      word-break: break-word;
    }

    .cover-certificate-subtitle {
      font-size: 13px;
      font-weight: 600;
      color: ${c.muted};
      line-height: 1.5;
      max-width: 96%;
      word-break: break-word;
    }

    .cover-hero-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .cover-hero-summary-item {
      border: 1px solid ${c.softLine};
      background:
        linear-gradient(180deg, rgba(255,255,255,0.996) 0%, rgba(246,248,248,0.994) 100%);
      padding: 11px 12px;
      min-height: 66px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.88);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-hero-summary-label {
      display: block;
      font-size: 9.5px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .cover-hero-summary-value {
      display: block;
      font-size: 12px;
      font-weight: 800;
      color: ${c.ink};
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .cover-evidence-panel {
      border: 1px solid ${c.line};
      background: linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(245,248,248,0.995) 100%);
      box-shadow:
        0 10px 20px rgba(17, 36, 41, 0.04),
        inset 0 1px 0 rgba(255,255,255,0.88);
      display: grid;
      grid-template-columns: 148px minmax(0, 1fr);
      gap: 12px;
      padding: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-evidence-visual {
      min-height: 116px;
      background: linear-gradient(180deg, #F3F7F7 0%, #EEF3F2 100%);
      border: 1px solid ${c.softLine};
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
      background: #F8FAFC;
    }

    .cover-evidence-text {
      padding: 10px;
      align-items: stretch;
      justify-content: flex-start;
      overflow: visible;
    }

    .cover-evidence-text-label {
      font-size: 9px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .cover-evidence-text-body {
      font-size: 9.3px;
      line-height: 1.45;
      color: ${c.ink};
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      orphans: 3;
      widows: 3;
    }

    .cover-evidence-placeholder {
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      text-align: center;
    }

    .cover-evidence-placeholder-kind {
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.04em;
      color: ${c.accent};
    }

    .cover-evidence-placeholder-note {
      font-size: 9px;
      line-height: 1.4;
      color: ${c.muted};
      font-weight: 700;
      orphans: 3;
      widows: 3;
    }

    .cover-evidence-meta {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .cover-evidence-name {
      font-size: 14px;
      font-weight: 900;
      line-height: 1.35;
      color: ${c.accent};
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-evidence-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: ${c.muted};
      font-size: 9.6px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .cover-meta-card {
      border: 1px solid ${c.line};
      background:
        linear-gradient(180deg, rgba(255,255,255,0.996) 0%, rgba(248,250,250,0.995) 100%);
      padding: 12px 13px;
      min-height: 74px;
      box-shadow:
        0 8px 16px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.86);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-meta-card-wide {
      grid-column: 1 / -1;
    }

    .cover-meta-label {
      color: ${c.subtle};
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .cover-meta-value {
      color: ${c.ink};
      font-size: 12px;
      font-weight: 700;
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .cover-meta-value-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9.8px;
      line-height: 1.55;
      word-break: break-all;
      overflow-wrap: anywhere;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 8px 13px;
      font-size: 10px;
      font-weight: 800;
      border: 1px solid transparent;
      width: fit-content;
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .badge-success {
      background: ${c.successSoft};
      color: ${c.success};
      border-color: rgba(33, 117, 93, 0.22);
    }

    .badge-warning {
      background: ${c.warningSoft};
      color: ${c.warning};
      border-color: rgba(138, 106, 47, 0.20);
    }

    .badge-danger {
      background: ${c.dangerSoft};
      color: ${c.danger};
      border-color: rgba(181, 71, 56, 0.18);
    }

    .badge-neutral {
      background: ${c.neutralSoft};
      color: ${c.ink};
      border-color: ${c.line};
    }

    .cover-verify-box {
      width: 100%;
      border: 1px solid ${c.softLine};
      background:
        linear-gradient(180deg, rgba(248,250,250,1) 0%, rgba(243,246,246,1) 100%);
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      padding: 14px;
      gap: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-verify-box-premium {
      min-height: 240px;
    }

    .cover-verify-qr-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .cover-verify-placeholder {
      width: 112px;
      height: 112px;
      border: 1px dashed ${c.line};
      background:
        linear-gradient(180deg, rgba(255,255,255,1) 0%, rgba(246,249,249,1) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${c.subtle};
      font-size: 10px;
      font-weight: 700;
      text-align: center;
      padding: 10px;
    }

    .cover-verify-texts {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .cover-verify-title {
      color: ${c.accent};
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      text-align: center;
    }

    .cover-verify-url {
      color: ${c.subtle};
      font-size: 9px;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .cover-status-panel {
      border: 1px solid ${c.line};
      background: ${c.white};
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.84);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-status-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 10px;
      padding: 11px 12px;
      border-top: 1px solid ${c.softLine};
      align-items: start;
    }

    .cover-status-row:first-child {
      border-top: none;
    }

    .cover-status-name {
      font-size: 9.5px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .cover-status-value {
      font-size: 11px;
      font-weight: 700;
      color: ${c.ink};
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .cover-certificate-bottom {
      min-height: 40px;
      background: linear-gradient(
        180deg,
        ${c.accent} 0%,
        ${c.accentStrong} 100%
      );
      border-top: 2px solid rgba(197, 164, 120, 0.9);
      padding: 0 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
      color: #F4F7F8;
      font-size: 10px;
      font-weight: 700;
    }

    .cover-certificate-bottom-premium {
      position: relative;
      z-index: 1;
      min-height: 46px;
      padding: 10px 16px;
    }

    .cover-certificate-bottom span {
      position: relative;
      white-space: nowrap;
      padding-left: 12px;
      border-left: 1px solid rgba(255,255,255,0.28);
    }

    .cover-certificate-bottom span:first-child {
      padding-left: 0;
      border-left: none;
    }

    .report-section {
      margin-top: 0;
    }

    .report-section.page-break-before {
      padding-top: 0;
    }

    .section-sheet {
      display: block;
      min-height: auto;
      height: auto;
      overflow: visible;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.997) 0%, rgba(249,251,251,0.996) 100%);
      border: 1px solid ${c.line};
      box-shadow:
        0 12px 28px rgba(17, 36, 41, 0.05),
        inset 0 1px 0 rgba(255,255,255,0.92);
      padding: 15px 15px 13px;
      position: relative;
      border-radius: 12px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .section-rule {
      height: 1px;
      background: linear-gradient(90deg, ${c.accent} 0%, ${c.line} 58%, transparent 100%);
      margin: 9px 0 11px;
    }

    .section-title {
      margin: 0;
      font-size: 20px;
      font-weight: 900;
      color: ${c.accent};
      letter-spacing: -0.01em;
      padding-right: 0;
      break-after: avoid;
      page-break-after: avoid;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 9px;
      position: relative;
      z-index: 1;
      break-inside: auto;
      page-break-inside: auto;
    }

    .sheet-footer {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(208, 213, 221, 0.72);
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: ${c.subtle};
      font-size: 8.8px;
      position: relative;
      z-index: 1;
    }

    .callout {
      border: 1px solid ${c.line};
      border-radius: 10px;
      padding: 11px 12px;
      background: ${c.white};
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.84);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .tone-success {
      background: ${c.successSoft};
      border-color: rgba(33, 117, 93, 0.20);
    }

    .tone-warning {
      background: ${c.warningSoft};
      border-color: rgba(138, 106, 47, 0.18);
    }

    .tone-danger {
      background: ${c.dangerSoft};
      border-color: rgba(181, 71, 56, 0.18);
    }

    .tone-neutral {
      background: ${c.neutralSoft};
      border-color: ${c.line};
    }

    .callout-title {
      font-size: 11.6px;
      font-weight: 900;
      margin-bottom: 6px;
      color: ${c.ink};
    }

    .callout-body {
      font-size: 10.6px;
      color: ${c.muted};
      white-space: pre-wrap;
      line-height: 1.56;
      word-break: break-word;
      overflow-wrap: anywhere;
      orphans: 3;
      widows: 3;
    }

    .info-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .info-card {
      border: 1px solid ${c.line};
      border-radius: 10px;
      padding: 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(246,248,248,0.995) 100%);
      min-height: 84px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.84);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .info-card-label {
      font-size: 9.4px;
      font-weight: 900;
      color: ${c.subtle};
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .info-card-value {
      font-size: 13.2px;
      font-weight: 900;
      line-height: 1.34;
      color: ${c.ink};
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .kv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 11px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .kv-item {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(247,249,249,0.995) 100%);
      border: 1px solid ${c.softLine};
      border-radius: 10px;
      padding: 10px 11px;
      min-height: 60px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.88);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .kv-label {
      font-size: 9.3px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .kv-value {
      font-size: 10.9px;
      font-weight: 700;
      line-height: 1.46;
      color: ${c.ink};
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      orphans: 3;
      widows: 3;
    }

    .report-table,
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid ${c.line};
      border-radius: 10px;
      background: ${c.white};
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
      table-layout: fixed;
      break-inside: auto;
      page-break-inside: auto;
    }

    .report-table thead,
    table thead {
      display: table-header-group;
    }

    .report-table tfoot,
    table tfoot {
      display: table-footer-group;
    }

    .report-table thead th {
      background:
        linear-gradient(180deg, ${c.accentSoft} 0%, #EAF3F1 100%);
      color: ${c.accent};
      font-size: 9.1px;
      font-weight: 900;
      text-align: left;
      padding: 8px 9px;
      border-bottom: 1px solid ${c.line};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      vertical-align: top;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-table tbody td {
      padding: 8px 9px;
      font-size: 9.5px;
      color: ${c.ink};
      border-bottom: 1px solid ${c.softLine};
      vertical-align: top;
      line-height: 1.48;
      word-break: break-word;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .report-table tbody tr,
    .report-table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-hash-table th {
      padding: 4px 6px;
      font-size: 7px;
      line-height: 1.15;
    }

    .custody-hash-table td {
      padding: 4px 6px;
      font-size: 7.2px;
      line-height: 1.16;
    }

    .custody-hash-table .hash-text {
      font-size: 6.8px;
      line-height: 1.16;
      letter-spacing: -0.01em;
      word-break: break-all;
      overflow-wrap: anywhere;
    }

    .report-table tbody tr:last-child td {
      border-bottom: none;
    }

    .manifest-file-name {
      font-size: 10.2px;
      font-weight: 900;
      color: ${c.ink};
      line-height: 1.38;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .manifest-display-label {
      margin-top: 4px;
      font-size: 9.3px;
      color: ${c.subtle};
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-lead-note {
      border: 1px solid ${c.line};
      background: linear-gradient(180deg, rgba(255,255,255,0.997) 0%, rgba(247,249,249,0.995) 100%);
      padding: 11px 13px;
      border-radius: 10px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.86);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .gallery-lead-note-title {
      font-size: 9.5px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .gallery-lead-note-body {
      font-size: 12px;
      font-weight: 800;
      color: ${c.ink};
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .gallery-primary {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      align-items: stretch;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-support-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-card {
      border: 1px solid ${c.line};
      background: ${c.white};
      border-radius: 12px;
      overflow: visible;
      display: flex;
      flex-direction: column;
      min-height: auto;
      box-shadow:
        0 10px 20px rgba(17, 36, 41, 0.035),
        inset 0 1px 0 rgba(255,255,255,0.84);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .gallery-card-emphasis {
      min-height: auto;
    }

    .gallery-card-header {
      padding: 11px 12px 9px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(248,250,250,0.996) 100%);
    }

    .gallery-card-topline {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .gallery-card-index {
      font-size: 9.4px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gallery-card-role {
      font-size: 8.9px;
      font-weight: 800;
      color: ${c.accent};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gallery-card-file-name {
      font-size: 13px;
      font-weight: 900;
      color: ${c.accent};
      line-height: 1.34;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-card-display-label {
      font-size: 9.6px;
      color: ${c.subtle};
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-thumb {
      height: 220px;
      background:
        linear-gradient(180deg, #F3F7F7 0%, #EEF3F2 100%);
      border-top: 1px solid ${c.softLine};
      border-bottom: 1px solid ${c.softLine};
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .gallery-thumb-emphasis {
      height: 380px;
    }

    .gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #F8FAFC;
    }

    .gallery-thumb-text {
      align-items: stretch;
      justify-content: stretch;
    }

    .gallery-thumb-text-inner {
      width: 100%;
      height: 100%;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.996) 0%, rgba(247,249,249,0.994) 100%);
    }

    .gallery-thumb-text-title {
      font-size: 9.5px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gallery-thumb-text-body {
      font-size: 9.8px;
      color: ${c.ink};
      line-height: 1.52;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      overflow: hidden;
      orphans: 3;
      widows: 3;
    }

    .gallery-thumb-placeholder {
      padding: 14px;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      justify-content: center;
    }

    .gallery-thumb-placeholder-title {
      font-size: 10.8px;
      color: ${c.accent};
      font-weight: 900;
      letter-spacing: 0.04em;
    }

    .gallery-thumb-placeholder-note {
      font-size: 9.8px;
      color: ${c.muted};
      font-weight: 700;
      line-height: 1.46;
      max-width: 88%;
      orphans: 3;
      widows: 3;
    }

    .gallery-card-meta {
      padding: 11px 12px 13px;
      display: grid;
      gap: 7px;
    }

    .gallery-secondary-list {
      display: grid;
      gap: 9px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-secondary-item {
      border: 1px solid ${c.line};
      background: linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(246,248,248,0.995) 100%);
      padding: 12px;
      border-radius: 10px;
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .gallery-secondary-name {
      font-size: 11.8px;
      font-weight: 900;
      color: ${c.accent};
      line-height: 1.4;
      margin-bottom: 8px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-secondary-grid {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 8px 12px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-meta-row {
      display: grid;
      grid-template-columns: 114px 1fr;
      gap: 10px;
      align-items: start;
      padding-top: 6px;
      border-top: 1px solid ${c.softLine};
    }

    .gallery-meta-row:first-child {
      border-top: none;
      padding-top: 0;
    }

    .gallery-meta-label {
      font-size: 9.2px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gallery-meta-value {
      font-size: 9.8px;
      font-weight: 700;
      color: ${c.ink};
      line-height: 1.46;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .mono-block {
      border: 1px solid ${c.line};
      border-radius: 10px;
      background: ${c.white};
      overflow: visible;
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .mono-label {
      padding: 9px 11px;
      font-size: 9.3px;
      font-weight: 900;
      color: ${c.subtle};
      background: ${c.neutralSoft};
      border-bottom: 1px solid ${c.softLine};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .mono-value {
      margin: 0;
      padding: 11px;
      font-size: 9.5px;
      line-height: 1.54;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: ${c.ink};
      background: linear-gradient(180deg, #FFFFFF 0%, #FAFBFB 100%);
    }

    .hash-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9.15px;
      line-height: 1.55;
      word-break: break-all;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      color: ${c.ink};
    }

    .appendix-section {
      border: 1px solid ${c.line};
      background: linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(247,249,249,0.995) 100%);
      padding: 12px;
      border-radius: 10px;
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
      break-inside: auto;
      page-break-inside: auto;
    }

    .appendix-section-title {
      margin: 0 0 10px;
      font-size: 11.6px;
      font-weight: 900;
      color: ${c.accent};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      break-after: avoid;
      page-break-after: avoid;
    }

    .technical-status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .technical-status-card {
      border: 1px solid ${c.line};
      background:
        linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(247,249,249,0.995) 100%);
      padding: 12px;
      border-radius: 10px;
      min-height: 108px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.88);
      display: flex;
      flex-direction: column;
      gap: 5px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .technical-status-kicker {
      font-size: 9.2px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .technical-status-title {
      font-size: 10.8px;
      font-weight: 900;
      color: ${c.accent};
      line-height: 1.3;
    }

    .technical-status-value {
      font-size: 13.4px;
      font-weight: 900;
      color: ${c.ink};
      line-height: 1.28;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .technical-status-note {
      font-size: 9.3px;
      color: ${c.muted};
      line-height: 1.48;
      margin-top: auto;
      orphans: 3;
      widows: 3;
    }

    .bullet-list {
      margin: 0;
      padding-left: 18px;
      color: ${c.muted};
    }

    .bullet-list li {
      margin: 0 0 6px;
      orphans: 3;
      widows: 3;
    }

    .qr-inline-block {
      border: 1px solid ${c.softLine};
      background: ${c.white};
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px;
      min-width: 132px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.88);
    }

    .qr-inline-block img {
      width: 110px;
      height: 110px;
      object-fit: contain;
      display: block;
      background: white;
    }

    .qr-inline-label {
      font-size: 9.5px;
      color: ${c.subtle};
      font-weight: 800;
      text-align: center;
    }

    .verification-link-panel {
      border: 1px solid ${c.line};
      background:
        linear-gradient(180deg, rgba(255,255,255,0.998) 0%, rgba(247,249,249,0.995) 100%);
      padding: 12px 13px;
      border-radius: 10px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.88);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .verification-link-panel-label {
      font-size: 9.5px;
      font-weight: 900;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .verification-link-panel-value {
      font-size: 10.3px;
      font-weight: 700;
      color: ${c.ink};
      word-break: break-word;
      overflow-wrap: anywhere;
      line-height: 1.48;
      white-space: pre-wrap;
      orphans: 3;
      widows: 3;
    }

    .report-footer-note {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid ${c.line};
      font-size: 9.2px;
      color: ${c.subtle};
      display: flex;
      justify-content: space-between;
      gap: 12px;
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

      .info-cards,
      .kv-grid,
      .technical-status-grid,
      .gallery-support-grid,
      .gallery-secondary-grid,
      .gallery-primary,
      .cover-premium-body,
      .cover-meta-grid,
      .cover-hero-summary {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

      .callout,
      .info-card,
      .kv-item,
      .cover-meta-card,
      .cover-hero-summary-item,
      .cover-status-panel,
      .gallery-lead-note,
      .gallery-card,
      .gallery-secondary-item,
      .mono-block,
      .technical-status-card,
      .verification-link-panel,
      .cover-evidence-panel,
      .cover-verify-box {
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

      .report-table tbody tr,
      .report-table tr,
      .report-table td,
      .report-table th {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .callout-body,
      .kv-value,
      .gallery-meta-value,
      .cover-meta-value,
      .cover-status-value,
      .verification-link-panel-value,
      .gallery-thumb-text-body,
      .mono-value,
      .technical-status-note,
      .cover-evidence-text-body,
      p,
      li {
        orphans: 3;
        widows: 3;
      }
    }

    /*
      Chromium emits PDF shading instructions for CSS gradients that some PDF
      readers/rasterizers render unpredictably. Keep the report visually premium
      with solid, layered surfaces instead of gradient fills.
    */
    body {
      background: ${c.paper} !important;
    }

    .report-header-band,
    .cover-certificate-top,
    .cover-certificate-bottom {
      background: ${c.accent} !important;
    }

    .cover-certificate-card,
    .section-sheet,
    .callout,
    .info-card,
    .kv-item,
    .report-table,
    .gallery-card,
    .gallery-secondary-item,
    .mono-block,
    .appendix-section,
    .technical-status-card,
    .verification-link-panel,
    .cover-evidence-panel,
    .cover-meta-card,
    .cover-hero-summary-item,
    .cover-status-panel,
    .cover-verify-box {
      background: ${c.white} !important;
    }

    .report-table thead th,
    .mono-label {
      background: ${c.accentSoft} !important;
    }

    .gallery-thumb,
    .cover-evidence-visual,
    .qr-inline-block {
      background: ${c.neutralSoft} !important;
    }

    .cover-certificate-card::before,
    .section-sheet::before,
    .section-sheet::after {
      display: none !important;
      content: none !important;
      background: none !important;
    }
  `;
}