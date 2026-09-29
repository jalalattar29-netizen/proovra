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
  RETENTION_ARCHIVED: "Archived at end of retention",
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
  EVIDENCE_UNLOCKED: "Evidence record unlocked",
  RETENTION_AUTO_EXTENDED: "Retention period extended by policy",
  REDACTION_RECORDED: "Redaction step recorded",
  REVIEW_DECISION_RECORDED: "Review decision recorded",
  RETENTION_POLICY_APPLIED: "Retention policy applied",
};

/** Every event type this function names (the structural test compares it with the enum). */
export const CUSTODY_EVENT_LABELED_TYPES: ReadonlyArray<string> = Object.keys(LABELS);

const FINALIZATION_ACTIONS = new Set(["finalize", "finalization", "publish_on_finalize", "complete"]);

export function custodyEventLabel(
  eventType: string | null | undefined,
  payload?: unknown,
): string {
  const type = String(eventType ?? "").trim().toUpperCase();
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (type === "EVIDENCE_LOCKED" && p) {
    return p.retentionApplied === true ? "Object Lock retention applied to storage" : "Evidence record locked";
  }
  if (type === "EXPORT_BLOCKED_BY_POLICY" && p) {
    const action = String(p.action ?? "").toLowerCase();
    if (FINALIZATION_ACTIONS.has(action) || action.includes("finaliz")) return "Finalization blocked by policy";
    if (action.includes("download") || action.includes("export")) return "Download blocked by policy";
  }
  if (type === "RETENTION_CANDIDATE_IDENTIFIED" && p?.blockedByLegalHold === true) {
    return "Retention period ended (held by legal hold)";
  }
  const known = LABELS[type];
  if (known) return known;
  if (!type) return "Custody event recorded";
  // An unknown code is never printed raw: sentence case of its words.
  const words = type.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
