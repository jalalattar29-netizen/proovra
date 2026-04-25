import { getReportCss } from "./report.css.js";
import { escapeHtml } from "../formatters.js";

export function renderReportShell(params: {
  title: string;
  body: string;
  generatedAtUtc: string;
  version: number;
}): string {
  const versionLabel = escapeHtml(String(params.version));
  const generatedAtUtc = escapeHtml(params.generatedAtUtc);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(params.title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${getReportCss()}</style>
  </head>
  <body>
    <footer class="print-footer" aria-hidden="true">
      <div class="print-footer-left">
        <span class="print-footer-brand">PROOVRA</span>
        <span class="print-footer-divider">•</span>
        <span>Verification Report v${versionLabel}</span>
      </div>
      <div class="print-footer-right">
        Generated UTC: ${generatedAtUtc}
      </div>
    </footer>

    <main class="report-root">
      ${params.body}
    </main>
  </body>
</html>`;
}