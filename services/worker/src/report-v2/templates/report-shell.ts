// D:\digital-witness\services\worker\src\report-v2\templates\report-shell.ts
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

      :root {
        --proovra-paper-silver: url("${paperUrl}");
      }

      .print-footer {
        display: none !important;
      }
    </style>
  </head>
  <body>
    <main
      class="report-root"
      data-report-version="${versionLabel}"
      data-generated-date-utc="${generatedDateUtc}"
    >
      ${params.body}
    </main>
  </body>
</html>`;
}