import {
  assertPdfSigningProductionSafetyOrThrow,
  signPdfAndProjectOutcome,
  signPdfIfEnabled,
  type PdfSigningOutcome,
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

/**
 * Phase A2 — Variant that returns the bounded PDF signing outcome
 * alongside the bytes. The worker uses this so the Report row can
 * persist `pdf_signature_status` / `pdf_signed_at_utc` /
 * `pdf_signer_key_id` / `pdf_signing_warning` explicitly.
 *
 * Behaviour parity:
 *   * The production safety assertion still runs first. A misconfigured
 *     production environment fails the job exactly as the legacy
 *     `buildReportPdfV2` path does — no silent unsigned artifact.
 *   * On signing success, the outcome carries the signed bytes and
 *     the metadata to persist.
 *   * On opt-out / unavailable, the outcome carries the unsigned
 *     bytes plus an explicit `warning` string for the API to surface.
 *
 * The legacy `buildReportPdfV2` export is kept for callers that
 * only need the bytes; new code paths consume this variant so the
 * Report row gets the right metadata.
 */
export async function buildReportPdfV2WithSignatureOutcome(
  input: ReportV2Input,
): Promise<PdfSigningOutcome> {
  assertPdfSigningProductionSafetyOrThrow();

  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  const pdf = await renderPdfFromHtml(html);
  return signPdfAndProjectOutcome(pdf);
}