import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getReportCss } from "./report.css.js";
import { escapeHtml } from "../formatters.js";

function resolveReportAssetUrl(fileName: string): string {
  const distPath = path.resolve(process.cwd(), "dist/report-v2/assets", fileName);
  const srcPath = path.resolve(process.cwd(), "src/report-v2/assets", fileName);

  const finalPath = fs.existsSync(distPath) ? distPath : srcPath;
  return pathToFileURL(finalPath).href;
}

function formatGeneratedDateUtc(value: string): string {
  const raw = value.trim();
  if (!raw) return "Not recorded";

  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return dateOnly?.[1] ?? raw;
}

export function renderReportShell(params: {
  title: string;
  body: string;
  generatedAtUtc: string;
  version: number;
}): string {
  const title = escapeHtml(params.title);
  const versionLabel = escapeHtml(String(params.version));
  const generatedAtUtc = escapeHtml(params.generatedAtUtc);
  const generatedDateUtc = escapeHtml(formatGeneratedDateUtc(params.generatedAtUtc));
  const paperUrl = escapeHtml(resolveReportAssetUrl("paper-silver.png"));

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="proovra-report-version" content="${versionLabel}" />
    <meta name="proovra-report-generated-at" content="${generatedAtUtc}" />
    <meta name="proovra-report-generated-date" content="${generatedDateUtc}" />
    <style>
      ${getReportCss()}

      html,
      body,
      .report-root,
      .report-page {
        background-color: #f5f6f5 !important;
        background-image: url("${paperUrl}") !important;
        background-size: cover !important;
        background-repeat: repeat !important;
        background-position: center top !important;
      }

.section-sheet,
.cover-certificate-card,
.cover-premium-body,
.technical-appendix-block,
.callout,
.kv-item,
.info-card,
.mono-block,
.workflow-step,
.custody-stat-card,
.custody-access-event,
.integrity-detail-card,
.integrity-check-list,
.executive-summary-table,
.executive-confirmation-card,
.executive-outcome,
.technical-verification-card,
.technical-access-panel,
.legal-interpretation-card,
.report-table,
table {
  background: transparent !important;
  background-image: none !important;
}

.report-table th,
table th,
.mono-label,
.technical-appendix-block-head {
  background: rgba(255, 255, 255, 0.06) !important;
}
  
      .section-kicker,
      .print-footer-brand {
        color: #9b9d9d !important;
      }

      .report-brand-icon,
      .print-footer-icon {
        display: inline-block;
        object-fit: contain;
        vertical-align: middle;
      }

      .report-brand-icon {
        width: 15px;
        height: 15px;
        margin-right: 6px;
      }

      .print-footer-icon {
        width: 12px;
        height: 12px;
        margin-right: 5px;
      }

      .cover-verify-url {
        color: #10201d !important;
        opacity: 0.94 !important;
        font-weight: 850 !important;
      }

      .print-footer {
        display: none !important;
      }
    </style>
  </head>
  <body>
    <main class="report-root" data-report-version="${versionLabel}" data-generated-date-utc="${generatedDateUtc}">
      ${params.body}
    </main>
  </body>
</html>`;
}