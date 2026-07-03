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
import { renderFieldGrid, renderPageSection } from "../ui.js";
import { formatDeviceTime } from "@proovra/shared";
import {
  captureMethodDisplayLabel,
  humanizeUploadSource,
  metadataRows,
} from "@proovra/shared-runtime/technical-metadata";

/** EXIF Original Capture Time is DEVICE time — never a server UTC timestamp.
 *  Formatted with offset when present, else marked "time zone unavailable"
 *  (never converted, never given an invented Z). */
function exifCaptureTimeRow(
  originalCaptureTime: string | null,
): { label: string; value: string | null } {
  const dt = formatDeviceTime(originalCaptureTime);
  if (!dt) return { label: "EXIF Original Capture Time", value: originalCaptureTime };
  return {
    label: dt.note
      ? `EXIF Original Capture Time — ${dt.note}`
      : "EXIF Original Capture Time",
    value: dt.formatted,
  };
}

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

type TechnicalSummaryBlocks = {
  /** Stacked titled field-card grids, or "" when there is no content. */
  groupsHtml: string;
  /** True only when a real capture-environment device group is present. */
  hasDeviceRows: boolean;
  /** True when any group (device/camera/exposure) rendered. */
  hasContent: boolean;
  /** Total media items analysed — drives the "representative EXIF" note. */
  mediaFilesTotal: number;
};

/** Build the Technical Summary field-card grids once, so BOTH the standalone
 *  page and the compact Technical-Appendix fallback share identical content
 *  and there is no duplicate markup. */
function buildTechnicalSummaryBlocks(vm: ReportViewModel): TechnicalSummaryBlocks {
  const empty: TechnicalSummaryBlocks = {
    groupsHtml: "",
    hasDeviceRows: false,
    hasContent: false,
    mediaFilesTotal: 1,
  };
  const ts = vm.technicalSummary;
  if (!ts) return empty;

  const ce = ts.captureEnvironment;
  const exif = ts.exif;
  const hasExif = Boolean(exif && exif.exifPresent);
  const camera = hasExif ? exif!.camera : null;

  // No camera EXIF → byte-neutral (device-only context lives as a compact
  // Capture Device mini in the Executive Summary for non-intake).
  if (!hasExif) return empty;

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
        exifCaptureTimeRow(exif!.originalCaptureTime),
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
  if (groups.length === 0) return empty;

  // Stacked titled field-card grids (each group is itself a two-column
  // field-card grid — same enterprise style as the Executive Summary). Cards
  // are break-inside:avoid and the grids flow cleanly across a page break,
  // so there is no clipped row, no half-split table, and no footer overlap.
  const grid = `<div class="technical-summary-groups">${groups.join("")}</div>`;

  return {
    groupsHtml: grid,
    hasDeviceRows: deviceRows.length > 0,
    hasContent: true,
    mediaFilesTotal: ts.mediaFilesTotal ?? 1,
  };
}

/**
 * Standalone Technical Summary page — rendered ONLY when there is genuine
 * capture-environment device context (web / mobile capture). Camera-only
 * content (e.g. intake with EXIF but no recorded capture environment) would be
 * a mostly-empty page, so it is deferred to a compact subsection inside the
 * Technical Appendix (renderTechnicalSummaryAppendixInner) instead — no
 * standalone whitespace page.
 */
/**
 * EXIF reviewer notes. INTAKE reports use the SHORTENED, enterprise-safe lines
 * rendered as a single compact note; Web/Mobile capture keep the original
 * (longer) muted paragraphs UNCHANGED. Meaning is preserved in both: the
 * "representative EXIF" transparency (multi-file only) + the submission/
 * preservation timestamp separation.
 */
function buildExifNotesHtml(mediaFilesTotal: number, isIntake: boolean): string {
  if (isIntake) {
    const lines = [
      mediaFilesTotal > 1
        ? "Representative EXIF shown. Full per-file EXIF is available in the Verification Package."
        : "",
      "EXIF timestamps originate from the media file and are independent of PROOVRA submission and preservation timestamps.",
    ].filter(Boolean);
    return `<div class="technical-summary-exif-note">${lines
      .map((l) => `<span>${l}</span>`)
      .join("")}</div>`;
  }
  const representativeNote =
    mediaFilesTotal > 1
      ? `<p class="muted-note">Representative EXIF shown (Primary Media Item). Per-file EXIF for all ${mediaFilesTotal} media items is included in the verification package (technical-metadata/exif-details.json).</p>`
      : "";
  const captureTimeNote = `<p class="muted-note">Camera metadata is embedded in the file by the capturing device. The EXIF Original Capture Time is read from the file itself and is distinct from PROOVRA's submission and preservation timestamps.</p>`;
  return `${representativeNote}${captureTimeNote}`;
}

export function renderTechnicalSummarySection(vm: ReportViewModel): string {
  const b = buildTechnicalSummaryBlocks(vm);
  if (!b.hasContent || !b.hasDeviceRows) return "";
  const isIntake = vm.meta?.acquisition?.isIntake === true;
  return renderPageSection(
    "Technical Summary",
    `
      <p class="section-intro">Device and camera context for the recorded material. Advisory enrichment for reviewers; it does not change the integrity verdict, and location (where recorded) is shown in the Capture Context above.</p>
      ${buildExifNotesHtml(b.mediaFilesTotal, isIntake)}
      ${b.groupsHtml}
    `,
    { className: "technical-summary-section" },
  );
}

/**
 * Compact camera/EXIF block for the Technical Appendix — returns "" unless
 * there is camera content that did NOT justify a standalone page (no device
 * context; the intake camera-only case). The EXIF note sits directly above the
 * Camera/Exposure cards (kept close, visually subtle). Returns just the inner
 * HTML; the appendix wraps it in a section.
 */
export function renderTechnicalSummaryAppendixInner(vm: ReportViewModel): string {
  const b = buildTechnicalSummaryBlocks(vm);
  if (!b.hasContent || b.hasDeviceRows) return "";
  const isIntake = vm.meta?.acquisition?.isIntake === true;
  return `${buildExifNotesHtml(b.mediaFilesTotal, isIntake)}${b.groupsHtml}`;
}

/** Render one titled two-column field-card grid, or "" when it has no
 *  meaningful rows (renderFieldGrid drops null/empty/N/A/UNKNOWN values). */
function renderGroup(
  title: string,
  rows: Array<{ label: string; value: string }>,
): string {
  return renderFieldGrid(rows, { title, className: "technical-summary-group" });
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
