/**
 * "withheld": an internal workflow row stored in the custody table, or the
 * marker that stands in for one in an external artifact — neither forensic
 * custody nor access activity, counted as neither.
 */
export type CustodyEventCategory = "forensic" | "access" | "withheld";

/**
 * INTERNAL WORKFLOW ROWS IN THE CUSTODY TABLE (owner decision 2026-10-24).
 *
 * Internal Review workflow is not forensic custody. Before that decision,
 * Review status changes were appended to the chain as REVIEW_DECISION_RECORDED
 * `{ status, actorUserId }`. No writer appends them any more; the stored rows
 * stay byte-identical (the chain is hash-linked and is never rewritten). They
 * are not forensic, not reportable, not a forensic-integrity change, and they
 * never leave through an external projection — see
 * `projectCustodyEventForExternalArtifact`.
 */
const INTERNAL_WORKFLOW_CUSTODY_EVENT_TYPES = new Set<string>(["REVIEW_DECISION_RECORDED"]);

export function isInternalWorkflowCustodyEventType(eventType: string | null | undefined): boolean {
  return INTERNAL_WORKFLOW_CUSTODY_EVENT_TYPES.has(String(eventType ?? "").trim().toUpperCase());
}

/**
 * What an external artifact carries in place of an internal workflow row: the
 * chain position and its hashes — so every link stays checkable and no
 * sequence goes missing — and nothing else. Not an event type of the enum: a
 * projection marker that no writer ever stores.
 */
export const WITHHELD_CUSTODY_EVENT_TYPE = "WITHHELD_INTERNAL_RECORD";
export const WITHHELD_CUSTODY_EVENT_LABEL = "Withheld record (internal workspace activity, not evidence custody)";

export function isWithheldCustodyEventType(eventType: string | null | undefined): boolean {
  return String(eventType ?? "").trim().toUpperCase() === WITHHELD_CUSTODY_EVENT_TYPE;
}

/**
 * THE external projection of one custody row (report, verification packages,
 * exchange packages, Public Verify). An internal workflow row keeps only its
 * position and hashes: its type, payload, actor and status are withheld. Every
 * other row is returned unchanged. Pure; the stored row is never touched.
 */
export function projectCustodyEventForExternalArtifact<
  T extends { eventType: string; payload?: unknown },
>(event: T): T {
  if (!isInternalWorkflowCustodyEventType(event.eventType)) return event;
  const out: Record<string, unknown> = {};
  for (const key of ["id", "sequence", "atUtc", "prevEventHash", "eventHash"]) {
    if (key in (event as Record<string, unknown>)) out[key] = (event as Record<string, unknown>)[key];
  }
  out.eventType = WITHHELD_CUSTODY_EVENT_TYPE;
  if ("payload" in event) out.payload = null;
  return out as T;
}

const ACCESS_CUSTODY_EVENT_TYPES = new Set<string>([
  "VERIFY_VIEWED",
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "REPORT_DOWNLOADED",
  "VERIFICATION_PACKAGE_DOWNLOADED",
  "TECHNICAL_VERIFICATION_CHECKED",
]);

/**
 * ET-CUS-10 — the custody events that count as ACTIVITY for a retention
 * policy's auto-extension. Workspace use only: an authenticated view or
 * download, a report or package issued, a declaration requested or signed.
 * Never a public-link view (anyone holding the link could otherwise keep a
 * record from ever reaching retention), never a system or governance event,
 * and never the extension's own event (which would renew itself forever).
 */
export const RETENTION_ACTIVITY_CUSTODY_EVENT_TYPES = [
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "REPORT_DOWNLOADED",
  "VERIFICATION_PACKAGE_DOWNLOADED",
  "REPORT_GENERATED",
  "VERIFICATION_PACKAGE_GENERATED",
  "CERTIFICATION_REQUESTED",
  "CERTIFICATION_ATTESTED",
] as const;

export function isAccessCustodyEventType(
  eventType: string | null | undefined
): boolean {
  const normalized = String(eventType ?? "").trim().toUpperCase();
  return ACCESS_CUSTODY_EVENT_TYPES.has(normalized);
}

/**
 * ADMINISTRATIVE custody events (2026-10-18): decisions about how the record
 * is REACHED or DISCLOSED — its verification reference, the canonical page's
 * access state, its disclosure policy, the retired publication states. They
 * stay in the chain (and in its forensic display, by classification), but they
 * say nothing about the evidence bytes, signatures or custody: none of them is
 * a forensic-integrity change when a snapshot is compared with the record now.
 */
const ADMINISTRATIVE_CUSTODY_EVENT_TYPES = new Set<string>([
  "VERIFICATION_REFERENCE_ISSUED",
  "VERIFICATION_ACCESS_WITHDRAWN",
  "VERIFICATION_ACCESS_REINSTATED",
  "VERIFICATION_DISCLOSURE_CHANGED",
  "PUBLIC_VERIFY_PUBLISHED",
  "PUBLIC_VERIFY_UNPUBLISHED",
  "PUBLIC_VERIFY_SUSPENDED",
  "PUBLIC_VERIFY_RESTORED",
]);

export function isAdministrativeCustodyEventType(eventType: string | null | undefined): boolean {
  return ADMINISTRATIVE_CUSTODY_EVENT_TYPES.has(String(eventType ?? "").trim().toUpperCase());
}

/**
 * THE events whose appearance after an issued snapshot is a forensic-integrity
 * change: forensic by classification and not administrative.
 */
export function isForensicIntegrityCustodyEventType(eventType: string | null | undefined): boolean {
  return isForensicCustodyEventType(eventType) && !isAdministrativeCustodyEventType(eventType);
}

export function classifyCustodyEventType(
  eventType: string | null | undefined
): CustodyEventCategory {
  if (isAccessCustodyEventType(eventType)) return "access";
  if (isInternalWorkflowCustodyEventType(eventType) || isWithheldCustodyEventType(eventType)) return "withheld";
  return "forensic";
}

/**
 * Forensic: neither access activity, nor an internal workflow row, nor the
 * withheld marker that stands in for one in an external artifact.
 */
export function isForensicCustodyEventType(
  eventType: string | null | undefined
): boolean {
  return (
    !isAccessCustodyEventType(eventType) &&
    !isInternalWorkflowCustodyEventType(eventType) &&
    !isWithheldCustodyEventType(eventType)
  );
}
