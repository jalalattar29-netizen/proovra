/**
 * "Media & Capture Metadata" report section.
 *
 * Enterprise, compact, SMART-RENDERED:
 *   * Media / EXIF / Capture Environment / Network sub-blocks.
 *   * Only meaningful rows render (no null / empty / "unknown" / zero-only
 *     rows; no empty blocks).
 *   * Human-readable labels only — never internal enum constants.
 *   * EXIF GPS is a presence flag; no coordinates, no raw EXIF dump.
 *   * No raw IP, no raw User-Agent; masked IP / no IP in the public PDF.
 *   * When EXIF is absent, one short reassuring note instead of empty rows.
 * BYTE-NEUTRAL when vm.technicalSummary is null.
 */

import { ReportViewModel } from "../types.js";
import { renderCompactKeyValueList, renderPageSection } from "../ui.js";
import {
  EXIF_ABSENT_NOTE,
  humanizeCaptureMethod,
  humanizeUploadSource,
  metadataRows,
  metadataStatusLabel,
} from "@proovra/shared-runtime/technical-metadata";

function block(title: string, rows: Array<{ label: string; value: string }>): string {
  if (rows.length === 0) return "";
  return `
    <h3 class="subsection-title">${title}</h3>
    ${renderCompactKeyValueList(rows)}
  `;
}

export function renderTechnicalSummarySection(vm: ReportViewModel): string {
  const ts = vm.technicalSummary;
  if (!ts) return "";

  // ---- Media ----
  const pm = ts.primaryMedia;
  const mediaRows = metadataRows([
    { label: "Primary media type", value: ts.primaryMediaType },
    {
      label: "Files analysed",
      value: `${ts.mediaFilesAnalyzed} / ${ts.mediaFilesTotal}`,
    },
    { label: "Resolution", value: ts.resolutionSummary, display: ts.resolutionSummary ?? undefined },
    {
      label: "Duration",
      value: pm?.durationMs ?? null,
      display: pm?.durationMs != null ? `${Math.round(pm.durationMs / 1000)}s` : undefined,
    },
    { label: "Video codec", value: pm?.videoCodec ?? null },
    {
      label: "Frame rate",
      value: pm?.frameRate ?? null,
      display: pm?.frameRate != null ? `${pm.frameRate} fps` : undefined,
    },
    {
      label: "Page count",
      value: pm?.pageCount ?? null,
      display: pm?.pageCount != null ? String(pm.pageCount) : undefined,
    },
    { label: "Metadata", value: ts.metadataStatus },
  ]);
  const mediaBlock = block("Media", mediaRows);

  // ---- EXIF ----
  let exifBlock = "";
  if (ts.exif) {
    if (ts.exif.exifPresent) {
      const rows = metadataRows([
        { label: "Camera", value: ts.exif.camera },
        { label: "Lens", value: ts.exif.lensModel },
        { label: "Original capture time", value: ts.exif.originalCaptureTime },
        { label: "ISO", value: ts.exif.iso },
        { label: "Aperture", value: ts.exif.aperture },
        { label: "Exposure", value: ts.exif.exposureTime },
        { label: "Shutter speed", value: ts.exif.shutterSpeed },
        { label: "White balance", value: ts.exif.whiteBalance },
        { label: "Orientation", value: ts.exif.orientation },
        { label: "Software", value: ts.exif.softwareTag },
        {
          label: "EXIF GPS",
          value: ts.exif.gpsPresent ? "Present (coordinates withheld)" : "Not present",
        },
        { label: "Resolution", value: ts.exif.resolution },
      ]);
      exifBlock = `
        <h3 class="subsection-title">EXIF Summary</h3>
        <p class="muted-note">Metadata embedded in the file by the capturing device or software. The original capture time is read from the file itself, distinct from PROOVRA's capture and preservation timestamps.</p>
        ${renderCompactKeyValueList(rows)}
      `;
    } else {
      // EXIF absent → one short reassuring note, no empty rows.
      exifBlock = `
        <h3 class="subsection-title">EXIF Summary</h3>
        <p class="muted-note">${EXIF_ABSENT_NOTE}</p>
      `;
    }
  }

  // ---- Capture Environment ----
  let captureBlock = "";
  if (ts.captureEnvironment) {
    const ce = ts.captureEnvironment;
    const rows = metadataRows([
      { label: "Submitted through", value: humanizeUploadSource(ce.uploadSource) },
      { label: "Capture method", value: humanizeCaptureMethod(ce.captureMethod) },
      {
        label: "Browser",
        value: ce.browserName,
        display: [ce.browserName, ce.browserVersion].filter(Boolean).join(" ") || undefined,
      },
      {
        label: "Operating system",
        value: ce.osName,
        display: [ce.osName, ce.osVersion].filter(Boolean).join(" ") || undefined,
      },
      { label: "Device", value: ce.deviceClass, display: ce.deviceClass ? titleCase(ce.deviceClass) : undefined },
      { label: "Engine", value: ce.engine },
      { label: "Platform", value: ce.platform },
      { label: "Timezone", value: ce.timezone },
      { label: "Locale", value: ce.locale },
    ]);
    captureBlock = block("Capture Environment", rows);
  }

  // ---- Network ----
  let networkBlock = "";
  if (ts.network) {
    const n = ts.network;
    const rows = metadataRows([
      { label: "Masked IP", value: n.maskedIp },
      { label: "Country", value: n.country },
      { label: "Region", value: n.region },
      { label: "Network type", value: n.networkType },
    ]);
    networkBlock = block("Network", rows);
  }

  const body = `${mediaBlock}${exifBlock}${captureBlock}${networkBlock}`;
  if (body.trim().length === 0) return "";

  return renderPageSection(
    "Media & Capture Metadata",
    `
      <p class="section-intro">Deterministic technical metadata about the recorded material and the environment in which it entered PROOVRA. Advisory context for reviewers; it does not change the integrity verdict.</p>
      ${body}
    `,
    { className: "technical-summary-section" },
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Re-exported for any caller still importing the status label from here.
export { metadataStatusLabel };
