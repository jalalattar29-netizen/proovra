import { signPdfIfEnabled } from "../pdf/signPdf.js";
import type { ReportV2Input } from "./types.js";
import { buildReportViewModel } from "./build-view-model.js";
import { renderReportHtml } from "./render-html.js";
import { renderPdfFromHtml } from "./render-pdf.js";

export async function buildReportPdfV2(
  input: ReportV2Input
): Promise<Buffer> {
  const vm = buildReportViewModel(input);
  const html = renderReportHtml(vm);
  const pdf = await renderPdfFromHtml(html);
  return signPdfIfEnabled(pdf);
}