export function getReportCss(): string {
  return `
    @page {
      size: A4;
      margin: 18mm 14mm 18mm 14mm;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #F8FAFC;
      color: #101828;
      font-family: Inter, Arial, Helvetica, sans-serif;
      font-size: 12px;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      background: #F8FAFC;
    }

    .report-root {
      width: 100%;
      color: #101828;
    }

    .page-break-before {
      break-before: page;
      page-break-before: always;
    }

    .report-header-band {
      height: 8px;
      background: linear-gradient(90deg, #153B67 0%, #28598E 100%);
      border-radius: 0 0 8px 8px;
      margin-bottom: 20px;
    }

    .report-cover {
      min-height: 240px;
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 24px;
      align-items: start;
      margin-bottom: 18px;
    }

    .brand-lockup {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .brand-name {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: 0.04em;
      color: #153B67;
    }

    .brand-report-title {
      font-size: 18px;
      font-weight: 700;
      color: #101828;
    }

    .brand-tagline {
      font-size: 12px;
      color: #475467;
    }

    .cover-title {
      margin-top: 18px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 800;
      color: #101828;
    }

    .cover-subtitle {
      margin-top: 8px;
      font-size: 13px;
      color: #475467;
      max-width: 90%;
    }

    .cover-side {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: stretch;
    }

    .cover-panel {
      background: #FFFFFF;
      border: 1px solid #D0D5DD;
      border-radius: 18px;
      padding: 16px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid transparent;
      width: fit-content;
    }

    .badge-success {
      background: #ECFDF3;
      color: #0F6B4F;
      border-color: #ABEFC6;
    }

    .badge-warning {
      background: #FFFAEB;
      color: #9A6700;
      border-color: #FEDF89;
    }

    .badge-danger {
      background: #FEF3F2;
      color: #B42318;
      border-color: #FECDCA;
    }

    .badge-neutral {
      background: #F2F4F7;
      color: #344054;
      border-color: #D0D5DD;
    }

    .report-section {
      margin-top: 26px;
    }

    .section-rule {
      height: 1px;
      background: #D0D5DD;
      margin-bottom: 10px;
    }

    .section-title {
      margin: 0 0 12px;
      font-size: 18px;
      font-weight: 800;
      color: #101828;
      letter-spacing: -0.01em;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .callout {
      border: 1px solid #D0D5DD;
      border-radius: 16px;
      padding: 14px 16px;
      background: #FFFFFF;
    }

    .tone-success {
      background: #ECFDF3;
      border-color: #ABEFC6;
    }

    .tone-warning {
      background: #FFFAEB;
      border-color: #FEDF89;
    }

    .tone-danger {
      background: #FEF3F2;
      border-color: #FECDCA;
    }

    .tone-neutral {
      background: #F8FAFC;
      border-color: #D0D5DD;
    }

    .callout-title {
      font-size: 13px;
      font-weight: 800;
      margin-bottom: 6px;
      color: #101828;
    }

    .callout-body {
      font-size: 12px;
      color: #344054;
      white-space: pre-wrap;
    }

    .info-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .info-card {
      border: 1px solid #D0D5DD;
      border-radius: 16px;
      padding: 14px;
      background: #FFFFFF;
      min-height: 96px;
    }

    .info-card-label {
      font-size: 11px;
      font-weight: 700;
      color: #667085;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .info-card-value {
      font-size: 16px;
      font-weight: 800;
      line-height: 1.35;
      color: #101828;
    }

    .kv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 16px;
    }

    .kv-item {
      background: #FFFFFF;
      border: 1px solid #EAECF0;
      border-radius: 14px;
      padding: 12px 14px;
      min-height: 74px;
    }

    .kv-label {
      font-size: 10px;
      font-weight: 700;
      color: #667085;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 7px;
    }

    .kv-value {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.45;
      color: #101828;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .report-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid #D0D5DD;
      border-radius: 16px;
      overflow: hidden;
      background: #FFFFFF;
    }

    .report-table thead th {
      background: #EEF4FF;
      color: #344054;
      font-size: 10px;
      font-weight: 800;
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid #D0D5DD;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      vertical-align: top;
    }

    .report-table tbody td {
      padding: 12px;
      font-size: 11px;
      color: #101828;
      border-bottom: 1px solid #EAECF0;
      vertical-align: top;
      line-height: 1.5;
      word-break: break-word;
    }

    .report-table tbody tr:last-child td {
      border-bottom: none;
    }

    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }

    .gallery-card {
      border: 1px solid #D0D5DD;
      background: #FFFFFF;
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 220px;
    }

    .gallery-card-header {
      padding: 12px 12px 8px;
      font-size: 12px;
      font-weight: 800;
      color: #101828;
    }

    .gallery-thumb {
      height: 118px;
      background: #F2F4F7;
      border-top: 1px solid #EAECF0;
      border-bottom: 1px solid #EAECF0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
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
      color: #475467;
      font-weight: 700;
    }

    .gallery-card-meta {
      padding: 10px 12px 12px;
      font-size: 10px;
      color: #667085;
      line-height: 1.5;
    }

    .hero-evidence {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 16px;
      align-items: start;
      border: 1px solid #D0D5DD;
      border-radius: 18px;
      background: #FFFFFF;
      overflow: hidden;
    }

    .hero-preview {
      min-height: 260px;
      background: #F8FAFC;
      display: flex;
      align-items: center;
      justify-content: center;
      border-right: 1px solid #EAECF0;
      overflow: hidden;
    }

    .hero-preview img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .hero-meta {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .hero-title {
      font-size: 17px;
      font-weight: 800;
      color: #101828;
    }

    .hero-note {
      font-size: 12px;
      color: #475467;
      line-height: 1.6;
    }

    .mono-block {
      border: 1px solid #D0D5DD;
      border-radius: 14px;
      background: #FFFFFF;
      overflow: hidden;
    }

    .mono-label {
      padding: 10px 12px;
      font-size: 10px;
      font-weight: 800;
      color: #667085;
      background: #F8FAFC;
      border-bottom: 1px solid #EAECF0;
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
      color: #101828;
    }

    .bullet-list {
      margin: 0;
      padding-left: 18px;
      color: #344054;
    }

    .bullet-list li {
      margin: 0 0 6px;
    }

    .report-footer-note {
      margin-top: 18px;
      padding-top: 10px;
      border-top: 1px solid #D0D5DD;
      font-size: 10px;
      color: #667085;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
  `;
}