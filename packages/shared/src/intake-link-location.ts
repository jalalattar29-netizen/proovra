/**
 * Intake Links — location collection.
 *
 * Canonical enums + helpers shared between the API (DB write/read,
 * Zod validation, projection), the web app (modal, public intake
 * page, evidence detail, verify, report), and tests.
 *
 * Two distinct concepts live here:
 *
 *   IntakeLinkLocationPolicy
 *     The operator's choice for a SPECIFIC intake link. Stored on
 *     workflow_intake_links.location_policy. Controls whether the
 *     public contributor page prompts for geolocation.
 *       NONE     — no prompt shown, no browser API call.
 *       OPTIONAL — Share location / Skip; submit succeeds either way.
 *       REQUIRED — submit gated until coordinates are captured (or
 *                  the browser surfaces an "unavailable" terminal
 *                  state).
 *
 *   EvidenceLocationSource
 *     Provenance of the (lat, lng, accuracy_meters) tuple on an
 *     Evidence row. Stored on evidence.location_source. Drives the
 *     display label so reports/verify can honestly attribute the
 *     coordinates to their actual source without overclaiming
 *     ("contributor browser permission" vs "PROOVRA secure capture").
 */

export const INTAKE_LINK_LOCATION_POLICIES = [
  "NONE",
  "OPTIONAL",
  "REQUIRED",
] as const;
export type IntakeLinkLocationPolicy =
  (typeof INTAKE_LINK_LOCATION_POLICIES)[number];

export function isIntakeLinkLocationPolicy(
  value: unknown,
): value is IntakeLinkLocationPolicy {
  return (
    typeof value === "string" &&
    (INTAKE_LINK_LOCATION_POLICIES as readonly string[]).includes(value)
  );
}

/**
 * Operator-facing copy for each policy. Used by the New Intake Link
 * modal and the operations console to describe what each option
 * does without burying the explanation inside the radio label
 * itself (matches the strict-UX modal microcopy pattern).
 */
export const INTAKE_LINK_LOCATION_POLICY_OPTIONS: ReadonlyArray<{
  value: IntakeLinkLocationPolicy;
  title: string;
  description: string;
}> = [
  {
    value: "NONE",
    title: "Do not ask",
    description: "No location prompt is shown.",
  },
  {
    value: "OPTIONAL",
    title: "Ask contributor",
    description: "Contributor can share location to add context.",
  },
  {
    value: "REQUIRED",
    title: "Require before submission",
    description:
      "Contributor must share location before submitting, unless location is unavailable on the device.",
  },
];

/**
 * Public-contributor-facing copy. Distinct from the operator copy:
 * the contributor sees only the prompt — they never see the policy
 * enum names. GDPR-safe phrasing: state WHY location is requested,
 * make optional/required explicit, never overclaim legal value.
 */
export const INTAKE_LINK_LOCATION_PROMPT_COPY: Record<
  IntakeLinkLocationPolicy,
  { title: string; body: string }
> = {
  NONE: { title: "", body: "" },
  OPTIONAL: {
    title: "Add location context",
    body: "Sharing your location is optional and can help the requester understand where the files were submitted from.",
  },
  REQUIRED: {
    title: "Location required",
    body: "This request requires location before submission.",
  },
};

// =============================================================================
// EvidenceLocationSource
// =============================================================================

export const EVIDENCE_LOCATION_SOURCES = [
  "CAPTURE_BROWSER_GEOLOCATION",
  "INTAKE_LINK_GEOLOCATION",
  "EXIF_GPS",
  "MANUAL_ENTRY",
] as const;
export type EvidenceLocationSource = (typeof EVIDENCE_LOCATION_SOURCES)[number];

export function isEvidenceLocationSource(
  value: unknown,
): value is EvidenceLocationSource {
  return (
    typeof value === "string" &&
    (EVIDENCE_LOCATION_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Display label shown to reviewers / on the report / on the public
 * verify page. Kept deliberately humble — coordinates are evidence
 * of what the device/browser reported, not proof of where the
 * original capture happened.
 */
export const EVIDENCE_LOCATION_SOURCE_LABEL: Record<
  EvidenceLocationSource,
  string
> = {
  CAPTURE_BROWSER_GEOLOCATION: "PROOVRA secure capture",
  INTAKE_LINK_GEOLOCATION: "Contributor browser permission",
  EXIF_GPS: "EXIF metadata in the source file",
  MANUAL_ENTRY: "Manually entered by operator",
};

/**
 * Returns the display label for a row's coordinates, defaulting to
 * the historical Capture label when source is null (every pre-
 * migration row with coordinates came from Capture, and the
 * backfill stamps that explicitly — but a defensive default keeps
 * the UI safe if a row slipped through).
 */
export function evidenceLocationSourceLabel(
  source: EvidenceLocationSource | string | null | undefined,
): string {
  if (source && isEvidenceLocationSource(source)) {
    return EVIDENCE_LOCATION_SOURCE_LABEL[source];
  }
  return EVIDENCE_LOCATION_SOURCE_LABEL.CAPTURE_BROWSER_GEOLOCATION;
}

// =============================================================================
// Contributor consent state (recorded on the intake session)
// =============================================================================

/**
 * The decision the contributor made on the public page. Recorded as
 * part of the submit payload so reports can show consent state
 * even when no coordinates were captured (e.g. "Location requested
 * but contributor denied").
 *
 *   NOT_REQUESTED — policy=NONE; the prompt never ran.
 *   GRANTED       — contributor clicked Share AND the browser
 *                   returned coordinates.
 *   DENIED        — contributor clicked Skip (OPTIONAL) or browser
 *                   denied the permission prompt.
 *   UNAVAILABLE   — browser returned a non-permission error
 *                   (timeout, no GPS, etc.); REQUIRED policy
 *                   should surface this as a "contact requester"
 *                   message rather than deadlocking the user.
 */
export const INTAKE_LOCATION_CONSENT_STATES = [
  "NOT_REQUESTED",
  "GRANTED",
  "DENIED",
  "UNAVAILABLE",
] as const;
export type IntakeLocationConsentState =
  (typeof INTAKE_LOCATION_CONSENT_STATES)[number];

export function isIntakeLocationConsentState(
  value: unknown,
): value is IntakeLocationConsentState {
  return (
    typeof value === "string" &&
    (INTAKE_LOCATION_CONSENT_STATES as readonly string[]).includes(value)
  );
}
