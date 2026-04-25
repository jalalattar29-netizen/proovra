import { REPORT_BRAND } from "../brand.js";

export function getReportCss(): string {
  const c = REPORT_BRAND.colors;

  return `
@page {
  size: A4;
  margin: 12mm 10mm 18mm 10mm;
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
  padding-bottom: 8mm;
}

    .page-break-before {
      break-before: page;
      page-break-before: always;
    }

.report-cover {
  width: 100%;
  margin: 0;
  break-after: page;
  page-break-after: always;
}
  
.report-page {
  width: 100%;
  margin-bottom: 10px;
  overflow: visible;
  background: transparent;
}

.section-sheet {
  background: ${c.white};
  border: 1px solid ${c.softLine};
  border-radius: 12px;
  box-shadow: none;
  overflow: visible;
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
      overflow: hidden;
      background: ${c.white};
      border: 1px solid ${c.line};
      border-radius: 0;
      box-shadow: none;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-certificate-top,
    .cover-certificate-bottom {
      background: ${c.accent} !important;
      color: #ffffff;
    }

    .cover-certificate-top {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 13px 18px;
      border-bottom: 2px solid ${c.accentMetal};
    }

    .cover-brand-lockup {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .cover-brand-mini {
      color: #ffffff;
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 0.08em;
    }

    .cover-brand-sub {
      color: rgba(255,255,255,0.84);
      font-size: 9px;
      font-weight: 750;
      letter-spacing: 0.055em;
      text-transform: uppercase;
    }

.cover-premium-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px 12px;
  background: ${c.white};
}

.cover-decision-hero {
  text-align: center;
  padding: 4px 30px 2px;
        break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-eyebrow {
      color: ${c.subtle};
      font-size: 9px;
      font-weight: 850;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .cover-certificate-title {
      margin: 0 auto;
      max-width: 520px;
      font-size: 30px;
      line-height: 1.08;
      font-weight: 950;
      color: ${c.accent};
      letter-spacing: -0.035em;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-certificate-subtitle {
      margin: 9px auto 0;
      max-width: 560px;
      font-size: 11.5px;
      font-weight: 600;
      color: ${c.muted};
      line-height: 1.48;
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
      border-color: rgba(255,255,255,0.22);
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

.cover-status-stamp {
  margin: 12px auto 0;
        display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-width: 210px;
      border-radius: 8px;
      padding: 10px 16px;
      border: 1px solid ${c.softLine};
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .cover-status-stamp span {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.85);
      font-size: 13px;
      font-weight: 950;
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
      border-radius: 8px;
      padding: 10px;
      min-height: 70px;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-decision-mark {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: rgba(255,255,255,0.78);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 950;
    }

    .cover-decision-label {
      font-size: 8.2px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 5px;
    }

    .cover-decision-value {
      font-size: 10.3px;
      font-weight: 900;
      line-height: 1.25;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cover-main-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.42fr) minmax(190px, 0.58fr);
      gap: 12px;
      align-items: stretch;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-panel-title {
      color: ${c.accent};
      font-size: 12px;
      font-weight: 900;
      line-height: 1.3;
      margin-bottom: 8px;
    }

    .cover-evidence-panel {
      display: grid;
      grid-template-columns: 188px minmax(0, 1fr);
      gap: 12px;
      padding: 12px;
      background: ${c.white};
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-evidence-visual {
      min-height: 150px;
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
      object-fit: cover;
      display: block;
      background: #f8fafc;
    }

    .cover-evidence-placeholder {
      flex-direction: column;
      text-align: center;
      padding: 12px;
      gap: 7px;
    }

    .cover-evidence-placeholder-kind {
      font-size: 10px;
      font-weight: 900;
      color: ${c.accent};
      letter-spacing: 0.04em;
    }

    .cover-evidence-placeholder-note {
      font-size: 8.5px;
      color: ${c.muted};
      line-height: 1.35;
      font-weight: 650;
    }

    .cover-evidence-meta {
      min-width: 0;
    }

    .cover-snapshot-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
    }

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

    .cover-meta-card-wide {
      grid-column: 1 / -1;
    }

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

    .cover-meta-card {
      padding: 10px 11px;
      min-height: 56px;
    }

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
      font-size: 10.4px;
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
      font-size: 7.9px;
      line-height: 1.4;
    }

    .cover-verify-box {
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: center;
      gap: 10px;
      min-height: 176px;
      break-inside: avoid;
      page-break-inside: avoid;
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
      font-size: 8.1px;
      line-height: 1.42;
      word-break: break-word;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .cover-boundary-note {
      border: 1px solid ${c.softLine};
      border-left: 4px solid ${c.accentMetal};
      background: ${c.neutralSoft};
      border-radius: 8px;
      padding: 10px 12px;
      color: ${c.muted};
      font-size: 9.4px;
      line-height: 1.48;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .cover-boundary-note strong {
      color: ${c.ink};
      font-weight: 900;
    }

    .cover-certificate-bottom {
      min-height: 42px;
      border-top: 2px solid ${c.accentMetal};
      padding: 10px 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 9px;
      font-weight: 750;
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

    .primary-evidence-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .primary-evidence-card {
      border: 1px solid ${c.line};
      background: ${c.white};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .primary-evidence-preview {
      border: 1px solid ${c.softLine};
      background: ${c.white};
      overflow: hidden;
    }

    .primary-evidence-preview .gallery-thumb {
      height: 300px;
      border-bottom: none;
      background: ${c.neutralSoft};
    }

    .primary-evidence-caption {
      background: ${c.accent};
      color: #ffffff;
      text-align: center;
      padding: 12px 14px;
      font-size: 13px;
      font-weight: 850;
      letter-spacing: 0.01em;
    }

    .primary-evidence-details {
      border: 1px solid ${c.softLine};
      border-top: none;
      padding: 4px 12px 10px;
      background: ${c.white};
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
      background: ${c.white};
      border: 1px solid ${c.softLine};
      border-radius: 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .gallery-card-header {
      padding: 8px 9px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      background: ${c.white};
      border-bottom: 1px solid ${c.softLine};
    }

    .gallery-card-file-name {
      font-size: 11px;
      font-weight: 850;
      color: ${c.accent};
      line-height: 1.25;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-card-role {
      font-size: 8.4px;
      font-weight: 850;
      color: ${c.subtle};
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .gallery-thumb {
      position: relative;
      height: 154px;
      background: ${c.neutralSoft};
      border-bottom: 1px solid ${c.softLine};
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .gallery-thumb-emphasis {
      height: 300px;
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
      padding: 4px 10px 9px;
      display: grid;
      gap: 0;
    }

    .gallery-card-meta-compact {
      padding-top: 4px;
    }

    .gallery-meta-row {
      display: grid;
      grid-template-columns: 82px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 6px 0;
      border-top: 1px solid ${c.softLine};
    }

    .gallery-meta-row:first-child {
      border-top: none;
    }

    .gallery-meta-label {
      color: ${c.subtle};
      font-size: 8.4px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: 0.045em;
    }

    .gallery-meta-value {
      font-size: 8.9px;
      font-weight: 700;
      line-height: 1.35;
      color: ${c.ink};
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .gallery-secondary-list {
      display: grid;
      gap: 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .gallery-secondary-item {
      padding: 10px;
      background: ${c.white};
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      break-inside: avoid;
      page-break-inside: avoid;
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

    .gallery-media-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      pointer-events: none;
      z-index: 2;
    }

    .gallery-media-badge {
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.78);
      color: #ffffff;
      font-size: 8.4px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      border: 1px solid rgba(255,255,255,0.28);
    }

    .gallery-play-icon {
      width: 58px;
      height: 58px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.72);
      border: 1px solid rgba(255,255,255,0.34);
      position: relative;
    }

    .gallery-play-icon::after {
      content: "";
      position: absolute;
      left: 23px;
      top: 17px;
      width: 0;
      height: 0;
      border-top: 12px solid transparent;
      border-bottom: 12px solid transparent;
      border-left: 18px solid #ffffff;
    }

    .gallery-audio-icon {
      width: 72px;
      height: 50px;
      border-radius: 14px;
      background: rgba(10, 44, 38, 0.72);
      border: 1px solid rgba(255,255,255,0.34);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }

    .gallery-audio-icon span {
      width: 5px;
      border-radius: 999px;
      background: #ffffff;
      display: block;
    }

    .gallery-audio-icon span:nth-child(1) { height: 16px; opacity: 0.72; }
    .gallery-audio-icon span:nth-child(2) { height: 28px; opacity: 0.9; }
    .gallery-audio-icon span:nth-child(3) { height: 38px; opacity: 1; }
    .gallery-audio-icon span:nth-child(4) { height: 26px; opacity: 0.86; }
    .gallery-audio-icon span:nth-child(5) { height: 18px; opacity: 0.72; }

    .gallery-document-icon {
      width: 58px;
      height: 70px;
      border-radius: 8px;
      background: rgba(255,255,255,0.92);
      border: 2px solid rgba(10, 44, 38, 0.72);
      position: relative;
      padding: 18px 10px 10px;
      box-shadow: 0 8px 18px rgba(10,44,38,0.16);
    }

    .gallery-document-fold {
      position: absolute;
      top: 0;
      right: 0;
      width: 17px;
      height: 17px;
      background: rgba(10, 44, 38, 0.16);
      border-left: 1px solid rgba(10,44,38,0.32);
      border-bottom: 1px solid rgba(10,44,38,0.32);
      border-radius: 0 6px 0 4px;
    }

    .gallery-document-line {
      display: block;
      height: 4px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.72);
      margin-bottom: 7px;
    }

    .gallery-document-line.short {
      width: 62%;
    }

    .custody-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .custody-stats-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-stat-card {
      border: 1px solid ${c.softLine};
      background: ${c.white};
      border-radius: 9px;
      padding: 10px 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-stat-label {
      color: ${c.subtle};
      font-size: 8.4px;
      font-weight: 900;
      letter-spacing: 0.055em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .custody-stat-value {
      color: ${c.accent};
      font-size: 14px;
      font-weight: 950;
      line-height: 1.2;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .custody-timeline-panel,
    .custody-access-section {
      break-inside: auto;
      page-break-inside: auto;
    }

    .timeline-list {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: 4px 0 4px 0;
      break-inside: auto;
      page-break-inside: auto;
    }

    .timeline-list::before {
      content: "";
      position: absolute;
      left: 18px;
      top: 16px;
      bottom: 16px;
      width: 2px;
      background: ${c.accent};
      opacity: 0.55;
      border-radius: 999px;
    }

    .timeline-card {
      position: relative;
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr);
      gap: 12px;
      padding: 9px 0;
      background: transparent;
      border: none;
      border-radius: 0;
      box-shadow: none;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .timeline-seq {
      position: relative;
      z-index: 2;
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background: ${c.accent};
      color: #ffffff;
      border: 3px solid ${c.white};
      box-shadow: 0 0 0 1px ${c.accentMetal};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 950;
      line-height: 1;
    }

    .timeline-content {
      min-width: 0;
      padding: 3px 0 9px;
      border-bottom: 1px solid ${c.softLine};
    }

    .timeline-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 4px;
    }

    .timeline-event {
      color: ${c.accent};
      font-size: 10.8px;
      font-weight: 950;
      line-height: 1.25;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .timeline-time {
      color: ${c.subtle};
      font-size: 8.3px;
      font-weight: 800;
      text-align: right;
      white-space: nowrap;
    }

    .timeline-summary {
      color: ${c.muted};
      font-size: 9.2px;
      line-height: 1.45;
      font-weight: 650;
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
  padding: 9px 11px;
  background: ${c.accentSoft};
  border-bottom: 1px solid ${c.softLine};
  font-size: 9px;
  font-weight: 950;
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

        .executive-summary-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 100%;
    }

    .executive-confirmation-card {
      border: 1px solid ${c.softLine};
      border-left: 5px solid ${c.accent};
      border-radius: 9px;
      padding: 14px 16px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .executive-confirmation-kicker {
      color: ${c.subtle};
      font-size: 8.6px;
      font-weight: 900;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .executive-confirmation-title {
      color: ${c.accent};
      font-size: 13px;
      font-weight: 900;
      line-height: 1.25;
      margin-bottom: 7px;
    }

    .executive-confirmation-body {
      color: ${c.ink};
      font-size: 10.4px;
      font-weight: 650;
      line-height: 1.58;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .executive-summary-table {
      border: 1px solid ${c.line};
      border-radius: 9px;
      overflow: hidden;
      background: ${c.white};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .executive-summary-row {
      display: grid;
      grid-template-columns: 190px minmax(0, 1fr);
      gap: 14px;
      padding: 10px 12px;
      border-top: 1px solid ${c.softLine};
      align-items: center;
      break-inside: avoid;
      page-break-inside: avoid;
    }

          .executive-confirmation-card,
      .executive-summary-table,
      .executive-summary-row,
      .executive-outcome,
      .executive-legal-boundary {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

    .executive-summary-row:first-child {
      border-top: none;
    }

    .executive-summary-label {
      color: ${c.accent};
      font-size: 9px;
      font-weight: 900;
      letter-spacing: 0.03em;
    }

    .executive-summary-value {
      color: ${c.ink};
      font-size: 10px;
      font-weight: 700;
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .executive-outcome {
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      padding: 12px 14px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .executive-outcome-success {
      background: ${c.successSoft};
      border-color: rgba(33, 117, 93, 0.22);
    }

    .executive-outcome-warning {
      background: ${c.warningSoft};
      border-color: rgba(138, 106, 47, 0.22);
    }

    .executive-outcome-title {
      color: ${c.ink};
      font-size: 11px;
      font-weight: 900;
      margin-bottom: 5px;
    }

    .executive-outcome-body {
      color: ${c.muted};
      font-size: 9.8px;
      font-weight: 650;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .executive-legal-boundary {
      border: 1px solid rgba(138, 106, 47, 0.28);
      border-left: 5px solid ${c.warning};
      border-radius: 9px;
      background: ${c.warningSoft};
      padding: 12px 14px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .executive-legal-title {
      color: ${c.warning};
      font-size: 11px;
      font-weight: 900;
      margin-bottom: 5px;
    }

    .executive-legal-body {
      color: ${c.ink};
      font-size: 9.8px;
      font-weight: 700;
      line-height: 1.52;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

        .gallery-thumb {
      position: relative;
    }

    .gallery-media-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      pointer-events: none;
      z-index: 2;
    }

    .gallery-media-badge {
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.78);
      color: #ffffff;
      font-size: 8.4px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      border: 1px solid rgba(255,255,255,0.28);
    }

    .gallery-play-icon {
      width: 58px;
      height: 58px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.72);
      border: 1px solid rgba(255,255,255,0.34);
      position: relative;
    }

    .gallery-play-icon::after {
      content: "";
      position: absolute;
      left: 23px;
      top: 17px;
      width: 0;
      height: 0;
      border-top: 12px solid transparent;
      border-bottom: 12px solid transparent;
      border-left: 18px solid #ffffff;
    }

    .gallery-audio-icon {
      width: 72px;
      height: 50px;
      border-radius: 14px;
      background: rgba(10, 44, 38, 0.72);
      border: 1px solid rgba(255,255,255,0.34);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }

    .gallery-audio-icon span {
      width: 5px;
      border-radius: 999px;
      background: #ffffff;
      display: block;
    }

    .gallery-audio-icon span:nth-child(1) { height: 16px; opacity: 0.72; }
    .gallery-audio-icon span:nth-child(2) { height: 28px; opacity: 0.9; }
    .gallery-audio-icon span:nth-child(3) { height: 38px; opacity: 1; }
    .gallery-audio-icon span:nth-child(4) { height: 26px; opacity: 0.86; }
    .gallery-audio-icon span:nth-child(5) { height: 18px; opacity: 0.72; }

    .gallery-document-icon {
      width: 58px;
      height: 70px;
      border-radius: 8px;
      background: rgba(255,255,255,0.92);
      border: 2px solid rgba(10, 44, 38, 0.72);
      position: relative;
      padding: 18px 10px 10px;
      box-shadow: 0 8px 18px rgba(10,44,38,0.16);
    }

    .gallery-document-fold {
      position: absolute;
      top: 0;
      right: 0;
      width: 17px;
      height: 17px;
      background: rgba(10, 44, 38, 0.16);
      border-left: 1px solid rgba(10,44,38,0.32);
      border-bottom: 1px solid rgba(10,44,38,0.32);
      border-radius: 0 6px 0 4px;
    }

    .gallery-document-line {
      display: block;
      height: 4px;
      border-radius: 999px;
      background: rgba(10, 44, 38, 0.72);
      margin-bottom: 7px;
    }

    .gallery-document-line.short {
      width: 62%;
    }

    .custody-hash-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .custody-hash-chain-section .section-sheet {
      padding: 16px 16px 13px;
    }

    .custody-hash-chain-table {
      table-layout: fixed;
      border: 1px solid ${c.line};
      background: ${c.white};
    }

    .custody-hash-chain-table th {
      background: ${c.accentSoft};
      color: ${c.accent};
      font-size: 8.2px;
      font-weight: 950;
      letter-spacing: 0.045em;
      text-transform: uppercase;
      padding: 8px 8px;
      line-height: 1.15;
      border-bottom: 1px solid ${c.line};
    }

    .custody-hash-chain-table td {
      padding: 8px 8px;
      font-size: 8.1px;
      line-height: 1.35;
      vertical-align: top;
      border-bottom: 1px solid ${c.softLine};
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .custody-hash-chain-table td:nth-child(1) {
      font-weight: 900;
      color: ${c.accent};
    }

    .custody-hash-chain-table td:nth-child(3) {
      font-weight: 850;
      color: ${c.ink};
    }

.custody-hash-chain-table .hash-text {
  font-size: 9px; /* كان صغير جداً */
  line-height: 1.45;
  letter-spacing: -0.005em;
  font-weight: 650;
  word-break: break-all;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.custody-hash-chain-table td {
  font-size: 8.6px;
  line-height: 1.4;
}
  
        .integrity-summary-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .integrity-summary-intro {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 14px;
      align-items: center;
      border: 1px solid ${c.softLine};
      border-left: 5px solid ${c.accent};
      border-radius: 9px;
      padding: 13px 14px;
      background: ${c.white};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .integrity-summary-kicker {
      color: ${c.subtle};
      font-size: 8.4px;
      font-weight: 900;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .integrity-summary-title {
      color: ${c.accent};
      font-size: 13px;
      font-weight: 950;
      line-height: 1.25;
      margin-bottom: 5px;
    }

    .integrity-summary-copy {
      color: ${c.muted};
      font-size: 9.6px;
      font-weight: 650;
      line-height: 1.48;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .integrity-result-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-width: 176px;
      border-radius: 999px;
      padding: 9px 12px;
      font-size: 8.4px;
      font-weight: 950;
      letter-spacing: 0.045em;
      text-transform: uppercase;
      border: 1px solid ${c.softLine};
      white-space: nowrap;
    }

    .integrity-result-pill span {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.75);
      font-size: 11px;
      font-weight: 950;
    }

    .integrity-result-success {
      background: ${c.successSoft};
      color: ${c.success};
      border-color: rgba(33, 117, 93, 0.25);
    }

    .integrity-result-warning {
      background: ${c.warningSoft};
      color: ${c.warning};
      border-color: rgba(138, 106, 47, 0.28);
    }

    .integrity-check-list {
      border: 1px solid ${c.line};
      border-radius: 9px;
      overflow: hidden;
      background: ${c.white};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .integrity-check-row {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 11px;
      border-top: 1px solid ${c.softLine};
      align-items: start;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .integrity-check-row:first-child {
      border-top: none;
    }

    .integrity-check-mark {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-size: 11px;
      font-weight: 950;
      line-height: 1;
      margin-top: 1px;
    }

    .integrity-check-success .integrity-check-mark {
      background: ${c.success};
    }

    .integrity-check-warning .integrity-check-mark {
      background: ${c.warning};
    }

    .integrity-check-danger .integrity-check-mark {
      background: ${c.danger};
    }

    .integrity-check-neutral .integrity-check-mark {
      background: ${c.accent};
    }

    .integrity-check-content {
      min-width: 0;
    }

    .integrity-check-top {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr);
      gap: 12px;
      align-items: baseline;
      margin-bottom: 3px;
    }

    .integrity-check-label {
      color: ${c.accent};
      font-size: 9.3px;
      font-weight: 950;
      line-height: 1.25;
    }

    .integrity-check-value {
      color: ${c.ink};
      font-size: 9.6px;
      font-weight: 850;
      line-height: 1.3;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .integrity-check-success .integrity-check-value {
      color: ${c.success};
    }

    .integrity-check-warning .integrity-check-value {
      color: ${c.warning};
    }

    .integrity-check-danger .integrity-check-value {
      color: ${c.danger};
    }

    .integrity-check-explanation {
      color: ${c.muted};
      font-size: 8.7px;
      line-height: 1.38;
      font-weight: 650;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .integrity-detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .integrity-detail-card {
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      padding: 9px 10px;
      background: ${c.white};
      min-height: 54px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .integrity-detail-label {
      color: ${c.subtle};
      font-size: 8.2px;
      font-weight: 900;
      letter-spacing: 0.045em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .integrity-detail-value {
      color: ${c.ink};
      font-size: 9.5px;
      font-weight: 750;
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .workflow-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workflow-step {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border: 1px solid ${c.softLine};
  border-radius: 9px;
  background: ${c.white};
  break-inside: avoid;
}

.workflow-step-index {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: ${c.accent};
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  font-size: 10px;
}

.workflow-step-title {
  font-size: 9px;
  font-weight: 900;
  color: ${c.subtle};
  text-transform: uppercase;
  margin-bottom: 2px;
}

.workflow-step-action {
  font-size: 10px;
  font-weight: 800;
  color: ${c.accent};
  margin-bottom: 3px;
}

.workflow-step-result {
  font-size: 9px;
  color: ${c.muted};
  line-height: 1.4;
}

    .technical-appendix-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .technical-access-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      border: 1px solid ${c.softLine};
      border-left: 5px solid ${c.accent};
      border-radius: 9px;
      padding: 12px 14px;
      background: ${c.white};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .technical-access-kicker {
      color: ${c.subtle};
      font-size: 8.4px;
      font-weight: 900;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .technical-access-title {
      color: ${c.accent};
      font-size: 12.5px;
      font-weight: 950;
      margin-bottom: 4px;
    }

    .technical-access-copy {
      color: ${c.muted};
      font-size: 9.4px;
      font-weight: 650;
      line-height: 1.45;
    }

    .technical-access-url {
      border: 1px solid ${c.softLine};
      background: ${c.neutralSoft};
      border-radius: 7px;
      padding: 8px 9px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 7.8px;
      line-height: 1.35;
      word-break: break-all;
      overflow-wrap: anywhere;
      color: ${c.ink};
    }

    .technical-verification-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .technical-verification-card {
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      padding: 10px 11px;
      background: ${c.white};
      min-height: 86px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .technical-verification-kicker {
      color: ${c.subtle};
      font-size: 8.2px;
      font-weight: 900;
      letter-spacing: 0.055em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .technical-verification-title {
      color: ${c.accent};
      font-size: 10px;
      font-weight: 900;
      margin-bottom: 4px;
    }

    .technical-verification-value {
      color: ${c.ink};
      font-size: 12px;
      font-weight: 950;
      line-height: 1.25;
      margin-bottom: 5px;
    }

    .technical-verification-note {
      color: ${c.muted};
      font-size: 8.6px;
      font-weight: 650;
      line-height: 1.35;
    }

    .technical-appendix-block {
      border: 1px solid ${c.softLine};
      border-radius: 10px;
      background: ${c.white};
      overflow: hidden;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .technical-appendix-block-head {
      padding: 10px 12px;
      border-bottom: 1px solid ${c.softLine};
      background: ${c.neutralSoft};
    }

    .technical-appendix-block-title {
      margin: 0 0 4px;
      color: ${c.accent};
      font-size: 12px;
      font-weight: 950;
      line-height: 1.25;
    }

    .technical-appendix-block-subtitle {
      color: ${c.muted};
      font-size: 8.8px;
      font-weight: 650;
      line-height: 1.4;
    }

    .technical-appendix-block-body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .technical-mono-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }

.technical-appendix-section .mono-value {
  font-size: 9.4px;
  line-height: 1.55;
  font-weight: 700;
  letter-spacing: 0.01em;
}

        .legal-interpretation-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .legal-interpretation-hero {
      border: 1px solid ${c.softLine};
      border-left: 5px solid ${c.warning};
      border-radius: 10px;
      padding: 14px 16px;
      background: ${c.warningSoft};
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .legal-interpretation-kicker {
      color: ${c.warning};
      font-size: 8.5px;
      font-weight: 950;
      letter-spacing: 0.075em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .legal-interpretation-title {
      color: ${c.ink};
      font-size: 13.5px;
      font-weight: 950;
      line-height: 1.28;
      margin-bottom: 6px;
    }

    .legal-interpretation-copy {
      color: ${c.ink};
      font-size: 9.8px;
      font-weight: 700;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .legal-interpretation-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .legal-interpretation-card {
      border: 1px solid ${c.softLine};
      border-radius: 10px;
      padding: 12px 13px;
      background: ${c.white};
      min-height: 118px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .legal-interpretation-card-verify {
      border-left: 4px solid ${c.success};
    }

    .legal-interpretation-card-limit {
      border-left: 4px solid ${c.warning};
      background: ${c.warningSoft};
    }

    .legal-interpretation-card-neutral {
      border-left: 4px solid ${c.accent};
    }

    .legal-interpretation-card-title {
      margin: 0 0 7px;
      color: ${c.accent};
      font-size: 11px;
      font-weight: 950;
      line-height: 1.25;
    }

    .legal-interpretation-card-limit .legal-interpretation-card-title {
      color: ${c.warning};
    }

    .legal-interpretation-card-body {
      color: ${c.muted};
      font-size: 9.3px;
      font-weight: 650;
      line-height: 1.48;
      word-break: break-word;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

        .cover-status-subtitle {
      margin: 7px auto 0;
      max-width: 520px;
      color: ${c.muted};
      font-size: 9.7px;
      font-weight: 700;
      line-height: 1.42;
      text-align: center;
      word-break: normal;
      overflow-wrap: normal;
    }

    .cover-verify-hint {
      margin-top: 4px;
      color: ${c.muted};
      font-size: 8.6px;
      font-weight: 750;
      line-height: 1.35;
      text-align: center;
    }

    .cover-verify-url {
      margin-top: 6px;
      color: ${c.subtle};
      font-size: 7.7px;
      line-height: 1.32;
      word-break: break-all;
      overflow-wrap: anywhere;
      text-align: center;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .cover-primary-hash {
      font-size: 8.9px;
      line-height: 1.45;
      letter-spacing: 0.01em;
      color: ${c.ink};
    }

    .cover-boundary-footer {
      margin-top: auto;
      padding: 9px 11px;
      font-size: 8.9px;
      line-height: 1.42;
    }

    .cover-boundary-followup {
      display: block;
      margin-top: 4px;
      color: ${c.ink};
      font-weight: 800;
    }

    .cover-certificate-bottom {
      min-height: 36px;
      padding: 8px 12px;
      font-size: 8.6px;
    }

        .gallery-meta-row-sha {
      grid-template-columns: 82px minmax(0, 1fr);
      align-items: start;
    }

    .gallery-sha-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 8.9px;
      line-height: 1.45;
      font-weight: 850;
      letter-spacing: 0.01em;
      color: ${c.ink};
      word-break: break-all;
      overflow-wrap: anywhere;
      white-space: normal;
      text-align: left;
    }

    .primary-evidence-details .gallery-sha-value {
      font-size: 9.2px;
      line-height: 1.48;
    }

        .custody-lifecycle-summary {
      border: 1px solid ${c.softLine};
      border-left: 5px solid ${c.accent};
      border-radius: 10px;
      background: ${c.neutralSoft};
      padding: 11px 13px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-lifecycle-label {
      color: ${c.accent};
      font-size: 9px;
      font-weight: 950;
      letter-spacing: 0.055em;
      text-transform: uppercase;
      margin-bottom: 7px;
    }

    .custody-lifecycle-flow {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: ${c.ink};
      font-size: 9px;
      font-weight: 850;
      line-height: 1.35;
    }

    .custody-lifecycle-flow span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    .custody-lifecycle-flow span:not(:last-child)::after {
      content: "→";
      color: ${c.subtle};
      font-weight: 900;
      margin-left: 6px;
    }

    .custody-inline-note {
      margin-top: 6px;
      display: inline-block;
      border: 1px solid rgba(138, 106, 47, 0.25);
      border-radius: 999px;
      background: ${c.warningSoft};
      color: ${c.warning};
      padding: 4px 8px;
      font-size: 8px;
      line-height: 1.25;
      font-weight: 850;
    }

    .custody-access-note {
      margin: 8px 0 8px;
      border: 1px solid ${c.softLine};
      border-radius: 8px;
      background: ${c.neutralSoft};
      color: ${c.muted};
      padding: 8px 10px;
      font-size: 8.7px;
      line-height: 1.42;
      font-weight: 650;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-access-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .custody-access-event {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 10px;
      border: 1px solid ${c.softLine};
      border-radius: 9px;
      background: ${c.white};
      padding: 9px 10px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .custody-access-marker {
      align-self: start;
      border: 1px solid ${c.softLine};
      border-radius: 999px;
      background: ${c.neutralSoft};
      color: ${c.subtle};
      padding: 5px 7px;
      font-size: 7.6px;
      font-weight: 950;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      line-height: 1.2;
    }

    .custody-access-content {
      min-width: 0;
    }

    .custody-access-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 10px;
      align-items: baseline;
      margin-bottom: 3px;
    }

    .custody-access-title {
      color: ${c.accent};
      font-size: 10px;
      font-weight: 950;
      line-height: 1.25;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    .custody-access-time {
      color: ${c.subtle};
      font-size: 8px;
      font-weight: 800;
      white-space: nowrap;
      text-align: right;
    }

    .custody-access-summary {
      color: ${c.muted};
      font-size: 8.8px;
      line-height: 1.42;
      font-weight: 650;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    .custody-access-sequence {
      margin-top: 4px;
      color: ${c.subtle};
      font-size: 7.8px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

.print-footer {
  position: fixed;
  left: 10mm;
  right: 10mm;
  bottom: 5mm;
  height: 8mm;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid ${c.softLine};
  color: ${c.subtle};
  font-size: 7.9px;
  font-weight: 750;
  letter-spacing: 0.012em;
  background: ${c.paper};
  z-index: 1000;
}

.print-footer-left,
.print-footer-right {
  display: flex;
  align-items: center;
  min-width: 0;
  white-space: nowrap;
}

.print-footer-brand {
  color: ${c.accent};
  font-weight: 950;
  letter-spacing: 0.06em;
}

.print-footer-divider {
  margin: 0 6px;
  color: ${c.line};
}

    @media print {
      body {
        overflow: visible;
      }

      .info-cards,
      .kv-grid,
      .technical-status-grid,
      .integrity-control-grid,
      .gallery-support-grid,
      .gallery-secondary-grid,
      .gallery-primary,
      .cover-meta-grid,
      .cover-decision-grid,
      .cover-main-grid,
      .executive-layout {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

            .custody-stat-card,
      .timeline-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .callout,
      .info-card,
      .kv-item,
      .cover-meta-card,
      .cover-decision-indicator,
      .gallery-card,
      .gallery-secondary-item,
      .mono-block,
      .technical-status-card,
      .integrity-control-card,
      .verification-link-panel,
      .cover-evidence-panel,
      .cover-verify-box,
      .cover-boundary-note,
      .evidence-strip,
      .timeline-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

            .cover-status-subtitle,
      .cover-boundary-footer,
      .cover-primary-hash {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .report-table,
      table {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }

      .custody-hash-page,
.custody-hash-chain-table {
  break-inside: auto !important;
  page-break-inside: auto !important;
}

      .custody-lifecycle-summary,
      .custody-access-note,
      .custody-access-event,
      .custody-inline-note {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

.custody-hash-chain-table tr {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

      .integrity-summary-intro,
      .integrity-check-list,
      .integrity-check-row,
      .integrity-detail-grid,
      .integrity-detail-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .report-table thead,
      table thead {
        display: table-header-group !important;
      }

            .legal-interpretation-hero,
      .legal-interpretation-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

.report-table tr {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
}

.report-table td,
.report-table th {
  break-inside: auto !important;
  page-break-inside: auto !important;
}

      p,
      li,
      .callout-body,
      .kv-value,
      .gallery-meta-value,
      .cover-meta-value,
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