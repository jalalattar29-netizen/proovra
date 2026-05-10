import {
  assertPdfSigningProductionSafetyOrThrow,
  signPdfIfEnabled,
} from "../pdf/signPdf.js";
import type { ReportV2Input } from "./types.js";
import { buildReportViewModel } from "./build-view-model.js";
import { renderReportHtml } from "./render-html.js";
import { renderPdfFromHtml } from "./render-pdf.js";

export async function buildReportPdfV2(
  input: ReportV2Input
): Promise<Buffer> {
  // Issue #11: refuse to silently emit unsigned PDFs in production unless the
  // operator has explicitly acknowledged the unsigned-artifact path. Throwing
  // here surfaces the problem on the worker queue with a clear error message
  // rather than producing a misleading "signed report"-shaped artifact.
  assertPdfSigningProductionSafetyOrThrow();

  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  const pdf = await renderPdfFromHtml(html);
  return signPdfIfEnabled(pdf);
}