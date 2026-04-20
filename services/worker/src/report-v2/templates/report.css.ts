import { REPORT_BRAND } from "../brand.js";

export function getReportCss(): string {
  const c = REPORT_BRAND.colors;

  return `
    @page {
      size: A4;
      margin: 14mm 11mm 14mm 11mm;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: ${c.paper};
      color: ${c.ink};
      font-family: Inter, Arial, Helvetica, sans-serif;
      font-size: 12px;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      background:
        radial-gradient(circle at top right, rgba(20, 72, 70, 0.05), transparent 22%),
        linear-gradient(180deg, ${c.paper} 0%, #F1F5F4 100%);
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
      min-height: calc(297mm - 28mm);
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }

    .report-header-band {
      height: 10px;
      background: linear-gradient(
        90deg,
        ${c.accent} 0%,
        ${c.accentStrong} 48%,
        ${c.accentMetal} 100%
      );
      border-radius: 0 0 8px 8px;
      margin-bottom: 16px;
      box-shadow: 0 8px 18px rgba(13, 28, 31, 0.08);
    }

    .report-cover {
      min-height: calc(297mm - 42mm);
      display: block;
      margin: 0;
    }

    .report-cover-certificate {
      display: flex;
      align-items: stretch;
      justify-content: center;
    }

    .cover-certificate-card {
      width: 100%;
      min-height: calc(297mm - 46mm);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.995) 0%, rgba(250,251,251,0.995) 100%);
      border: 1px solid ${c.line};
      box-shadow:
        0 14px 34px rgba(13, 28, 31, 0.06),
        inset 0 1px 0 rgba(255,255,255,0.94);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    .cover-certificate-top {
      height: 46px;
      background: linear-gradient(
        180deg,
        ${c.accent} 0%,
        ${c.accentStrong} 100%
      );
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 0 18px;
      border-bottom: 2px solid rgba(197, 164, 120, 0.9);
    }

    .cover-brand-mini {
      color: #F5F7F8;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.05em;
    }

    .cover-certificate-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      text-align: center;
      padding: 38px 34px 24px;
    }

    .cover-certificate-title {
      font-size: 25px;
      line-height: 1.18;
      font-weight: 800;
      color: ${c.accent};
      letter-spacing: -0.01em;
      text-transform: uppercase;
      max-width: 72%;
    }

    .cover-certificate-divider {
      width: 72%;
      height: 1px;
      background: ${c.line};
      margin: 20px 0 18px;
    }

    .cover-certificate-subtitle {
      font-size: 15px;
      font-weight: 800;
      color: ${c.accentStrong};
      line-height: 1.4;
      max-width: 76%;
      margin-bottom: 26px;
    }

    .cover-status-wrap {
      display: flex;
      justify-content: center;
      margin-bottom: 24px;
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

    .cover-meta-stack {
      width: 100%;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
    }

    .cover-meta-line {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: center;
    }

    .cover-meta-label {
      color: ${c.subtle};
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .cover-meta-value {
      color: ${c.ink};
      font-size: 12px;
      font-weight: 700;
      word-break: break-word;
    }

    .cover-verify-box {
      width: 100%;
      max-width: 220px;
      min-height: 132px;
      border: 1px solid ${c.softLine};
      background:
        linear-gradient(180deg, rgba(248,250,250,1) 0%, rgba(243,246,246,1) 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 14px;
      gap: 10px;
      margin-bottom: 20px;
    }

    .cover-verify-placeholder {
      width: 88px;
      height: 88px;
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

    .cover-verify-title {
      color: ${c.accent};
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .cover-verify-url {
      color: ${c.subtle};
      font-size: 9px;
      line-height: 1.45;
      word-break: break-word;
      text-align: center;
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

    .cover-certificate-bottom span {
      position: relative;
      white-space: nowrap;
    }

    .cover-certificate-bottom span:not(:last-child)::after {
      content: "";
      position: absolute;
      right: -7px;
      top: 50%;
      width: 1px;
      height: 11px;
      background: rgba(255,255,255,0.35);
      transform: translateY(-50%);
    }

    .report-section {
      margin-top: 0;
    }

    .report-section.page-break-before {
      padding-top: 0;
    }

    .section-sheet {
      min-height: calc(297mm - 44mm);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.995) 0%, rgba(249,251,251,0.995) 100%);
      border: 1px solid ${c.line};
      box-shadow:
        0 12px 28px rgba(17, 36, 41, 0.05),
        inset 0 1px 0 rgba(255,255,255,0.9);
      padding: 18px 18px 16px;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .section-sheet::after {
      content: "PROOVRA";
      position: absolute;
      top: 18px;
      right: 20px;
      font-size: 12px;
      font-weight: 800;
      color: ${c.accent};
      letter-spacing: 0.04em;
    }

    .section-rule {
      height: 1px;
      background: linear-gradient(90deg, ${c.accent} 0%, ${c.line} 60%, transparent 100%);
      margin: 10px 0 12px;
    }

    .section-title {
      margin: 0;
      font-size: 18px;
      font-weight: 800;
      color: ${c.accent};
      letter-spacing: -0.01em;
      padding-right: 90px;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex: 1;
    }

    .sheet-footer {
      margin-top: auto;
      padding-top: 16px;
      border-top: 1px solid rgba(208, 213, 221, 0.7);
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: ${c.subtle};
      font-size: 9px;
    }

    .callout {
      border: 1px solid ${c.line};
      border-radius: 0;
      padding: 12px 14px;
      background: ${c.white};
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.82);
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
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 6px;
      color: ${c.ink};
    }

    .callout-body {
      font-size: 11px;
      color: ${c.muted};
      white-space: pre-wrap;
      line-height: 1.55;
    }

    .info-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .info-card {
      border: 1px solid ${c.line};
      border-radius: 0;
      padding: 14px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(246,248,248,0.99) 100%);
      min-height: 92px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.84);
    }

    .info-card-label {
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .info-card-value {
      font-size: 15px;
      font-weight: 800;
      line-height: 1.35;
      color: ${c.ink};
    }

    .kv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 14px;
    }

    .kv-item {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.995) 0%, rgba(247,249,249,0.995) 100%);
      border: 1px solid ${c.softLine};
      border-radius: 0;
      padding: 11px 12px;
      min-height: 68px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.86);
    }

    .kv-label {
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }

    .kv-value {
      font-size: 12px;
      font-weight: 700;
      line-height: 1.45;
      color: ${c.ink};
      white-space: pre-wrap;
      word-break: break-word;
    }

    .report-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid ${c.line};
      border-radius: 0;
      overflow: hidden;
      background: ${c.white};
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
    }

    .report-table thead th {
      background:
        linear-gradient(180deg, ${c.accentSoft} 0%, #EAF3F1 100%);
      color: ${c.accent};
      font-size: 10px;
      font-weight: 800;
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid ${c.line};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      vertical-align: top;
    }

    .report-table tbody td {
      padding: 11px 12px;
      font-size: 10.5px;
      color: ${c.ink};
      border-bottom: 1px solid ${c.softLine};
      vertical-align: top;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .report-table tbody tr:last-child td {
      border-bottom: none;
    }

    .manifest-file-name {
      font-size: 11px;
      font-weight: 800;
      color: ${c.ink};
      line-height: 1.4;
    }

    .manifest-display-label {
      margin-top: 4px;
      font-size: 10px;
      color: ${c.subtle};
      line-height: 1.45;
    }

    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .gallery-grid-single {
      grid-template-columns: 1fr;
    }

    .gallery-card {
      border: 1px solid ${c.line};
      background: ${c.white};
      border-radius: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 260px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.82);
    }

    .gallery-card-emphasis {
      min-height: 420px;
    }

    .gallery-card-header {
      padding: 12px 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .gallery-card-index {
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .gallery-card-file-name {
      font-size: 14px;
      font-weight: 800;
      color: ${c.accent};
      line-height: 1.35;
      word-break: break-word;
    }

    .gallery-card-display-label {
      font-size: 10px;
      color: ${c.subtle};
      line-height: 1.45;
      word-break: break-word;
    }

    .gallery-thumb {
      height: 180px;
      background:
        linear-gradient(180deg, #F4F7F7 0%, #EEF3F2 100%);
      border-top: 1px solid ${c.softLine};
      border-bottom: 1px solid ${c.softLine};
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .gallery-thumb-emphasis {
      height: 280px;
    }

    .gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #F8FAFC;
    }

    .gallery-thumb-placeholder {
      padding: 12px;
      text-align: center;
      font-size: 11px;
      color: ${c.muted};
      font-weight: 700;
    }

    .gallery-card-meta {
      padding: 12px 14px 14px;
      display: grid;
      gap: 8px;
    }

    .gallery-meta-row {
      display: grid;
      grid-template-columns: 92px 1fr;
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
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .gallery-meta-value {
      font-size: 10.5px;
      font-weight: 700;
      color: ${c.ink};
      line-height: 1.45;
      word-break: break-word;
    }

    .mono-block {
      border: 1px solid ${c.line};
      border-radius: 0;
      background: ${c.white};
      overflow: hidden;
      box-shadow: 0 8px 18px rgba(17, 36, 41, 0.03);
    }

    .mono-label {
      padding: 10px 12px;
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      background: ${c.neutralSoft};
      border-bottom: 1px solid ${c.softLine};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .mono-value {
      margin: 0;
      padding: 12px;
      font-size: 10px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: ${c.ink};
      background: linear-gradient(180deg, #FFFFFF 0%, #FAFBFB 100%);
    }

    .technical-status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .technical-status-card {
      border: 1px solid ${c.line};
      background:
        linear-gradient(180deg, rgba(255,255,255,0.995) 0%, rgba(247,249,249,0.995) 100%);
      padding: 14px;
      min-height: 118px;
      box-shadow:
        0 8px 18px rgba(17, 36, 41, 0.03),
        inset 0 1px 0 rgba(255,255,255,0.86);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .technical-status-kicker {
      font-size: 10px;
      font-weight: 800;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .technical-status-title {
      font-size: 12px;
      font-weight: 800;
      color: ${c.accent};
      line-height: 1.3;
    }

    .technical-status-value {
      font-size: 15px;
      font-weight: 800;
      color: ${c.ink};
      line-height: 1.3;
    }

    .technical-status-note {
      font-size: 10px;
      color: ${c.muted};
      line-height: 1.5;
      margin-top: auto;
    }

    .bullet-list {
      margin: 0;
      padding-left: 18px;
      color: ${c.muted};
    }

    .bullet-list li {
      margin: 0 0 6px;
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
    }

    .qr-inline-block img {
      width: 96px;
      height: 96px;
      object-fit: contain;
      display: block;
      background: white;
    }

    .qr-inline-label {
      font-size: 10px;
      color: ${c.subtle};
      font-weight: 700;
      text-align: center;
    }

    .report-footer-note {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid ${c.line};
      font-size: 10px;
      color: ${c.subtle};
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    @media print {
      .report-footer-note {
        position: static;
      }
    }
  `;
}