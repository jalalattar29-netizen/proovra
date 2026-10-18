import {
  isAccessCustodyEventType,
  formatTimestampForReportUtc,
  type TrustSignal,
} from "@proovra/shared";
import {
  ReportCustodyEvent,
  TimelineRow,
  CalloutModel,
} from "./types.js";
import { safe } from "./formatters.js";
import {
  mapCustodyEventLabel,
  normalizeReviewerText,
  applyFlowAwareCustodyWording,
  intakeCustodyEventLabel,
  INTAKE_IDENTITY_SNAPSHOT_SUMMARY,
  CAPTURE_IDENTITY_SNAPSHOT_SUMMARY,
} from "./normalizers.js";

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

  const cleaned = raw
    .replace(LABELED_TRUNCATED_CRYPTO_PATTERN, "technical digest recorded in appendix")
    .replace(LABELED_FULL_CRYPTO_PATTERN, "technical digest recorded in appendix")
    .replace(TRUNCATED_CRYPTO_VALUE_PATTERN, "technical digest recorded")
    .replace(TRUNCATED_MARKER_PATTERN, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return normalizeReviewerText(cleaned);
}

export function buildTimelineRows(
  events: ClassifiedCustodyEvent[],
  isIntake = false,
): TimelineRow[] {
  return events.map((ev) => {
    // Intake identity-snapshot belongs to the link creator (workspace owner),
    // not the remote contributor — relabel it and replace its owner-email
    // summary with a role-safe line. Presentation only; raw event/hash chain
    // untouched.
    const intakeLabel = intakeCustodyEventLabel(ev.eventType, isIntake);
    const isIdentitySnapshot =
      safe(ev.eventType, "").toUpperCase() === "IDENTITY_SNAPSHOT_RECORDED";

    // Flow-aware summary of the raw payload (event types + hashes unchanged).
    const flowAwareSummary = applyFlowAwareCustodyWording(
      sanitizeReviewerSummary(ev.payloadSummary),
      isIntake,
    );

    // IDENTITY_SNAPSHOT_RECORDED gets a role-safe summary that never leaks the
    // workspace owner's email. Intake → link-creator / not-independently-
    // verified wording (fully REPLACES the owner-scoped raw summary).
    // Authenticated Capture → the positive authenticated-workspace-user
    // statement PREPENDED to the flow-aware raw summary (which carries no PII),
    // so the record keeps its custody detail and never reads intake wording.
    let summary: string;
    if (isIdentitySnapshot) {
      summary = isIntake
        ? INTAKE_IDENTITY_SNAPSHOT_SUMMARY
        : [CAPTURE_IDENTITY_SNAPSHOT_SUMMARY, flowAwareSummary]
            .filter((s) => s && s.trim().length > 0)
            .join(" ");
    } else {
      summary = flowAwareSummary;
    }

    return {
      sequence: String(ev.sequence),
      atUtc: formatTimestampForReportUtc(ev.atUtc),
      // Flow-aware wording: non-intake evidence must not read "at intake" /
      // "intake authorization" (event types + hashes are unchanged).
      eventLabel:
        intakeLabel ??
        applyFlowAwareCustodyWording(mapCustodyEventLabel(ev.eventType, ev.labelHints), isIntake),
      summary,
    };
  });
}

/**
 * MISMATCH DETECTION (2026-10-18) — built from the CANONICAL states (the trust
 * decision's signals, the same states the verification matrix projects), never
 * from a raw stored status or a stored free-text failure reason:
 *
 *   - a layer is a mismatch only when its canonical state is FAILED. A kept
 *     RFC 3161 token that was not validated is NOT_CHECKED (resolveTsaTrustState),
 *     never a mismatch; an OpenTimestamps failure is stated in its bounded
 *     words (the anchoring signal's summary), never the stored reason text;
 *   - "no mismatch" is stated only when nothing failed — never beside a
 *     danger issue.
 */
export function buildMismatchNarrative(params: {
  trustDecision: { signals: ReadonlyArray<TrustSignal> };
  integrityVerified: boolean;
  forensicEventCount: number;
}): CalloutModel {
  const failed = params.trustDecision.signals.filter((s) => s.state === "FAILED");
  // The anchoring signal's detail is its one bounded sentence (presentOtsAnchoring);
  // every other layer states its bounded summary.
  const dangerIssues = failed.map((s) => {
    const words = (s.key === "bitcoin_anchoring" && s.detail.trim() ? s.detail : s.summary).trim();
    return `${s.label}: ${words.replace(/[.]?$/, ".")}`;
  });
  const cautionIssues: string[] = [];

  if (!params.integrityVerified && !failed.some((s) => s.key === "core_integrity")) {
    cautionIssues.push(
      "Recorded integrity did not reach a verified state and should be reviewed manually."
    );
  }

  if (params.forensicEventCount === 0) {
    cautionIssues.push(
      "No forensic custody events were included in this report payload."
    );
  }

  const issues = [...dangerIssues, ...cautionIssues];
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
    tone: dangerIssues.length > 0 ? "danger" : "warning",
  };
}
