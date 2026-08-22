/**
 * Phase 21 — Enterprise observability, incident response & operational
 * resilience canonical types.
 *
 * Provider-agnostic, framework-agnostic primitives for:
 *   - Operational incident categories + severities + statuses
 *   - Alert categories (mapping to AlertProvider dispatch)
 *   - Log-redaction key allowlist (the keys a redactor must scrub)
 *   - Request correlation header normalization
 *
 * Hard invariants encoded here:
 *   - Incidents are OPERATIONAL only. They never claim authenticity,
 *     legal admissibility, or forensic conclusions. Wording catalog
 *     uses "issue", "failure", "anomaly", "outage" — never "breach",
 *     "compromise", "proof", "verdict".
 *   - Redaction key list is exhaustive. Anything added must be a code
 *     change so the redactor cannot drift.
 *   - Severities mirror SecurityEvent severities (INFO/WARNING/HIGH +
 *     CRITICAL) so operators see a consistent ladder across both
 *     surfaces.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Incident severity
// -----------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = [
  "INFO",
  "WARNING",
  "HIGH",
  "CRITICAL",
] as const;
export const IncidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

// -----------------------------------------------------------------------------
// Incident status
// -----------------------------------------------------------------------------

export const INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

const INCIDENT_TERMINAL_STATUSES: ReadonlyArray<IncidentStatus> = [
  "RESOLVED",
  "SUPPRESSED",
];

export function isTerminalIncidentStatus(s: IncidentStatus): boolean {
  return INCIDENT_TERMINAL_STATUSES.includes(s);
}

const INCIDENT_TRANSITIONS: Readonly<
  Record<IncidentStatus, ReadonlyArray<IncidentStatus>>
> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"],
  ACKNOWLEDGED: ["RESOLVED", "SUPPRESSED", "OPEN"],
  RESOLVED: ["OPEN"],
  SUPPRESSED: ["OPEN"],
};

export function isAllowedIncidentStatusTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

// -----------------------------------------------------------------------------
// Incident category
//
// Exhaustive set of operational domains. New category → code change.
// -----------------------------------------------------------------------------

export const INCIDENT_CATEGORIES = [
  "UPLOAD",
  "REPORT",
  "PACKAGE",
  "WEBHOOK",
  "COMMUNICATIONS",
  "IDENTITY_SECURITY",
  "GOVERNANCE",
  "STORAGE",
  "AI",
  "INTEGRATION",
  "DATABASE",
  "WORKER",
  "RECONCILIATION",
  /**
   * ATTENTION ARCHITECTURE PHASE 3 (2026-08-22) — per-Evidence integrity.
   *
   * RFC3161 timestamping and OpenTimestamps anchoring failures. Deliberately
   * its own category rather than folded into UPLOAD or STORAGE: those are
   * about moving bytes, and this is about whether a record can be PROVEN.
   * An operator triaging "which records are currently unprovable" is asking a
   * different question from "which uploads failed", and a category they can
   * filter on is what makes that question answerable.
   *
   * One condition per (Evidence, failure class). Never grouped by reason,
   * filename, provider, workspace or date — see
   * `services/api/src/services/operations/evidence-integrity-correlation.ts`.
   */
  "EVIDENCE_INTEGRITY",
] as const;
export const IncidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
export type IncidentCategory = z.infer<typeof IncidentCategorySchema>;

// -----------------------------------------------------------------------------
// Alert categories — drive the AlertProvider dispatch.
// -----------------------------------------------------------------------------

export const ALERT_CATEGORIES = [
  "INCIDENT_CRITICAL_CREATED",
  "INCIDENT_HIGH_CREATED",
  "JOB_REPEATED_FAILURE",
  "PROVIDER_OUTAGE",
  "DB_READINESS_FAILURE",
  "WEBHOOK_INVALID_SIGNATURE_BURST",
  "IDENTITY_SECURITY_RISK_CRITICAL",
  "STORAGE_WRITE_FAILURE",
  "REPORT_BACKLOG_HIGH",
] as const;
export const AlertCategorySchema = z.enum(ALERT_CATEGORIES);
export type AlertCategory = z.infer<typeof AlertCategorySchema>;

// -----------------------------------------------------------------------------
// Log redaction key allowlist
//
// The structured logger MUST redact any object key whose lowercased
// form CONTAINS one of these substrings. The list is intentionally
// broad: a false positive (redacting a harmless field that happens
// to contain "token") is far cheaper than a missed secret.
// -----------------------------------------------------------------------------

export const REDACTED_KEY_SUBSTRINGS: ReadonlyArray<string> = [
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "authtoken",
  "auth_token",
  "jwt",
  "otp",
  "code",
  "verification_sid",
  "rawkey",
  "raw_key",
  "session_id_hash",
  "device_id_hash",
  "recipient_hash",
  "external_subject_id",
  "key_hash",
];

/**
 * Pure helper: returns true iff the key name (any case) contains any
 * of the redaction substrings. Used by both the API and worker
 * loggers + the incident metadata sanitiser.
 */
export function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const marker of REDACTED_KEY_SUBSTRINGS) {
    if (lower.includes(marker)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Request correlation header normalization
//
// Accept an inbound x-request-id when safe; generate one when missing.
// "Safe" means: present, non-empty after trim, length <= 128, only
// printable ASCII (`A-Za-z0-9_-`). Anything else is replaced.
// -----------------------------------------------------------------------------

const REQUEST_ID_MAX_LEN = 128;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeRequestId(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t.length === 0 || t.length > REQUEST_ID_MAX_LEN) return false;
  return SAFE_REQUEST_ID_RE.test(t);
}

// -----------------------------------------------------------------------------
// Safe-summary truncation
//
// Incident.safeSummary + IncidentEvent.safeMessage are operator-facing
// strings rendered in the /ops UI. Bounded at 400 chars; trims
// non-printable / control characters; collapses whitespace.
// -----------------------------------------------------------------------------

const SAFE_SUMMARY_MAX = 400;

/**
 * True for the control characters this scrubber removes: the C0 range EXCEPT
 * TAB (0x09) and LF (0x0A), plus DEL (0x7F). Expressed as explicit code-point
 * ranges so the control characters are named rather than embedded in a regex
 * literal — same set, no `no-control-regex` suppression.
 */
function isScrubbedControlCode(code: number): boolean {
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
}

/** Collapse each RUN of those control characters into a single space. */
function scrubControlRuns(value: string): string {
  let out = "";
  let inRun = false;
  for (const ch of value) {
    if (isScrubbedControlCode(ch.charCodeAt(0))) {
      if (!inRun) {
        out += " ";
        inRun = true;
      }
      continue;
    }
    inRun = false;
    out += ch;
  }
  return out;
}

export function clipSafeSummary(value: string): string {
  if (!value) return "";
  // Drop control characters except TAB (0x09) and LF (0x0A) → single space.
  const cleaned = scrubControlRuns(value).trim();
  if (cleaned.length <= SAFE_SUMMARY_MAX) return cleaned;
  return cleaned.slice(0, SAFE_SUMMARY_MAX - 1) + "…";
}

// -----------------------------------------------------------------------------
// Incident fingerprint — used to deduplicate.
//
// The auto-create path computes `category:safeKey` where safeKey is a
// short stable string (e.g. "twilio:invalid_signature" or
// "report:generation_failed:evidence_uuid_prefix_8"). The service
// layer is the authoritative caller; this helper is a pure validator.
// -----------------------------------------------------------------------------

const FINGERPRINT_MAX_LEN = 200;

export function isValidIncidentFingerprint(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t.length === 0 || t.length > FINGERPRINT_MAX_LEN) return false;
  // Allow alnum, dot, colon, hyphen, underscore.
  return /^[A-Za-z0-9._:-]+$/.test(t);
}
