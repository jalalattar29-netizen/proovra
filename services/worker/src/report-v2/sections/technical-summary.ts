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
  captureMethodDisplayLabel,
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

  // No camera EXIF → do NOT spend a whole standalone page on a few device
  // rows. Those rows are shown as a compact "Capture Device" mini-table
  // inside the Executive Summary instead (renderCaptureDeviceMini). This
  // section is byte-neutral in the no-EXIF case.
  if (!hasExif) return "";

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
        {
          label: "Capture method",
          value: captureMethodDisplayLabel({
            captureMethod: ce.captureMethod,
            uploadSource: ce.uploadSource,
          }),
        },
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

  const deviceBlock = renderGroup("Capture Device", deviceRows);

  // ---- Camera + Exposure (only when the file carried real EXIF) ----
  let cameraBlock = "";
  let exposureBlock = "";
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

    cameraBlock = renderGroup(
      "Camera",
      metadataRows([
        ...cameraRows,
        { label: "Lens", value: exif!.lensModel },
        { label: "EXIF Original Capture Time", value: exif!.originalCaptureTime },
        { label: "Orientation", value: meaningfulOrientation(exif!.orientation) },
      ]),
    );

    exposureBlock = renderGroup(
      "Exposure",
      metadataRows([
        { label: "ISO", value: exif!.iso },
        { label: "Aperture", value: exif!.aperture },
        { label: "Shutter / exposure", value: exif!.shutterSpeed ?? exif!.exposureTime },
        { label: "White balance", value: meaningfulWhiteBalance(exif!.whiteBalance) },
      ]),
    );
  }

  const groups = [deviceBlock, cameraBlock, exposureBlock].filter(Boolean);
  if (groups.length === 0) return "";

  // Multiple compact tables in a balanced 2-column grid — dense, single
  // page, no wasted whitespace, no table split (rows are break-inside:avoid).
  const grid = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start;margin-top:10px">${groups.join("")}</div>`;

  // Multi-file transparency: the PDF shows one representative item's EXIF;
  // every item's EXIF is in the verification package.
  const representativeNote =
    hasExif && (ts.mediaFilesTotal ?? 1) > 1
      ? `<p class="muted-note">Representative EXIF shown (Primary Media Item). Per-file EXIF for all ${ts.mediaFilesTotal} media items is included in the verification package (technical-metadata/exif-details.json).</p>`
      : "";

  const captureTimeNote = hasExif
    ? `<p class="muted-note">Camera metadata is embedded in the file by the capturing device. The EXIF Original Capture Time is read from the file itself and is distinct from PROOVRA's submission and preservation timestamps.</p>`
    : "";

  return renderPageSection(
    "Technical Summary",
    `
      <p class="section-intro">Device and camera context for the recorded material. Advisory enrichment for reviewers; it does not change the integrity verdict, and location (where recorded) is shown in the Capture Context above.</p>
      ${representativeNote}
      ${captureTimeNote}
      ${grid}
    `,
    { className: "technical-summary-section" },
  );
}

/** Render one titled compact table, or "" when it has no meaningful rows. */
function renderGroup(
  title: string,
  rows: Array<{ label: string; value: string }>,
): string {
  if (rows.length === 0) return "";
  return `<div class="technical-summary-group"><h3 class="subsection-title">${title}</h3>${renderCompactKeyValueList(rows)}</div>`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
