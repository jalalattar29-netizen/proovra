/**
 * Report compatibility entrypoint.
 *
 * Report V2 is now the canonical renderer for worker-generated PDF reports.
 * This module preserves the legacy import path so existing callers and tests
 * resolve through one implementation only.
 */

export type {
  ReportArtifactMode,
  ReportEvidenceAssetKind,
  ReportEvidenceAsset,
  ReportEvidenceContentSummary,
  ReportPreviewPolicy,
  ReportReviewGuidance,
  ReportLegalLimitations,
  ReportAnchorSummary,
  ReportCertificationSnapshot,
  ReportEvidence,
  ReportCustodyEvent,
  ReportV2Input as ReportBuildInput,
  Tone,
  KeyValueRow,
  InfoCard,
  CalloutModel,
  InventoryRow,
  TimelineRow,
  ReportViewModel,
} from "../report-v2/types.js";

export {
  buildReportViewModel,
  renderReportHtml,
  renderPdfFromHtml,
  buildReportPdfV2,
} from "../report-v2/index.js";

import type { ReportV2Input } from "../report-v2/types.js";
import { buildReportPdfV2 } from "../report-v2/index.js";

export async function buildReportPdf(input: ReportV2Input): Promise<Buffer> {
  return buildReportPdfV2(input);
}
