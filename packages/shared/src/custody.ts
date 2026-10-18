export type CustodyEventCategory = "forensic" | "access";

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
  return isAccessCustodyEventType(eventType) ? "access" : "forensic";
}

export function isForensicCustodyEventType(
  eventType: string | null | undefined
): boolean {
  return !isAccessCustodyEventType(eventType);
}
