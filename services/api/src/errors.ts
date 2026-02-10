/**
 * Standardized API Error System
 * Provides consistent error codes, types, and response formatting
 */

export enum ErrorCode {
  // Validation errors (400)
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_REQUEST = "INVALID_REQUEST",
  MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
  INVALID_FILE_TYPE = "INVALID_FILE_TYPE",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  INVALID_MIME_TYPE = "INVALID_MIME_TYPE",

  // Authentication errors (401)
  UNAUTHORIZED = "UNAUTHORIZED",
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  MISSING_AUTH_HEADER = "MISSING_AUTH_HEADER",

  // Authorization errors (403)
  FORBIDDEN = "FORBIDDEN",
  INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",
  SUBSCRIPTION_REQUIRED = "SUBSCRIPTION_REQUIRED",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",

  // Not found errors (404)
  NOT_FOUND = "NOT_FOUND",
  EVIDENCE_NOT_FOUND = "EVIDENCE_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  CASE_NOT_FOUND = "CASE_NOT_FOUND",
  TEAM_NOT_FOUND = "TEAM_NOT_FOUND",
  WEBHOOK_NOT_FOUND = "WEBHOOK_NOT_FOUND",

  // Conflict errors (409)
  CONFLICT = "CONFLICT",
  EMAIL_ALREADY_EXISTS = "EMAIL_ALREADY_EXISTS",
  DUPLICATE_EVIDENCE = "DUPLICATE_EVIDENCE",
  EVIDENCE_LOCKED = "EVIDENCE_LOCKED",

  // Business logic errors (422)
  INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION",
  EVIDENCE_ALREADY_SIGNED = "EVIDENCE_ALREADY_SIGNED",
  INVALID_VERIFICATION_TOKEN = "INVALID_VERIFICATION_TOKEN",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  SUBSCRIPTION_INACTIVE = "SUBSCRIPTION_INACTIVE",

  // Server errors (500)
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  STORAGE_ERROR = "STORAGE_ERROR",
  EMAIL_SERVICE_ERROR = "EMAIL_SERVICE_ERROR",
  PAYMENT_SERVICE_ERROR = "PAYMENT_SERVICE_ERROR",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",

  // Webhook errors (webhook-specific)
  WEBHOOK_DELIVERY_FAILED = "WEBHOOK_DELIVERY_FAILED",
  WEBHOOK_SIGNATURE_INVALID = "WEBHOOK_SIGNATURE_INVALID",
}

export interface ErrorDetails {
  field?: string;
  reason?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  statusCode: number;
  details?: ErrorDetails;
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

/**
 * Map error codes to HTTP status codes
 */
export function getStatusCode(code: ErrorCode): number {
  switch (code) {
    // 400 Bad Request
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.INVALID_REQUEST:
    case ErrorCode.MISSING_REQUIRED_FIELD:
    case ErrorCode.INVALID_FILE_TYPE:
    case ErrorCode.FILE_TOO_LARGE:
    case ErrorCode.INVALID_MIME_TYPE:
      return 400;

    // 401 Unauthorized
    case ErrorCode.UNAUTHORIZED:
    case ErrorCode.INVALID_TOKEN:
    case ErrorCode.TOKEN_EXPIRED:
    case ErrorCode.INVALID_CREDENTIALS:
    case ErrorCode.MISSING_AUTH_HEADER:
      return 401;

    // 403 Forbidden
    case ErrorCode.FORBIDDEN:
    case ErrorCode.INSUFFICIENT_PERMISSIONS:
    case ErrorCode.SUBSCRIPTION_REQUIRED:
    case ErrorCode.RATE_LIMIT_EXCEEDED:
      return 403;

    // 404 Not Found
    case ErrorCode.NOT_FOUND:
    case ErrorCode.EVIDENCE_NOT_FOUND:
    case ErrorCode.USER_NOT_FOUND:
    case ErrorCode.CASE_NOT_FOUND:
    case ErrorCode.TEAM_NOT_FOUND:
    case ErrorCode.WEBHOOK_NOT_FOUND:
      return 404;

    // 409 Conflict
    case ErrorCode.CONFLICT:
    case ErrorCode.EMAIL_ALREADY_EXISTS:
    case ErrorCode.DUPLICATE_EVIDENCE:
    case ErrorCode.EVIDENCE_LOCKED:
      return 409;

    // 422 Unprocessable Entity
    case ErrorCode.INVALID_STATE_TRANSITION:
    case ErrorCode.EVIDENCE_ALREADY_SIGNED:
    case ErrorCode.INVALID_VERIFICATION_TOKEN:
    case ErrorCode.PAYMENT_FAILED:
    case ErrorCode.SUBSCRIPTION_INACTIVE:
      return 422;

    // 500 Internal Server Error
    case ErrorCode.INTERNAL_SERVER_ERROR:
    case ErrorCode.DATABASE_ERROR:
    case ErrorCode.STORAGE_ERROR:
    case ErrorCode.EMAIL_SERVICE_ERROR:
    case ErrorCode.PAYMENT_SERVICE_ERROR:
    case ErrorCode.EXTERNAL_SERVICE_ERROR:
    case ErrorCode.WEBHOOK_DELIVERY_FAILED:
    case ErrorCode.WEBHOOK_SIGNATURE_INVALID:
      return 500;

    default:
      return 500;
  }
}

/**
 * Get human-readable message for error code
 */
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
  };

  return messages[code] ?? "An unexpected error occurred";
}

/**
 * Custom API error class
 */
export class AppError extends Error {
  code: ErrorCode;
  statusCode: number;
  details?: ErrorDetails;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: ErrorDetails
  ) {
    super(message ?? getErrorMessage(code));
    this.code = code;
    this.statusCode = getStatusCode(code);
    this.details = details;
    this.name = "AppError";
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Create error response for API
 */
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
      ...(details && { details }),
    },
  };
}

/**
 * Type guard for AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Type guard for validation error
 */
export function isValidationError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === ErrorCode.VALIDATION_ERROR ||
      error.code === ErrorCode.MISSING_REQUIRED_FIELD ||
      error.code === ErrorCode.INVALID_REQUEST)
  );
}
