/**
 * Phase 14 — Enterprise governance canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - Public verify state catalog
 *   - Retention policy source catalog
 *   - Case-legal-hold status
 *   - Metadata redaction scope + field catalog
 *   - Redaction policy shape + safe defaults
 *
 * Wording rule (per Phase 14 brief): never claim "legally compliant",
 * "court admissible", "certified retention", "legally binding". Use
 * "internal preservation control", "workflow approved",
 * "policy-controlled", "review-required".
 */

// -----------------------------------------------------------------------------
// State catalogs
// -----------------------------------------------------------------------------

export const PUBLIC_VERIFY_STATES = [
  "NOT_PUBLISHED",
  "PUBLISHED",
  "SUSPENDED",
  "UNPUBLISHED",
] as const;
export type PublicVerifyState = (typeof PUBLIC_VERIFY_STATES)[number];

/**
 * Returns true when the state allows the public verify route to
 * surface the record. The route adds its own additional gates
 * (status === SIGNED / REPORTED, policy.allowPublicVerify, etc.) —
 * this predicate just answers "is the explicit publication state
 * compatible with being shown".
 */
export function publicVerifyStateAllowsAccess(
  state: PublicVerifyState,
): boolean {
  return state === "PUBLISHED";
}

export const RETENTION_POLICY_SOURCES = [
  "WORKSPACE_DEFAULT",
  "WORKFLOW_TEMPLATE",
  "EVIDENCE_OVERRIDE",
  "CASE_OVERRIDE",
] as const;
export type RetentionPolicySource = (typeof RETENTION_POLICY_SOURCES)[number];

export const CASE_LEGAL_HOLD_STATUSES = ["ACTIVE", "RELEASED"] as const;
export type CaseLegalHoldStatus = (typeof CASE_LEGAL_HOLD_STATUSES)[number];

// -----------------------------------------------------------------------------
// Metadata redaction policy
//
// A redaction policy is a PRESENTATION policy. It controls what is
// visible in different SCOPES (public verify, report-v2, package,
// integrations, external contributor). It NEVER mutates the original
// evidence — masked / hidden fields are simply omitted from the
// projection at the scope's render time.
//
// Default policies are derived from the public-verify floor: the
// strictest scope (PUBLIC_VERIFY) is the safest set of defaults; less
// strict scopes can selectively re-enable fields.
// -----------------------------------------------------------------------------

export const REDACTION_SCOPES = [
  "PUBLIC_VERIFY",
  "REPORT",
  "PACKAGE",
  "INTEGRATION",
  "EXTERNAL_CONTRIBUTOR",
] as const;
export type RedactionScope = (typeof REDACTION_SCOPES)[number];

export const REDACTION_FIELDS = [
  // Identity
  "submitterIdentity",
  "submitterEmail",
  "submitterPhone",
  "contributorIdentity",
  // Geo
  "gpsCoordinates",
  "gpsAccuracy",
  // Network / device
  "ipAddress",
  "userAgent",
  "deviceMetadata",
  // File-embedded
  "exifMetadata",
  // Operator-only fields
  "internalNotes",
  "reviewerNotes",
  "legalHoldReason",
  "rejectionReason",
  "escalationReason",
] as const;
export type RedactionField = (typeof REDACTION_FIELDS)[number];

/**
 * "visible" — field rendered as-is.
 * "masked"  — field rendered partially (e.g. email → user***@domain).
 * "hidden"  — field omitted entirely from the projection.
 */
export const REDACTION_MODES = ["visible", "masked", "hidden"] as const;
export type RedactionMode = (typeof REDACTION_MODES)[number];

export type RedactionPolicy = Readonly<
  Record<RedactionScope, Readonly<Record<RedactionField, RedactionMode>>>
>;

/**
 * Safe defaults. Public verify is the floor — anything risky is
 * hidden. Report and Package are slightly more permissive (the
 * operator who generated them is authorised), but still mask raw
 * GPS and contact details. Integration / external-contributor scopes
 * stay strict by default.
 *
 * Operators can override any cell via the workspace policy
 * `metadataRedactionDefault` JSON column.
 */
export const DEFAULT_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  PUBLIC_VERIFY: Object.freeze({
    submitterIdentity: "hidden",
    submitterEmail: "hidden",
    submitterPhone: "hidden",
    contributorIdentity: "hidden",
    gpsCoordinates: "masked",
    gpsAccuracy: "visible",
    ipAddress: "hidden",
    userAgent: "hidden",
    deviceMetadata: "hidden",
    exifMetadata: "hidden",
    internalNotes: "hidden",
    reviewerNotes: "hidden",
    legalHoldReason: "hidden",
    rejectionReason: "hidden",
    escalationReason: "hidden",
  }),
  REPORT: Object.freeze({
    submitterIdentity: "visible",
    submitterEmail: "masked",
    submitterPhone: "masked",
    contributorIdentity: "visible",
    gpsCoordinates: "masked",
    gpsAccuracy: "visible",
    ipAddress: "hidden",
    userAgent: "hidden",
    deviceMetadata: "visible",
    exifMetadata: "visible",
    internalNotes: "hidden",
    reviewerNotes: "hidden",
    legalHoldReason: "hidden",
    rejectionReason: "hidden",
    escalationReason: "hidden",
  }),
  PACKAGE: Object.freeze({
    submitterIdentity: "visible",
    submitterEmail: "visible",
    submitterPhone: "visible",
    contributorIdentity: "visible",
    gpsCoordinates: "visible",
    gpsAccuracy: "visible",
    ipAddress: "hidden",
    userAgent: "hidden",
    deviceMetadata: "visible",
    exifMetadata: "visible",
    internalNotes: "hidden",
    reviewerNotes: "hidden",
    legalHoldReason: "hidden",
    rejectionReason: "hidden",
    escalationReason: "hidden",
  }),
  INTEGRATION: Object.freeze({
    submitterIdentity: "hidden",
    submitterEmail: "masked",
    submitterPhone: "masked",
    contributorIdentity: "hidden",
    gpsCoordinates: "masked",
    gpsAccuracy: "visible",
    ipAddress: "hidden",
    userAgent: "hidden",
    deviceMetadata: "hidden",
    exifMetadata: "hidden",
    internalNotes: "hidden",
    reviewerNotes: "hidden",
    legalHoldReason: "hidden",
    rejectionReason: "hidden",
    escalationReason: "hidden",
  }),
  EXTERNAL_CONTRIBUTOR: Object.freeze({
    submitterIdentity: "hidden",
    submitterEmail: "hidden",
    submitterPhone: "hidden",
    contributorIdentity: "hidden",
    gpsCoordinates: "hidden",
    gpsAccuracy: "hidden",
    ipAddress: "hidden",
    userAgent: "hidden",
    deviceMetadata: "hidden",
    exifMetadata: "hidden",
    internalNotes: "hidden",
    reviewerNotes: "hidden",
    legalHoldReason: "hidden",
    rejectionReason: "hidden",
    escalationReason: "hidden",
  }),
});

/**
 * Merge an operator override (partial; any field can be omitted)
 * with the safe defaults. Override that drops below the public-verify
 * floor for `legalHoldReason / internalNotes / reviewerNotes` is
 * REJECTED — these stay hidden in PUBLIC_VERIFY regardless of policy.
 */
export type RedactionPolicyOverride = Partial<
  Record<RedactionScope, Partial<Record<RedactionField, RedactionMode>>>
>;

const STRICT_PUBLIC_VERIFY_FIELDS: ReadonlySet<RedactionField> = new Set([
  "internalNotes",
  "reviewerNotes",
  "legalHoldReason",
  "rejectionReason",
  "escalationReason",
]);

export function resolveRedactionPolicy(
  override: RedactionPolicyOverride | null | undefined,
): RedactionPolicy {
  if (!override) return DEFAULT_REDACTION_POLICY;
  const merged = {} as Record<
    RedactionScope,
    Record<RedactionField, RedactionMode>
  >;
  for (const scope of REDACTION_SCOPES) {
    const def = DEFAULT_REDACTION_POLICY[scope];
    const ov = override[scope] ?? {};
    const out = {} as Record<RedactionField, RedactionMode>;
    for (const field of REDACTION_FIELDS) {
      const value =
        ov[field] !== undefined ? (ov[field] as RedactionMode) : def[field];
      // Floor enforcement for public verify: operator-only fields are
      // ALWAYS hidden on the public surface.
      if (scope === "PUBLIC_VERIFY" && STRICT_PUBLIC_VERIFY_FIELDS.has(field)) {
        out[field] = "hidden";
      } else {
        out[field] = value;
      }
    }
    merged[scope] = out;
  }
  return merged as RedactionPolicy;
}

// -----------------------------------------------------------------------------
// Light field-level helpers used by route projections.
// -----------------------------------------------------------------------------

/**
 * Apply the resolved policy decision for a single field/scope pair.
 * Returns the masked / original value, or `null` when the policy is
 * "hidden". Callers can also use the mode directly; this helper just
 * encapsulates the common path.
 */
export function applyRedaction<T>(
  value: T,
  mode: RedactionMode,
  mask: (input: T) => T,
): T | null {
  if (mode === "hidden") return null;
  if (mode === "masked") return mask(value);
  return value;
}

export function maskEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const at = input.indexOf("@");
  if (at < 1) return "***";
  const local = input.slice(0, at);
  const domain = input.slice(at + 1);
  const head = local.length <= 1 ? local : local.slice(0, 1);
  return `${head}***@${domain}`;
}

export function maskPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/**
 * Reduce GPS precision to ~1.1 km (2 decimal places). Defensive
 * against NaN / overflow. The brief permits ranged precision masking;
 * a single fixed-precision tier is enough for Phase 14's foundation.
 */
export function maskGpsCoordinate(
  input: { lat: number; lng: number } | null | undefined,
): { lat: number; lng: number } | null {
  if (!input) return null;
  const lat = Number.isFinite(input.lat) ? Math.round(input.lat * 100) / 100 : 0;
  const lng = Number.isFinite(input.lng) ? Math.round(input.lng * 100) / 100 : 0;
  return { lat, lng };
}
