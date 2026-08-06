export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_REQUEST = "INVALID_REQUEST",
  MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
  INVALID_FILE_TYPE = "INVALID_FILE_TYPE",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  INVALID_MIME_TYPE = "INVALID_MIME_TYPE",

  UNAUTHORIZED = "UNAUTHORIZED",
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  MISSING_AUTH_HEADER = "MISSING_AUTH_HEADER",

  FORBIDDEN = "FORBIDDEN",
  INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",
  SUBSCRIPTION_REQUIRED = "SUBSCRIPTION_REQUIRED",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",

  NOT_FOUND = "NOT_FOUND",
  EVIDENCE_NOT_FOUND = "EVIDENCE_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  CASE_NOT_FOUND = "CASE_NOT_FOUND",
  TEAM_NOT_FOUND = "TEAM_NOT_FOUND",
  WEBHOOK_NOT_FOUND = "WEBHOOK_NOT_FOUND",

  CONFLICT = "CONFLICT",
  EMAIL_ALREADY_EXISTS = "EMAIL_ALREADY_EXISTS",
  DUPLICATE_EVIDENCE = "DUPLICATE_EVIDENCE",
  EVIDENCE_LOCKED = "EVIDENCE_LOCKED",

  INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION",
  EVIDENCE_ALREADY_SIGNED = "EVIDENCE_ALREADY_SIGNED",
  INVALID_VERIFICATION_TOKEN = "INVALID_VERIFICATION_TOKEN",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  SUBSCRIPTION_INACTIVE = "SUBSCRIPTION_INACTIVE",

  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  STORAGE_ERROR = "STORAGE_ERROR",
  EMAIL_SERVICE_ERROR = "EMAIL_SERVICE_ERROR",
  PAYMENT_SERVICE_ERROR = "PAYMENT_SERVICE_ERROR",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",

  WEBHOOK_DELIVERY_FAILED = "WEBHOOK_DELIVERY_FAILED",
  WEBHOOK_SIGNATURE_INVALID = "WEBHOOK_SIGNATURE_INVALID",

  // Phase 20 — standardized response codes. Routes should prefer
  // these over ad-hoc strings. They mirror the inline values already
  // returned by Phase 18/19 routes (STEP_UP_REQUIRED,
  // HIGH_RISK_ACTION_BLOCKED, RATE_LIMITED), so adopting them is
  // backwards-compatible at the wire level.
  STEP_UP_REQUIRED = "STEP_UP_REQUIRED",
  HIGH_RISK_ACTION_BLOCKED = "HIGH_RISK_ACTION_BLOCKED",
  GOVERNANCE_BLOCKED = "GOVERNANCE_BLOCKED",
  RATE_LIMITED = "RATE_LIMITED",
  PROVIDER_ERROR = "PROVIDER_ERROR",
  PRODUCTION_CONFIG_VIOLATION = "PRODUCTION_CONFIG_VIOLATION",

  // PHASE 10 §1 — the Organization security context could not be evaluated
  // because of an INFRASTRUCTURE failure (policy/workspace/org/SSO/session read
  // threw). Enforcement FAILS CLOSED with this generic, non-enumerating 503 —
  // the request never reaches the route handler. Distinct from 401
  // (reauthenticate) which means an invalid/non-compliant session.
  SECURITY_CONTEXT_UNAVAILABLE = "SECURITY_CONTEXT_UNAVAILABLE",
}

export interface ErrorDetails {
  field?: string;
  reason?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    timestamp: string;
    details?: ErrorDetails;
  };
}

export function getStatusCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.INVALID_REQUEST:
    case ErrorCode.MISSING_REQUIRED_FIELD:
    case ErrorCode.INVALID_FILE_TYPE:
    case ErrorCode.FILE_TOO_LARGE:
    case ErrorCode.INVALID_MIME_TYPE:
      return 400;

    case ErrorCode.UNAUTHORIZED:
    case ErrorCode.INVALID_TOKEN:
    case ErrorCode.TOKEN_EXPIRED:
    case ErrorCode.INVALID_CREDENTIALS:
    case ErrorCode.MISSING_AUTH_HEADER:
    case ErrorCode.STEP_UP_REQUIRED:
      return 401;

    case ErrorCode.FORBIDDEN:
    case ErrorCode.INSUFFICIENT_PERMISSIONS:
    case ErrorCode.SUBSCRIPTION_REQUIRED:
    case ErrorCode.HIGH_RISK_ACTION_BLOCKED:
    case ErrorCode.GOVERNANCE_BLOCKED:
      return 403;

    case ErrorCode.RATE_LIMIT_EXCEEDED:
    case ErrorCode.RATE_LIMITED:
      return 429;

    case ErrorCode.PROVIDER_ERROR:
      return 502;

    case ErrorCode.PRODUCTION_CONFIG_VIOLATION:
      return 503;

    case ErrorCode.SECURITY_CONTEXT_UNAVAILABLE:
      return 503;

    case ErrorCode.NOT_FOUND:
    case ErrorCode.EVIDENCE_NOT_FOUND:
    case ErrorCode.USER_NOT_FOUND:
    case ErrorCode.CASE_NOT_FOUND:
    case ErrorCode.TEAM_NOT_FOUND:
    case ErrorCode.WEBHOOK_NOT_FOUND:
      return 404;

    case ErrorCode.CONFLICT:
    case ErrorCode.EMAIL_ALREADY_EXISTS:
    case ErrorCode.DUPLICATE_EVIDENCE:
    case ErrorCode.EVIDENCE_LOCKED:
      return 409;

    case ErrorCode.INVALID_STATE_TRANSITION:
    case ErrorCode.EVIDENCE_ALREADY_SIGNED:
    case ErrorCode.INVALID_VERIFICATION_TOKEN:
    case ErrorCode.PAYMENT_FAILED:
    case ErrorCode.SUBSCRIPTION_INACTIVE:
      return 422;

    case ErrorCode.INTERNAL_SERVER_ERROR:
    case ErrorCode.DATABASE_ERROR:
    case ErrorCode.STORAGE_ERROR:
    case ErrorCode.EMAIL_SERVICE_ERROR:
    case ErrorCode.PAYMENT_SERVICE_ERROR:
    case ErrorCode.EXTERNAL_SERVICE_ERROR:
    case ErrorCode.WEBHOOK_DELIVERY_FAILED:
    case ErrorCode.WEBHOOK_SIGNATURE_INVALID:
    default:
      return 500;
  }
}

export function getErrorMessage(code: ErrorCode): string {
  const messages: Record<ErrorCode, string> = {
    [ErrorCode.VALIDATION_ERROR]: "Request validation failed",
    [ErrorCode.INVALID_REQUEST]: "Invalid request format",
    [ErrorCode.MISSING_REQUIRED_FIELD]: "Missing required field",
    [ErrorCode.INVALID_FILE_TYPE]: "Invalid file type",
    [ErrorCode.FILE_TOO_LARGE]: "File exceeds maximum size",
    [ErrorCode.INVALID_MIME_TYPE]: "Invalid MIME type",

    [ErrorCode.UNAUTHORIZED]: "Authentication required",
    [ErrorCode.INVALID_TOKEN]: "Invalid or malformed token",
    [ErrorCode.TOKEN_EXPIRED]: "Authentication token has expired",
    [ErrorCode.INVALID_CREDENTIALS]: "Invalid credentials",
    [ErrorCode.MISSING_AUTH_HEADER]: "Missing authentication header",

    [ErrorCode.FORBIDDEN]: "Access denied",
    [ErrorCode.INSUFFICIENT_PERMISSIONS]: "Insufficient permissions",
    [ErrorCode.SUBSCRIPTION_REQUIRED]: "Active subscription required",
    [ErrorCode.RATE_LIMIT_EXCEEDED]: "Rate limit exceeded",

    [ErrorCode.NOT_FOUND]: "Resource not found",
    [ErrorCode.EVIDENCE_NOT_FOUND]: "Evidence not found",
    [ErrorCode.USER_NOT_FOUND]: "User not found",
    [ErrorCode.CASE_NOT_FOUND]: "Case not found",
    [ErrorCode.TEAM_NOT_FOUND]: "Team not found",
    [ErrorCode.WEBHOOK_NOT_FOUND]: "Webhook not found",

    [ErrorCode.CONFLICT]: "Resource conflict",
    [ErrorCode.EMAIL_ALREADY_EXISTS]: "Email already registered",
    [ErrorCode.DUPLICATE_EVIDENCE]: "Duplicate evidence",
    [ErrorCode.EVIDENCE_LOCKED]: "Evidence is locked",

    [ErrorCode.INVALID_STATE_TRANSITION]: "Invalid state transition",
    [ErrorCode.EVIDENCE_ALREADY_SIGNED]: "Evidence already signed",
    [ErrorCode.INVALID_VERIFICATION_TOKEN]: "Invalid verification token",
    [ErrorCode.PAYMENT_FAILED]: "Payment processing failed",
    [ErrorCode.SUBSCRIPTION_INACTIVE]: "Subscription is inactive",

    [ErrorCode.INTERNAL_SERVER_ERROR]: "Internal server error",
    [ErrorCode.DATABASE_ERROR]: "Database error",
    [ErrorCode.STORAGE_ERROR]: "Storage error",
    [ErrorCode.EMAIL_SERVICE_ERROR]: "Email service error",
    [ErrorCode.PAYMENT_SERVICE_ERROR]: "Payment service error",
    [ErrorCode.EXTERNAL_SERVICE_ERROR]: "External service error",

    [ErrorCode.WEBHOOK_DELIVERY_FAILED]: "Webhook delivery failed",
    [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: "Invalid webhook signature",

    // Phase 20 — standardized operational messages. Operator-facing
    // only; user-facing surfaces should map these codes to the
    // localised string at the UI layer.
    [ErrorCode.STEP_UP_REQUIRED]: "Step-up verification required.",
    [ErrorCode.HIGH_RISK_ACTION_BLOCKED]:
      "Access restricted. Contact a workspace administrator.",
    [ErrorCode.GOVERNANCE_BLOCKED]:
      "Action blocked by workspace governance policy.",
    [ErrorCode.RATE_LIMITED]: "Too many requests. Try again later.",
    [ErrorCode.PROVIDER_ERROR]:
      "Upstream provider returned an error. Try again later.",
    [ErrorCode.PRODUCTION_CONFIG_VIOLATION]:
      "Service is misconfigured. Contact an operator.",
    [ErrorCode.SECURITY_CONTEXT_UNAVAILABLE]:
      "The security context is temporarily unavailable. Please retry.",
  };

  return messages[code] ?? "An unexpected error occurred";
}

export class AppError extends Error {
  code: ErrorCode;
  statusCode: number;
  details?: ErrorDetails;

  constructor(code: ErrorCode, message?: string, details?: ErrorDetails) {
    super(message ?? getErrorMessage(code));
    this.code = code;
    this.statusCode = getStatusCode(code);
    this.details = details;
    this.name = "AppError";
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function createErrorResponse(
  code: ErrorCode,
  requestId?: string,
  details?: ErrorDetails,
  customMessage?: string
): ErrorResponse {
  return {
    error: {
      code,
      message: customMessage ?? getErrorMessage(code),
      requestId,
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {}),
    },
  };
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

// =============================================================================
// PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): typed domain errors with an
// explicit REPORTABILITY classification.
// =============================================================================
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// The platform had two error shapes. `AppError` (above) is the structured one
// the central handler understands. Everywhere else — commercial enforcement,
// team limits, identity mode, org policy — the convention was a plain `Error`
// with `statusCode` and `code` assigned onto it. The central handler's
// `normalizeUnknownError` recognises only `AppError` and `ZodError`, so every
// error of the second shape fell through to the "infrastructure" branch:
// captured to Sentry as a high-priority error, paged as an operational alert,
// and returned to the client as a 500.
//
// That is how "Free evidence limit reached" — a user hitting a published plan
// limit, the most ordinary outcome in the product — became an error-level
// Sentry issue. It is also why the route arm meant to catch it never fired:
// it compared `err.message === "FREE_LIMIT_REACHED"` against a message that
// reads "Free evidence limit reached", so the string never matched and nobody
// noticed, because the fallthrough returned a plausible-looking failure.
//
// WHAT REPORTABILITY IS FOR
// -----------------------------------------------------------------------------
// The fix is NOT "suppress 4xx". Some 4xx are exactly what an operator needs to
// see — a cross-tenant probe, a step-up bypass attempt. So the error itself
// declares what it is, and the handler obeys:
//
//   EXPECTED_DENIAL      a published product rule refusing a request. Warn-log,
//                        canonical 4xx, no capture, no alert.
//   OPERATIONAL_WARNING  a real operational condition the tenant cannot fix and
//                        an operator should see, but which is not a crash — a
//                        required dependency that is not provisioned. Warn-log
//                        + bounded metric, canonical 4xx/5xx, no error-level
//                        capture.
//   SECURITY_SIGNAL      a denial that is ALSO telemetry: bounded security
//                        event, still no error-level page.
//   UNEXPECTED           everything else. Captured, alerted, 500.
//
// A thrower that says nothing is still UNEXPECTED. Silence keeps meaning
// "something is wrong", which is the only safe default.

export type ErrorReportability =
  | "EXPECTED_DENIAL"
  | "OPERATIONAL_WARNING"
  | "SECURITY_SIGNAL"
  | "UNEXPECTED";

export type DomainErrorSeverity = "info" | "warning" | "critical";

export type DomainErrorInit = {
  /** HTTP status the API contract already uses for this outcome. */
  httpStatus: number;
  /** Stable machine code the client renders remediation from. */
  publicCode: string;
  /**
   * What the CLIENT is told. Bounded and free of identifiers: no UUIDs, no SQL,
   * no stack, no internal implementation detail. The `message` (developer
   * text) may be richer; only this crosses the wire.
   */
  publicMessage: string;
  reportability: ErrorReportability;
  severity?: DomainErrorSeverity;
  /** Bounded, non-sensitive detail for the audit/metric record. */
  metadata?: Record<string, string | number | boolean | null>;
};

export class DomainError extends Error {
  readonly httpStatus: number;
  readonly publicCode: string;
  readonly publicMessage: string;
  readonly reportability: ErrorReportability;
  readonly severity: DomainErrorSeverity;
  readonly metadata: Record<string, string | number | boolean | null>;

  /**
   * `statusCode` and `code` mirror `httpStatus` / `publicCode` so the many
   * existing call sites that duck-type `err.statusCode` / `err.code` keep
   * working unchanged. This is compatibility, not a second vocabulary: both
   * are read-only projections of the canonical fields.
   */
  readonly statusCode: number;
  readonly code: string;

  constructor(developerMessage: string, init: DomainErrorInit) {
    super(developerMessage);
    this.name = "DomainError";
    this.httpStatus = init.httpStatus;
    this.publicCode = init.publicCode;
    this.publicMessage = init.publicMessage;
    this.reportability = init.reportability;
    this.severity =
      init.severity ?? (init.reportability === "UNEXPECTED" ? "critical" : "warning");
    this.metadata = init.metadata ?? {};
    this.statusCode = init.httpStatus;
    this.code = init.publicCode;
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * The reportability of ANY thrown value, for the one capture decision.
 *
 * A `DomainError` states its own. Everything else is classified structurally,
 * and the rule is deliberately narrow: an error carrying a 4xx `statusCode` is
 * a client-visible outcome the route already decided on, so it is not a server
 * fault — but it is only downgraded to EXPECTED_DENIAL, never suppressed, and
 * anything without a 4xx stays UNEXPECTED.
 *
 * This is the belt-and-braces half of the fix. The commercial and policy
 * authorities now throw `DomainError` explicitly; this catches the ad-hoc
 * throwers that have not been converted yet, so a plan limit somewhere else in
 * the codebase cannot page an operator while it waits its turn.
 */
export function classifyReportability(error: unknown): ErrorReportability {
  if (isDomainError(error)) return error.reportability;
  if (isAppError(error)) {
    return error.statusCode >= 400 && error.statusCode < 500
      ? "EXPECTED_DENIAL"
      : "UNEXPECTED";
  }
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return "EXPECTED_DENIAL";
  }
  return "UNEXPECTED";
}
