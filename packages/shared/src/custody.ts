export type CustodyEventCategory = "forensic" | "access";

const ACCESS_CUSTODY_EVENT_TYPES = new Set<string>([
  "VERIFY_VIEWED",
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "REPORT_DOWNLOADED",
  "VERIFICATION_PACKAGE_DOWNLOADED",
  "TECHNICAL_VERIFICATION_CHECKED",
]);

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
