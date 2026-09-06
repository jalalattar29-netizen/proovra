/**
 * PROOVRA Feedback System — the disposition of every bounded error code.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The API emits ~100 bounded error codes. `toSafeUserError` maps the ones it
 * knows and buckets the rest by HTTP status, which is a safe default and
 * frequently a useless one: the 401 bucket says "your session expired", and
 * for a mistyped password on the sign-in page that was not merely vague but
 * false. The information needed to say something true was on the wire the
 * whole time.
 *
 * The failure mode is silent. Nothing breaks when a new code has no copy — it
 * just quietly renders as a generic sentence, and nobody finds out until a
 * customer describes a screen nobody can reproduce. So the decision is made
 * explicit HERE and enforced by `__tests__/error-code-coverage.test.ts`: a new
 * bounded code that reaches this repository fails the suite until somebody
 * classifies it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is NOT a second error map. No copy lives here — `toSafeUserError` owns
 * the shared default and each contextual surface owns its overrides. This file
 * records only WHICH of the three treatments a code was deliberately given,
 * and the guard checks the claim against the actual source rather than
 * trusting it.
 *
 * It does NOT demand copy for every code. Most of these should stay generic,
 * and several must. Forcing customer copy onto an anti-enumeration 404 would
 * turn a security property into a defect.
 */

/**
 * CUSTOMER — a person sees a specific, safe explanation.
 *
 *   `where: "global"`     an entry in `toSafeUserError`'s CODE_MAP, shown
 *                         wherever the code appears.
 *   `where: <file path>`  contextual copy owned by one surface, because the
 *                         right sentence depends on where you are standing.
 *                         The guard asserts the file really handles it.
 *
 * GENERIC — deliberately answered by the HTTP-status bucket, and the reason
 * is recorded. Two kinds qualify and no others:
 *   - saying more would leak (existence, tenancy, credentials, policy internals)
 *   - there is genuinely nothing useful to say (an unexpected server fault)
 *
 * INTERNAL — the code cannot reach a customer at all: platform-admin consoles,
 * machine-to-machine integration APIs, cron endpoints, and success/outcome
 * codes that are not failures in the first place.
 */
export type ErrorCodeDisposition =
  | { disposition: "customer"; where: "global" | string }
  | { disposition: "generic"; why: string }
  | { disposition: "internal"; why: string };

const PUBLIC_INTAKE = "apps/web/app/intake/[token]/page.tsx";
const REGISTER = "apps/web/app/register/page.tsx";

export const ERROR_CODE_DISPOSITIONS: Readonly<
  Record<string, ErrorCodeDisposition>
> = {
  // -- Authentication -------------------------------------------------------
  INVALID_CREDENTIALS: { disposition: "customer", where: "global" },
  EMAIL_NOT_VERIFIED: { disposition: "customer", where: "global" },
  EMAIL_ALREADY_EXISTS: { disposition: "customer", where: REGISTER },
  MFA_POLICY_VERSION_CONFLICT: { disposition: "customer", where: "global" },
  INVALID_OR_EXPIRED: {
    disposition: "generic",
    why:
      "Email verification and password-reset tokens. Distinguishing 'expired' from " +
      "'never existed' would confirm that an address is registered, which is the " +
      "one thing these flows refuse to say.",
  },

  // -- Validation -----------------------------------------------------------
  VALIDATION_ERROR: { disposition: "customer", where: "global" },
  INVALID_REQUEST: { disposition: "customer", where: "global" },
  INVALID_BODY: { disposition: "customer", where: "global" },
  INVALID_QUERY: { disposition: "customer", where: "global" },
  INVALID_IDENTIFIER: { disposition: "customer", where: "global" },
  INVALID_ORG_ID: { disposition: "customer", where: "global" },
  INVALID_WORKSPACE_ID: { disposition: "customer", where: "global" },
  INVALID_CURSOR: {
    disposition: "internal",
    why: "A pagination cursor the UI produced itself; a person never types one.",
  },

  // -- Authorization / anti-enumeration ------------------------------------
  FORBIDDEN: { disposition: "customer", where: "global" },
  NOT_FOUND: { disposition: "customer", where: "global" },
  CASE_NOT_FOUND: {
    disposition: "generic",
    why:
      "Anti-enumeration. A case outside the caller's tenancy answers exactly as a " +
      "case that does not exist; naming the difference is the leak.",
  },
  EVIDENCE_NOT_FOUND: {
    disposition: "generic",
    why: "Anti-enumeration, as CASE_NOT_FOUND.",
  },
  GRANT_NOT_FOUND: {
    disposition: "generic",
    why: "Anti-enumeration, as CASE_NOT_FOUND.",
  },
  EXPORT_SNAPSHOT_NOT_FOUND: {
    disposition: "generic",
    why: "Anti-enumeration, as CASE_NOT_FOUND.",
  },
  CROSS_TENANT: {
    disposition: "generic",
    why:
      "The refusal itself confirms that the named resource exists in SOME other " +
      "workspace. It must read as an ordinary 404.",
  },
  REVIEW_PERMISSION_DENIED: { disposition: "customer", where: "global" },
  REVIEW_ACTOR_BLOCKED: { disposition: "customer", where: "global" },
  CASES_MANAGE_REQUIRED: { disposition: "customer", where: "global" },
  CASE_DELETE_DENIED: { disposition: "customer", where: "global" },
  CASE_RENAME_DENIED: { disposition: "customer", where: "global" },
  WORKSPACE_MEMBERSHIP_REQUIRED: { disposition: "customer", where: "global" },
  WORKSPACE_CONTEXT_REQUIRED: { disposition: "customer", where: "global" },
  WORKSPACE_CREATION_NOT_SELF_SERVICE: {
    disposition: "customer",
    where: "global",
  },
  STALE_MEMBERSHIP_GENERATION: { disposition: "customer", where: "global" },
  ILLEGAL_MEMBERSHIP_TRANSITION: { disposition: "customer", where: "global" },
  INTERNAL_MEMBER: { disposition: "customer", where: "global" },
  OWNERSHIP_TRANSFER_REQUIRED: { disposition: "customer", where: "global" },
  TRANSFER_TARGET_REQUIRED: { disposition: "customer", where: "global" },
  INVALID_TRANSFER_TARGET: { disposition: "customer", where: "global" },

  // -- Security posture -----------------------------------------------------
  STEP_UP_ENROLLMENT_REQUIRED: { disposition: "customer", where: "global" },
  HIGH_SECURITY_PREREQUISITES_UNMET: { disposition: "customer", where: "global" },
  GOVERNANCE_CHECK_FAILED: {
    disposition: "generic",
    why:
      "The governance evaluation itself failed, so the platform does not know why " +
      "the action was refused. Inventing a reason would be worse than the bucket.",
  },
  POLICY_NOT_PROVISIONED: { disposition: "customer", where: "global" },
  ORG_SECURITY_POLICY_NOT_APPLICABLE: {
    disposition: "internal",
    why: "Organization security administration console.",
  },
  SUPPORT_CONTEXT_ENTRY_DENIED: {
    disposition: "internal",
    why: "PROOVRA support break-glass; never rendered to a customer.",
  },
  SUPPORT_ACCESS_APPROVER_INVALID: {
    disposition: "internal",
    why: "PROOVRA support break-glass; never rendered to a customer.",
  },

  // -- Rate limiting --------------------------------------------------------
  RATE_LIMITED: { disposition: "customer", where: "global" },
  AI_CHAT_RATE_LIMITED: { disposition: "customer", where: "global" },
  AI_CHAT_TIMEOUT: { disposition: "customer", where: "global" },
  AI_WORKSPACE_POLICY_DENIED: { disposition: "customer", where: "global" },

  // -- Evidence lifecycle ---------------------------------------------------
  EVIDENCE_NOT_FINALIZED: { disposition: "customer", where: "global" },
  EVIDENCE_NOT_LOCKED: { disposition: "customer", where: "global" },
  EVIDENCE_INTEGRITY_FAILED: { disposition: "customer", where: "global" },
  FINALIZE_BLOCKED_BY_UPLOAD_SESSION: { disposition: "customer", where: "global" },
  VERIFICATION_TEMPORARILY_UNAVAILABLE: { disposition: "customer", where: "global" },
  VERIFICATION_POLICY_BLOCKED: { disposition: "customer", where: "global" },
  SIGNING_KEY_MISSING: { disposition: "customer", where: "global" },
  INSUFFICIENT_CREDITS: { disposition: "customer", where: "global" },
  STORAGE_LIMIT_REACHED: { disposition: "customer", where: "global" },
  CAPTURE_SESSION_NOT_EDITABLE: { disposition: "customer", where: "global" },
  DERIVATIVE_DOWNLOADED: {
    disposition: "internal",
    why: "An outcome code on a successful download, not a failure.",
  },
  CAPTURE_ARTIFACT_RECEIVED: {
    disposition: "internal",
    why: "A capture-trust outcome code, not a failure.",
  },
  CAPTURE_ARTIFACT_SIGNED_AT_SOURCE: {
    disposition: "internal",
    why: "A capture-trust outcome code, not a failure.",
  },
  CAPTURE_ARTIFACT_VERIFICATION_FAILED: {
    disposition: "internal",
    why: "A capture-trust attestation outcome consumed by the device pipeline.",
  },

  // -- Public external intake ----------------------------------------------
  INVALID_OR_EXPIRED_LINK: { disposition: "customer", where: PUBLIC_INTAKE },
  LINK_NO_LONGER_AVAILABLE: { disposition: "customer", where: PUBLIC_INTAKE },
  LINK_ALREADY_SUBMITTED: { disposition: "customer", where: PUBLIC_INTAKE },
  CONSENT_REQUIRED: { disposition: "customer", where: PUBLIC_INTAKE },
  CONSENT_INVALID: { disposition: "customer", where: PUBLIC_INTAKE },
  SESSION_TERMINAL: { disposition: "customer", where: PUBLIC_INTAKE },
  SESSION_NOT_OPEN_FOR_UPLOAD: { disposition: "customer", where: PUBLIC_INTAKE },
  SESSION_NOT_FOUND: { disposition: "customer", where: PUBLIC_INTAKE },
  MAX_FILES_REACHED: { disposition: "customer", where: PUBLIC_INTAKE },
  MIME_TYPE_NOT_ALLOWED: { disposition: "customer", where: PUBLIC_INTAKE },
  FILE_VALIDATION_BLOCKED: { disposition: "customer", where: PUBLIC_INTAKE },
  PART_INDEX_TAKEN: { disposition: "customer", where: PUBLIC_INTAKE },
  SUBMITTER_IDENTITY_INVALID: { disposition: "customer", where: PUBLIC_INTAKE },
  SUBMISSION_NOT_READY: { disposition: "customer", where: PUBLIC_INTAKE },
  SUBMIT_FAILED: { disposition: "customer", where: PUBLIC_INTAKE },
  TRANSITION_NOT_ALLOWED: { disposition: "customer", where: PUBLIC_INTAKE },
  LOCATION_REQUIRED: { disposition: "customer", where: PUBLIC_INTAKE },
  INVALID_LOCATION_BODY: { disposition: "customer", where: PUBLIC_INTAKE },
  INTAKE_MODE_MISMATCH: { disposition: "customer", where: PUBLIC_INTAKE },
  /*
   * The public face of a commercial refusal, and the reason it is CONTEXTUAL
   * rather than global: the authenticated codes above name the plan, the
   * allowance and the remedy, and every one of those facts belongs to the
   * receiving organization. The contributor holds a link and nothing else, so
   * this surface says what is true for them — the intake cannot take files,
   * their file is fine, talk to the sender — and the commercial detail stays
   * on the sender's side of the boundary.
   */
  INTAKE_NOT_ACCEPTING_EVIDENCE: {
    disposition: "customer",
    where: PUBLIC_INTAKE,
  },
  INTAKE_LINK_BLOCKED_BY_POLICY: {
    disposition: "internal",
    why: "The machine-to-machine integrations API; the caller is a program.",
  },

  // -- Commercial -----------------------------------------------------------
  TEAM_PLAN_REQUIRED: { disposition: "customer", where: "global" },
  /*
   * The evidence-record allowance. Global copy: the same three codes reach
   * Capture, the mobile ingest and any other authenticated creation surface,
   * and the sentence does not change with where you are standing.
   */
  EVIDENCE_RECORD_LIMIT_REACHED: { disposition: "customer", where: "global" },
  FREE_LIMIT_REACHED: { disposition: "customer", where: "global" },
  EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED: {
    disposition: "customer",
    where: "global",
  },
  INSUFFICIENT_EVIDENCE_CREDITS: { disposition: "customer", where: "global" },
  SUBSCRIPTION_NOT_FOUND: { disposition: "customer", where: "global" },
  SUBSCRIPTION_ALREADY_ACTIVE: { disposition: "customer", where: "global" },
  CHECKOUT_REQUIRED: { disposition: "customer", where: "global" },
  CANCELLATION_REQUIRED: { disposition: "customer", where: "global" },
  PROVIDER_CANCELLATION_FAILED: { disposition: "customer", where: "global" },
  STORAGE_ADDON_NOT_FOUND: { disposition: "customer", where: "global" },
  STORAGE_ADDON_NOT_LINKED: { disposition: "customer", where: "global" },
  LEGACY_ONE_TIME_ADDON_NOT_CANCELLABLE: {
    disposition: "customer",
    where: "global",
  },

  // -- Feature availability -------------------------------------------------
  FEATURE_DISABLED: { disposition: "customer", where: "global" },
  INTEGRATIONS_DISABLED: {
    disposition: "internal",
    why:
      "An operator-side feature flag on the integrations surface. It is returned " +
      "identically to every role including the owner, so it is not an " +
      "authorization signal and there is no customer decision behind it.",
  },
  NOT_PUBLISHED: {
    disposition: "internal",
    why: "Reviewer criteria authoring; an operator console.",
  },
  API_KEYS_LEGACY_RETIRED: {
    disposition: "internal",
    why: "A retired endpoint answering a legacy client, not a person.",
  },
  PERSONAL_SECURITY_LEGACY_RETIRED: {
    disposition: "internal",
    why: "A retired endpoint answering a legacy client, not a person.",
  },
  COLLABORATION_TEAM_INVITE_RETIRED: {
    disposition: "internal",
    why:
      "A retired endpoint answering a legacy client, not a person. There is " +
      "ONE invitation authority now — into the WORKSPACE, where acceptance " +
      "claims a seat — and a group is filled by assigning people who already " +
      "hold one. No surface offers this action, so the only caller left is a " +
      "stale client or a direct API call.",
  },
  COLLABORATION_TEAM_NOTIFICATIONS_RETIRED: {
    disposition: "internal",
    why:
      "A retired second reader answering a legacy client, not a person. Team " +
      "notifications are read in the Inbox, which reads the same rows and " +
      "marks the same read state; two surfaces over one column presented as " +
      "two inboxes with two unread counts.",
  },
  COLLABORATION_TEAM_PREFERENCES_RETIRED: {
    disposition: "internal",
    why:
      "A retired third preference store answering a legacy client, not a " +
      "person. Notification preferences live in Settings; a per-team store " +
      "with no stated precedence against workspace and organization policy " +
      "is a store nobody can trust.",
  },
  COLLABORATION_TEAM_GUESTS_RETIRED: {
    disposition: "internal",
    why:
      "A retired operation answering a legacy client, not a person. Guest " +
      "invitation wrote a row and granted nothing — no email was sent and no " +
      "read path consulted the table — so the surface was removed and " +
      "external reviewers are granted access by the external-review " +
      "authority. Existing rows stay readable and revocable.",
  },

  // -- Operator / platform-admin only --------------------------------------
  HEALTH_SNAPSHOT_UNAVAILABLE: {
    disposition: "internal",
    why: "Platform telemetry console.",
  },
  METRICS_SCRAPE_TOKEN_TOO_WEAK: {
    disposition: "internal",
    why: "A deployment configuration refusal, read by an operator.",
  },
  REVIEWER_OPS_CRON_SECRET_NOT_CONFIGURED: {
    disposition: "internal",
    why: "A cron endpoint; the caller is a scheduler.",
  },
  DEPARTMENT_MEMBERSHIP_GRANTED: {
    disposition: "internal",
    why: "A governance outcome code, not a failure.",
  },
  DEPARTMENT_MEMBERSHIP_REVOKED: {
    disposition: "internal",
    why: "A governance outcome code, not a failure.",
  },
  POLICY_EVALUATED: {
    disposition: "internal",
    why: "A governance outcome code, not a failure.",
  },
  REVIEW_OPENED: {
    disposition: "internal",
    why: "An external-portal outcome code, not a failure.",
  },
  GRANT_RESENT: {
    disposition: "internal",
    why: "An external-portal outcome code, not a failure.",
  },

  // -- Genuine server faults ------------------------------------------------
  INTERNAL_ERROR: {
    disposition: "generic",
    why:
      "An unexpected fault. The platform does not know what happened, so the only " +
      "honest answer is the generic retry line; the request id carries the detail " +
      "to support.",
  },
  INTERNAL_SERVER_ERROR: {
    disposition: "generic",
    why: "As INTERNAL_ERROR.",
  },
};

/** Every code the registry has an explicit decision for. */
export function classifiedErrorCodes(): string[] {
  return Object.keys(ERROR_CODE_DISPOSITIONS).sort();
}
