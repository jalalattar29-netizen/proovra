import { getReportCss } from "./report.css.js";
import { escapeHtml } from "../formatters.js";

export function renderReportShell(params: {
  title: string;
  body: string;
  generatedAtUtc: string;
  version: number;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(params.title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${getReportCss()}</style>
  </head>
  <body>
    <div class="report-root">
      ${params.body}
      <footer class="report-footer-note">
        <div>PROOVRA • Verification Report v${escapeHtml(String(params.version))}</div>
        <div>Generated (UTC): ${escapeHtml(params.generatedAtUtc)}</div>
      </footer>
    </div>
  </body>
</html>`;
}