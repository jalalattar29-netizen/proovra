/**
 * Enterprise Technical Metadata — "Media Technical Summary" report
 * section. ONE compact section (max ~one page) with three sub-blocks:
 *   * Media Summary       — deterministic file facts
 *   * EXIF Summary        — file-embedded camera/device metadata
 *   * Capture Environment — privacy-safe PROOVRA upload environment
 *
 * Hard rules:
 *   * BYTE-NEUTRAL when vm.technicalSummary is null — returns "".
 *   * NEVER renders raw EXIF, raw User-Agent, raw IP, or GPS
 *     coordinates. GPS is a "Present / Not present" flag only.
 *   * Reviewer-neutral, legal-safe wording. EXIF capture time is
 *     explicitly labelled as file-embedded (distinct from PROOVRA's
 *     own capture/preservation timestamps).
 */

import { ReportViewModel } from "../types.js";
import { renderCompactKeyValueList, renderPageSection } from "../ui.js";

function metadataStatusLabel(
  s: "PRESENT" | "PARTIAL" | "MISSING" | "CONFLICT" | "UNKNOWN",
): string {
  switch (s) {
    case "PRESENT":
      return "Present";
    case "PARTIAL":
      return "Partial";
    case "MISSING":
      return "Missing";
    case "CONFLICT":
      return "Conflict detected";
    default:
      return "Not available";
  }
}

function na(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : "Not available";
}

export function renderTechnicalSummarySection(vm: ReportViewModel): string {
  const ts = vm.technicalSummary;
  if (!ts) return "";

  const mediaRows = [
    {
      label: "Media files analysed",
      value: `${ts.mediaFilesAnalyzed} / ${ts.mediaFilesTotal}`,
    },
    { label: "Metadata status", value: ts.metadataStatus },
    { label: "Primary media type", value: ts.primaryMediaType },
    {
      label: "Resolution / duration / pages",
      value: na(ts.resolutionSummary),
    },
  ];

  const mediaBlock = `
    <h3 class="subsection-title">Media Summary</h3>
    ${renderCompactKeyValueList(mediaRows)}
  `;

  // EXIF — only when available for an image/video part.
  const exifBlock = ts.exif
    ? `
      <h3 class="subsection-title">EXIF Summary</h3>
      <p class="muted-note">Metadata embedded in the file by the capturing device or software. The original capture time below is read from the file itself and is distinct from PROOVRA's capture and preservation timestamps.</p>
      ${renderCompactKeyValueList([
        { label: "Camera", value: na(ts.exif.camera) },
        {
          label: "Original capture time (file-embedded)",
          value: na(ts.exif.originalCaptureTime),
        },
        {
          label: "EXIF GPS",
          value: ts.exif.gpsPresent
            ? "Present (coordinates withheld)"
            : "Not present",
        },
        { label: "Resolution", value: na(ts.exif.resolution) },
        { label: "Software / editor tag", value: na(ts.exif.softwareTag) },
        {
          label: "Metadata status",
          value: metadataStatusLabel(ts.exif.metadataStatus),
        },
      ])}
    `
    : "";

  // Capture environment.
  const ce = ts.captureEnvironment;
  const captureBlock = ce
    ? `
      <h3 class="subsection-title">Capture Environment</h3>
      <p class="muted-note">The environment in which this material was submitted to PROOVRA. This is distinct from the file's embedded metadata above and from the preservation (timestamping / anchoring) state shown elsewhere in this report.</p>
      ${renderCompactKeyValueList([
        { label: "Submitted via", value: na(ce.uploadSource) },
        { label: "Capture method", value: na(ce.captureMethod) },
        { label: "Browser / OS", value: na(ce.browserOs) },
        { label: "Device class", value: na(ce.deviceClass) },
        { label: "Timezone at submission", value: na(ce.timezone) },
      ])}
    `
    : "";

  return renderPageSection(
    "Media Technical Summary",
    `
      <p class="section-intro">Deterministic technical metadata about the recorded material and the environment in which it entered PROOVRA. This information is advisory context for reviewers; it does not change the integrity verdict.</p>
      ${mediaBlock}
      ${exifBlock}
      ${captureBlock}
    `,
    { className: "technical-summary-section" },
  );
}
