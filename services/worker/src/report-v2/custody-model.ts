import { isAccessCustodyEventType } from "@proovra/shared";
import {
  ReportCustodyEvent,
  TimelineRow,
  CalloutModel,
  ReportEvidence,
} from "./types.js";
import { safe } from "./formatters.js";
import { mapCustodyEventLabel } from "./normalizers.js";

const UNICODE_ELLIPSIS = String.fromCharCode(8230);
const TRUNCATED_MARKER_PATTERN = new RegExp(
  String.raw`(?:\.{3}|${UNICODE_ELLIPSIS})`,
  "g"
);
const TRUNCATED_CRYPTO_VALUE_PATTERN = new RegExp(
  String.raw`\b[a-f0-9]{8,}(?:\.{3}|${UNICODE_ELLIPSIS})[a-f0-9]*\b`,
  "gi"
);
const LABELED_TRUNCATED_CRYPTO_PATTERN = new RegExp(
  String.raw`\b(?:hash|fingerprint|digest|sha-?256)\s*:\s*[a-f0-9]{8,}(?:\.{3}|${UNICODE_ELLIPSIS})[a-f0-9]*`,
  "gi"
);
const LABELED_FULL_CRYPTO_PATTERN =
  /\b(?:hash|fingerprint|digest|sha-?256)\s*:\s*[a-f0-9]{32,}\b/gi;

export type ClassifiedCustodyEvent = ReportCustodyEvent & {
  category: "forensic" | "access";
};

export function classifyCustodyEvent(
  event: ReportCustodyEvent
): ClassifiedCustodyEvent {
  return Object.assign({}, event, {
    category: isAccessCustodyEventType(event.eventType) ? "access" : "forensic",
  });
}

export function splitCustodyEvents(events: ReportCustodyEvent[]) {
  const classified = events.map(classifyCustodyEvent);
  return {
    all: classified,
    forensic: classified.filter((ev) => ev.category === "forensic"),
    access: classified.filter((ev) => ev.category === "access"),
  };
}

function sanitizeReviewerSummary(value: string | null | undefined): string {
  const raw = safe(value);
  if (raw === "N/A") return raw;

  return raw
    .replace(LABELED_TRUNCATED_CRYPTO_PATTERN, "technical digest recorded in appendix")
    .replace(LABELED_FULL_CRYPTO_PATTERN, "technical digest recorded in appendix")
    .replace(TRUNCATED_CRYPTO_VALUE_PATTERN, "technical digest recorded")
    .replace(TRUNCATED_MARKER_PATTERN, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildTimelineRows(events: ClassifiedCustodyEvent[]): TimelineRow[] {
  return events.map((ev) => {
    return {
      sequence: String(ev.sequence),
      atUtc: safe(ev.atUtc),
      eventLabel: mapCustodyEventLabel(ev.eventType),
      summary: sanitizeReviewerSummary(ev.payloadSummary),
    };
  });
}

export function buildMismatchNarrative(params: {
  evidence: ReportEvidence;
  integrityVerified: boolean;
  forensicEventCount: number;
}): CalloutModel {
  const issues: string[] = [];

  if (!params.integrityVerified) {
    issues.push(
      "Recorded integrity did not reach a verified state and should be reviewed manually."
    );
  }

  if (safe(params.evidence.tsaStatus, "").toUpperCase() === "FAILED") {
    issues.push(
      `Trusted timestamp processing reported a failure${
        params.evidence.tsaFailureReason
          ? `: ${params.evidence.tsaFailureReason}`
          : "."
      }`
    );
  }

  if (safe(params.evidence.otsStatus, "").toUpperCase() === "FAILED") {
    issues.push(
      `OpenTimestamps processing reported a failure${
        params.evidence.otsFailureReason
          ? `: ${params.evidence.otsFailureReason}`
          : "."
      }`
    );
  }

  if (params.forensicEventCount === 0) {
    issues.push(
      "No forensic custody events were included in this report payload."
    );
  }

  if (issues.length === 0) {
    return {
      title: "Mismatch detection",
      body:
        "No explicit integrity, timestamping, OpenTimestamps, or custody mismatch signals were recorded in this report payload. Reviewers should still evaluate legal context and evidentiary relevance separately.",
      tone: "success",
    };
  }

  return {
    title: "Mismatch detection",
    body: issues.join(" "),
    tone: issues.length > 1 ? "danger" : "warning",
  };
}
