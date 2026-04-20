import { signPdfIfEnabled } from "../pdf/signPdf.js";
import type { ReportV2Input, ReportViewModel } from "./types.js";
import { buildReportViewModel } from "./build-view-model.js";
import { renderReportHtml } from "./render-html.js";
import { renderPdfFromHtml } from "./render-pdf.js";

async function buildQrDataUrl(value: string): Promise<string | null> {
  const text = value.trim();
  if (!text) return null;

  try {
    const QRCodeModule = (await import("qrcode")) as {
      toDataURL?: (
        input: string,
        options?: Record<string, unknown>
      ) => Promise<string>;
      default?: {
        toDataURL?: (
          input: string,
          options?: Record<string, unknown>
        ) => Promise<string>;
      };
    };

    const toDataURL =
      QRCodeModule.toDataURL ?? QRCodeModule.default?.toDataURL;

    if (!toDataURL) {
      throw new Error("qrcode.toDataURL not found");
    }

    return await toDataURL(text, {
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
    });
  } catch (error) {
    console.error("[report-v2] Failed to generate QR data URL:", error);
    return null;
  }
}

async function attachQrData(vm: ReportViewModel): Promise<ReportViewModel> {
  const publicDataUrl = vm.qr.publicEnabled
    ? await buildQrDataUrl(vm.verifyUrl)
    : null;

  const technicalDataUrl =
    vm.qr.technicalEnabled && vm.technicalUrl
      ? await buildQrDataUrl(vm.technicalUrl)
      : null;

  return {
    ...vm,
    qr: {
      ...vm.qr,
      publicDataUrl,
      technicalDataUrl,
    },
  };
}

export async function buildReportPdfV2(
  input: ReportV2Input
): Promise<Buffer> {
  const baseVm = await buildReportViewModel(input);
  const vm = await attachQrData(baseVm);
  const html = renderReportHtml(vm);
  const pdf = await renderPdfFromHtml(html);
  return signPdfIfEnabled(pdf);
}