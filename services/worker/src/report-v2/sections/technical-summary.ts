/**
 * "Capture Device & Camera Metadata" — a narrow ENRICHMENT appendix.
 *
 * This is NOT a generic media-metadata section. It deliberately does NOT
 * repeat anything already in the report: no evidence type / item count /
 * structure, no "Mixed", no files-analysed, no metadata-complete/partial,
 * no global resolution, no hashes, no EXIF GPS / location (Capture Context
 * owns location), and no network/IP.
 *
 * It shows only the genuinely-enriching device facts:
 *   * Capture Device — "Captured with" (device from EXIF), OS, device
 *     class, submission method, and (for non-camera/desktop uploads) a
 *     little browser/timezone context.
 *   * Camera Metadata — only when the file carried real EXIF: camera,
 *     original capture time, ISO, aperture, shutter/exposure, white
 *     balance, orientation.
 *
 * Smart-rendered: only meaningful rows; the whole block hides when empty;
 * desktop uploads (no EXIF) never show camera rows. Raw firmware build ids
 * are kept out of the PDF (they live in the verification package).
 * BYTE-NEUTRAL when vm.technicalSummary is null.
 */

import { ReportViewModel } from "../types.js";
import { renderCompactKeyValueList, renderPageSection } from "../ui.js";
import {
  humanizeCaptureMethod,
  humanizeUploadSource,
  metadataRows,
} from "@proovra/shared-runtime/technical-metadata";

function orientationLabel(o: number | null): string | null {
  if (o == null) return null;
  // EXIF orientation 1..8 → portrait/landscape (reviewer-friendly).
  return o >= 5 ? "Portrait" : "Landscape";
}

/** Orientation is only worth showing in the PDF when it is NOT the normal
 *  landscape default — i.e. when it carries information (portrait/rotated).
 *  The raw orientation value still lives in the verification package. */
function meaningfulOrientation(o: number | null): string | null {
  return orientationLabel(o) === "Portrait" ? "Portrait" : null;
}

/** White balance is only worth showing when it is NOT the camera default
 *  "Auto". The raw value still lives in the verification package. */
function meaningfulWhiteBalance(wb: string | null): string | null {
  if (!wb) return null;
  return wb.trim().toLowerCase() === "auto" ? null : wb;
}

const MOBILE_DEVICE_CLASSES = new Set(["MOBILE", "PHONE", "TABLET"]);
function isMobileClass(deviceClass: string | null | undefined): boolean {
  return (
    deviceClass != null && MOBILE_DEVICE_CLASSES.has(deviceClass.toUpperCase())
  );
}

export function renderTechnicalSummarySection(vm: ReportViewModel): string {
  const ts = vm.technicalSummary;
  if (!ts) return "";

  const ce = ts.captureEnvironment;
  const exif = ts.exif;
  const hasExif = Boolean(exif && exif.exifPresent);
  const camera = hasExif ? exif!.camera : null;

  // Show Browser when there is no EXIF camera (desktop) OR the upload came
  // from a mobile device-class (mobile browser / intake link) where the
  // browser is genuinely informative even alongside a camera.
  const showBrowser = ce ? !camera || isMobileClass(ce.deviceClass) : false;

  // ---- Capture Device ----
  // "Capture Device" prefers the EXIF camera (the physical capture device);
  // for desktop uploads with no EXIF it is omitted and the row set falls
  // back to the browser/OS context.
  const deviceRows = ce
    ? metadataRows([
        { label: "Capture Device", value: camera },
        {
          label: "Operating system",
          value: ce.osName,
          display: [ce.osName, ce.osVersion].filter(Boolean).join(" ") || undefined,
        },
        { label: "Device", value: ce.deviceClass, display: ce.deviceClass ? titleCase(ce.deviceClass) : undefined },
        { label: "Submitted through", value: humanizeUploadSource(ce.uploadSource) },
        { label: "Capture method", value: humanizeCaptureMethod(ce.captureMethod) },
        ...(showBrowser
          ? [
              {
                label: "Browser",
                value: ce.browserName,
                display: [ce.browserName, ce.browserVersion].filter(Boolean).join(" ") || undefined,
              },
            ]
          : []),
        { label: "Timezone", value: ce.timezone },
      ])
    : [];

  const deviceBlock =
    deviceRows.length > 0
      ? `<h3 class="subsection-title">Capture Device</h3>${renderCompactKeyValueList(deviceRows)}`
      : "";

  // ---- Camera Metadata (only when the file carried real EXIF) ----
  let cameraBlock = "";
  if (hasExif) {
    // Split make/model ONLY when both are reliably available; otherwise the
    // combined "Camera" label is the single reliable device name.
    const make = exif!.cameraMake;
    const model = exif!.cameraModel;
    const cameraRows =
      make && model
        ? [
            { label: "Camera Make", value: make },
            { label: "Camera Model", value: model },
          ]
        : [{ label: "Camera", value: exif!.camera }];

    const rows = metadataRows([
      ...cameraRows,
      { label: "Lens", value: exif!.lensModel },
      { label: "EXIF Original Capture Time", value: exif!.originalCaptureTime },
      { label: "ISO", value: exif!.iso },
      { label: "Aperture", value: exif!.aperture },
      { label: "Shutter / exposure", value: exif!.shutterSpeed ?? exif!.exposureTime },
      { label: "White balance", value: meaningfulWhiteBalance(exif!.whiteBalance) },
      { label: "Orientation", value: meaningfulOrientation(exif!.orientation) },
    ]);
    if (rows.length > 0) {
      cameraBlock = `
        <h3 class="subsection-title">Camera Metadata</h3>
        <p class="muted-note">Embedded in the file by the capturing device. The EXIF Original Capture Time is read from the file itself and is distinct from PROOVRA's submission and preservation timestamps.</p>
        ${renderCompactKeyValueList(rows)}
      `;
    }
  }

  const body = `${deviceBlock}${cameraBlock}`;
  if (body.trim().length === 0) return "";

  return renderPageSection(
    "Capture Device & Camera Metadata",
    `
      <p class="section-intro">Device and camera context for the recorded material. Advisory enrichment for reviewers; it does not change the integrity verdict, and location (where recorded) is shown in the Capture Context above.</p>
      ${body}
    `,
    { className: "technical-summary-section" },
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
