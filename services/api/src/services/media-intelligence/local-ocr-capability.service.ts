/**
 * AUD-019 — the local OCR engine, as the WORKER reported it.
 *
 * The API process has no OCR engine and cannot see the worker's image, so it
 * never states a constant about local OCR. Each worker heartbeat carries the
 * result of its own `tesseract --version` + `tesseract --list-langs` probe in
 * `worker_telemetry_snapshots.metadata_json.localOcr` (services/worker
 * telemetry). This reads the newest such report and projects it through the
 * shared rule; with no fresh report the answer is NOT_REPORTED.
 *
 * Read-only. Never throws past the caller's degraded-block guard.
 */
import {
  parseLocalOcrCapabilityReport,
  projectLocalOcrCapability,
  type LocalOcrCapabilityView,
} from "@proovra/shared";

import { prisma } from "../../db.js";

/** A report older than this is not current truth (a redeploy may have changed the image). */
export const LOCAL_OCR_REPORT_MAX_AGE_MS = 15 * 60 * 1000;
/** Bounded scan of the newest heartbeats for one carrying a report. */
const HEARTBEAT_SCAN_LIMIT = 50;

export async function readReportedLocalOcrCapability(now = new Date()): Promise<LocalOcrCapabilityView> {
  const rows = await prisma.workerTelemetrySnapshot.findMany({
    where: {
      workerKind: "WORKER",
      heartbeatAtUtc: { gte: new Date(now.getTime() - LOCAL_OCR_REPORT_MAX_AGE_MS) },
    },
    orderBy: { heartbeatAtUtc: "desc" },
    take: HEARTBEAT_SCAN_LIMIT,
    select: { metadataJson: true },
  });
  for (const row of rows) {
    const report = parseLocalOcrCapabilityReport(row.metadataJson);
    if (report) return projectLocalOcrCapability(report, now.getTime(), LOCAL_OCR_REPORT_MAX_AGE_MS);
  }
  return { state: "NOT_REPORTED" };
}

/** Operator-facing copy for the reviewer console tile — never stronger than the report. */
export function localOcrCapabilitySummary(view: LocalOcrCapabilityView): string {
  switch (view.state) {
    case "AVAILABLE":
      return (
        `Local OCR (Tesseract${view.version ? ` ${view.version}` : ""}) reported available by the worker ` +
        `with languages ${view.effectiveLanguages}` +
        (view.missingLanguages.length > 0 ? `; not installed: ${view.missingLanguages.join(", ")}` : "") +
        `. It is used for derived screen review, subject to each workspace's OCR policy.`
      );
    case "LANGUAGE_UNAVAILABLE":
      return (
        "The worker reported the local OCR engine without any requested language model " +
        `(${view.missingLanguages.join(", ") || "none listed"}), so local OCR cannot run.`
      );
    case "ENGINE_UNAVAILABLE":
      return "The worker reported that the local OCR engine is not installed.";
    case "NOT_REPORTED":
      return "Local OCR state unknown — no worker has reported it recently.";
  }
}
