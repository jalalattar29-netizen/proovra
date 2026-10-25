import { classifyLegacyReviewCustody, reviewEventLabel } from "./review-event-taxonomy.js";
import { WITHHELD_CUSTODY_EVENT_LABEL, WITHHELD_CUSTODY_EVENT_TYPE } from "./custody.js";
/**
 * THE ONE CUSTODY EVENT LABEL (ET-CUS-13, 2026-09-29).
 *
 * The report, the web timeline and the mobile timeline each named custody
 * events their own way — the web tab printed the raw enum code with the
 * underscores removed ("DELETE BLOCKED BY LEGAL HOLD"), and the report called
 * the finalization retention lock and the operational lock by the same name.
 * Every surface now reads this one function. A structural test fails when a
 * CustodyEventType value has no label here.
 *
 * `payload` refines the label where one event type carries two meanings; a
 * surface that only has the type (a grouped timeline) gets the neutral form.
 */
const LABELS: Readonly<Record<string, string>> = {
  EVIDENCE_CREATED: "Evidence record created",
  UPLOAD_STARTED: "Upload authorization recorded (legacy label)",
  UPLOAD_AUTHORIZED: "Upload authorization recorded",
  UPLOAD_COMPLETED: "Upload completion confirmed",
  EVIDENCE_COMPLETED: "Evidence record completed",
  SIGNATURE_APPLIED: "Digital signature applied",
  TIMESTAMP_APPLIED: "Trusted timestamp token recorded",
  TIMESTAMP_FAILED: "Trusted timestamp not obtained",
  REPORT_GENERATED: "Report generated",
  VERIFICATION_PACKAGE_GENERATED: "Verification package generated",
  VERIFICATION_PACKAGE_DOWNLOADED: "Verification package downloaded",
  TECHNICAL_VERIFICATION_CHECKED: "Technical verification checked",
  REVIEW_READY: "Review-ready state recorded",
  CERTIFICATION_REQUESTED: "Certification requested",
  CERTIFICATION_ATTESTED: "Certification attested",
  CERTIFICATION_REVOKED: "Certification revoked",
  IDENTITY_SNAPSHOT_RECORDED: "Identity snapshot recorded at intake",
  REPORT_IDENTITY_CONTEXT_RECORDED: "Identity context recorded at report generation",
  ANCHOR_PUBLISHED: "External anchor published",
  ANCHOR_FAILED: "External anchor failed",
  OTS_APPLIED: "OpenTimestamps update recorded",
  OTS_FAILED: "OpenTimestamps provider returned failure",
  OTS_ATTEMPT_ERROR: "OpenTimestamps attempt errored",
  EVIDENCE_VIEWED: "Evidence viewed",
  EVIDENCE_DOWNLOADED: "Original evidence downloaded",
  EVIDENCE_DELETED: "Evidence record deleted",
  EVIDENCE_DELETE_SCHEDULED: "Evidence deletion scheduled",
  EVIDENCE_DELETE_RESTORED: "Evidence deletion cancelled",
  EVIDENCE_PURGED: "Evidence purged",
  VERIFY_VIEWED: "Verification page viewed",
  REPORT_DOWNLOADED: "Report downloaded",
  EVIDENCE_LOCKED: "Evidence locked",
  STORAGE_PROTECTION_UNAVAILABLE: "Storage protection unavailable (Object Lock not applied)",
  EVIDENCE_CLAIMED: "Evidence claimed",
  EVIDENCE_ARCHIVED: "Evidence archived",
  EVIDENCE_RESTORED: "Evidence restored",
  EXTERNAL_INTAKE_LINK_USED: "Intake link used",
  EXTERNAL_INTAKE_CONSENT_ACCEPTED: "Intake consent accepted",
  EXTERNAL_INTAKE_SUBMITTED: "Intake submission received",
  LEGAL_HOLD_PLACED: "Legal hold placed",
  LEGAL_HOLD_RELEASED: "Legal hold released",
  DELETE_BLOCKED_BY_LEGAL_HOLD: "Deletion blocked by legal hold",
  DELETE_BLOCKED_BY_RETENTION: "Deletion blocked by retention",
  EXPORT_BLOCKED_BY_POLICY: "Action blocked by policy",
  CASE_LEGAL_HOLD_APPLIED: "Case legal hold applied",
  CASE_LEGAL_HOLD_RELEASED: "Case legal hold released",
  PUBLIC_VERIFY_PUBLISHED: "Public verification published",
  PUBLIC_VERIFY_UNPUBLISHED: "Public verification unpublished",
  PUBLIC_VERIFY_SUSPENDED: "Public verification suspended",
  PUBLIC_VERIFY_RESTORED: "Public verification restored",
  RETENTION_CANDIDATE_IDENTIFIED: "Retention period ended (review required)",
  RETENTION_ARCHIVED: "Moved to the retention archive",
  REPORT_PDF_SIGNED: "Report PDF signed",
  REPORT_PDF_UNSIGNED_OPT_OUT: "Report PDF issued unsigned (workspace setting)",
  INTEGRITY_REJECTED_HASH_MISMATCH: "Integrity check failed (digest mismatch)",
  CAPTURE_TRUST_EVENT: "Capture session event recorded",
  DUPLICATE_DECISION_RECORDED: "Duplicate decision recorded",
  MANUAL_RELATIONSHIP_CREATED: "Relationship created",
  MANUAL_RELATIONSHIP_RETRACTED: "Relationship retracted",
  GRAPH_RECONCILE_REQUESTED: "Investigation graph refresh requested",
  MEDIA_INTELLIGENCE_REFRESH_REQUESTED: "Media analysis refresh requested",
  INVESTIGATION_GRAPH_EXPORTED: "Investigation graph exported",
  INVESTIGATION_TIMELINE_EXPORTED: "Investigation timeline exported",
  INVESTIGATION_DUPLICATES_EXPORTED: "Investigation duplicates exported",
  CHAIN_TRANSFER_CUSTODY_EXTENDED: "Chain-of-custody transfer recorded",
  EVIDENCE_OWNERSHIP_TRANSFERRED: "Record ownership transferred",
  EVIDENCE_UNLOCKED: "Evidence record unlocked",
  RETENTION_AUTO_EXTENDED: "Retention period extended by policy",
  REDACTION_RECORDED: "Redaction step recorded",
  // Stored history only (owner decision 2026-10-24): no writer appends this
  // type any more. Internal views name each stored row by what it was
  // (classifyLegacyReviewCustody); external artifacts carry the withheld
  // marker instead.
  REVIEW_DECISION_RECORDED: "Internal review activity (historical record)",
  RETENTION_POLICY_APPLIED: "Retention policy applied",
  ARCHIVE_RESTORE_REQUESTED: "Restore from retention archive requested",
  ARCHIVE_RESTORE_STARTED: "Restore from retention archive started",
  ARCHIVE_RESTORE_VERIFIED: "Archived record verified for restore",
  ARCHIVE_RESTORE_COMPLETED: "Restored from retention archive",
  ARCHIVE_RESTORE_FAILED: "Restore from retention archive failed verification",
  VERIFICATION_REFERENCE_ISSUED: "Verification reference issued",
  VERIFICATION_ACCESS_WITHDRAWN: "Verification page withdrawn",
  VERIFICATION_ACCESS_REINSTATED: "Verification page reinstated",
  VERIFICATION_DISCLOSURE_CHANGED: "Verification page disclosure changed",
};

/**
 * The ONLY payload facts the label reads, as a bounded object a surface can
 * carry without the raw payload (the report keeps no payloads on its rows).
 */
export type CustodyLabelHints = {
  /** TIMESTAMP_FAILED: the authority answered with a token PROOVRA did not validate. */
  tsaTokenReceived?: true;
  retentionApplied?: true;
  lockedByUserId?: true;
  action?: string;
  blockedByLegalHold?: true;
};

export function custodyLabelHints(payload: unknown): CustodyLabelHints | null {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!p) return null;
  const out: CustodyLabelHints = {};
  if (p.retentionApplied === true) out.retentionApplied = true;
  if (typeof p.lockedByUserId === "string" && p.lockedByUserId) out.lockedByUserId = true;
  if (typeof p.action === "string" && p.action) out.action = p.action.slice(0, 64);
  if (p.blockedByLegalHold === true) out.blockedByLegalHold = true;
  if (p.tsaTokenReceived === true || TSA_TOKEN_RECEIVED_CODES.has(String(p.tsaFailureCode ?? ""))) out.tsaTokenReceived = true;
  return Object.keys(out).length > 0 ? out : null;
}

/** Every event type this function names (the structural test compares it with the enum). */
export const CUSTODY_EVENT_LABELED_TYPES: ReadonlyArray<string> = Object.keys(LABELS);

const FINALIZATION_ACTIONS = new Set(["finalize", "finalization", "publish_on_finalize", "complete"]);

/** Failure codes that mean a token WAS received and then not validated. */
const TSA_TOKEN_RECEIVED_CODES = new Set([
  "tsa_trust_anchor_not_configured",
  "tsa_trust_anchor_refused",
  "tsa_token_untrusted",
  "tsa_token_signature_invalid",
  "tsa_nonce_mismatch",
  "tsa_message_imprint_mismatch",
  "tsa_policy_not_accepted",
]);

export function custodyEventLabel(
  eventType: string | null | undefined,
  payload?: unknown,
): string {
  const type = String(eventType ?? "").trim().toUpperCase();
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (type === "EVIDENCE_LOCKED" && p) {
    if (p.retentionApplied === true) return "Object Lock retention applied to storage";
    if (p.lockedByUserId) return "Evidence record locked";
  }
  if (type === "EXPORT_BLOCKED_BY_POLICY" && p) {
    const action = String(p.action ?? "").toLowerCase();
    if (FINALIZATION_ACTIONS.has(action) || action.includes("finaliz")) return "Finalization blocked by policy";
    if (action.includes("download") || action.includes("export")) return "Download blocked by policy";
  }
  if (type === "TIMESTAMP_FAILED" && p && (p.tsaTokenReceived === true || TSA_TOKEN_RECEIVED_CODES.has(String(p.tsaFailureCode ?? "")))) {
    return "Trusted timestamp received; not validated";
  }
  if (type === "RETENTION_CANDIDATE_IDENTIFIED" && p?.blockedByLegalHold === true) {
    return "Retention period ended (held by legal hold)";
  }
  if (type === "REVIEW_DECISION_RECORDED" && p) {
    return `${reviewEventLabel(classifyLegacyReviewCustody(p))} (internal review, historical record)`;
  }
  if (type === WITHHELD_CUSTODY_EVENT_TYPE) return WITHHELD_CUSTODY_EVENT_LABEL;
  const known = LABELS[type];
  if (known) return known;
  if (!type) return "Custody event recorded";
  // An unknown code is never printed raw: sentence case of its words.
  const words = type.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * F-28 (independent forward audit) — THE custody-chain verdict in words.
 * Owner surfaces printed the verifier's raw codes ("Continuous (hashed)",
 * "Review required (prev_hash_mismatch)") while Public Verify said "Valid
 * (Legacy)". One sentence per verdict, for every surface.
 */
export function custodyChainVerdictLabel(chain: {
  valid: boolean | null | undefined;
  mode?: string | null;
  reason?: string | null;
}): string {
  if (chain.valid === true) {
    if (chain.mode === "legacy") return "Continuous (recorded before events were hash-linked)";
    if (chain.mode === "empty") return "No custody events recorded";
    return "Continuous — every event is hash-linked to the one before it";
  }
  if (chain.valid !== false) return "Not checked";
  switch (chain.reason) {
    case "sequence_gap":
      return "Review required — an event is missing from the sequence";
    case "prev_hash_mismatch":
      return "Review required — an event does not link to the one before it";
    case "event_hash_mismatch":
      return "Review required — an event's contents do not match its recorded hash";
    case "hash_missing":
      return "Review required — an event has no recorded hash";
    default:
      return "Review required";
  }
}

/**
 * F-28 (independent forward audit) — the custody timeline groups events by the
 * VIEWER's local day. It grouped by the UTC date prefix and then formatted
 * "<day>T00:00:00Z" in the viewer's zone, so west of UTC every header named
 * the day before its events' (local) times.
 */
export function custodyLocalDayKey(atUtc: string | null | undefined): string {
  if (!atUtc) return "Undated";
  const d = new Date(atUtc);
  if (!Number.isFinite(d.getTime())) return "Undated";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An ISO instant inside that local day (local noon), for a date-only formatter. */
export function custodyLocalDayInstant(dayKey: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).toISOString();
}
