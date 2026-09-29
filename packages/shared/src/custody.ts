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
