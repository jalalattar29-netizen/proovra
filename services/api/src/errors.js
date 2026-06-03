export var ErrorCode;
(function (ErrorCode) {
    ErrorCode["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    ErrorCode["INVALID_REQUEST"] = "INVALID_REQUEST";
    ErrorCode["MISSING_REQUIRED_FIELD"] = "MISSING_REQUIRED_FIELD";
    ErrorCode["INVALID_FILE_TYPE"] = "INVALID_FILE_TYPE";
    ErrorCode["FILE_TOO_LARGE"] = "FILE_TOO_LARGE";
    ErrorCode["INVALID_MIME_TYPE"] = "INVALID_MIME_TYPE";
    ErrorCode["UNAUTHORIZED"] = "UNAUTHORIZED";
    ErrorCode["INVALID_TOKEN"] = "INVALID_TOKEN";
    ErrorCode["TOKEN_EXPIRED"] = "TOKEN_EXPIRED";
    ErrorCode["INVALID_CREDENTIALS"] = "INVALID_CREDENTIALS";
    ErrorCode["MISSING_AUTH_HEADER"] = "MISSING_AUTH_HEADER";
    ErrorCode["FORBIDDEN"] = "FORBIDDEN";
    ErrorCode["INSUFFICIENT_PERMISSIONS"] = "INSUFFICIENT_PERMISSIONS";
    ErrorCode["SUBSCRIPTION_REQUIRED"] = "SUBSCRIPTION_REQUIRED";
    ErrorCode["RATE_LIMIT_EXCEEDED"] = "RATE_LIMIT_EXCEEDED";
    ErrorCode["NOT_FOUND"] = "NOT_FOUND";
    ErrorCode["EVIDENCE_NOT_FOUND"] = "EVIDENCE_NOT_FOUND";
    ErrorCode["USER_NOT_FOUND"] = "USER_NOT_FOUND";
    ErrorCode["CASE_NOT_FOUND"] = "CASE_NOT_FOUND";
    ErrorCode["TEAM_NOT_FOUND"] = "TEAM_NOT_FOUND";
    ErrorCode["WEBHOOK_NOT_FOUND"] = "WEBHOOK_NOT_FOUND";
    ErrorCode["CONFLICT"] = "CONFLICT";
    ErrorCode["EMAIL_ALREADY_EXISTS"] = "EMAIL_ALREADY_EXISTS";
    ErrorCode["DUPLICATE_EVIDENCE"] = "DUPLICATE_EVIDENCE";
    ErrorCode["EVIDENCE_LOCKED"] = "EVIDENCE_LOCKED";
    ErrorCode["INVALID_STATE_TRANSITION"] = "INVALID_STATE_TRANSITION";
    ErrorCode["EVIDENCE_ALREADY_SIGNED"] = "EVIDENCE_ALREADY_SIGNED";
    ErrorCode["INVALID_VERIFICATION_TOKEN"] = "INVALID_VERIFICATION_TOKEN";
    ErrorCode["PAYMENT_FAILED"] = "PAYMENT_FAILED";
    ErrorCode["SUBSCRIPTION_INACTIVE"] = "SUBSCRIPTION_INACTIVE";
    ErrorCode["INTERNAL_SERVER_ERROR"] = "INTERNAL_SERVER_ERROR";
    ErrorCode["DATABASE_ERROR"] = "DATABASE_ERROR";
    ErrorCode["STORAGE_ERROR"] = "STORAGE_ERROR";
    ErrorCode["EMAIL_SERVICE_ERROR"] = "EMAIL_SERVICE_ERROR";
    ErrorCode["PAYMENT_SERVICE_ERROR"] = "PAYMENT_SERVICE_ERROR";
    ErrorCode["EXTERNAL_SERVICE_ERROR"] = "EXTERNAL_SERVICE_ERROR";
    ErrorCode["WEBHOOK_DELIVERY_FAILED"] = "WEBHOOK_DELIVERY_FAILED";
    ErrorCode["WEBHOOK_SIGNATURE_INVALID"] = "WEBHOOK_SIGNATURE_INVALID";
    // Phase 20 — standardized response codes. Routes should prefer
    // these over ad-hoc strings. They mirror the inline values already
    // returned by Phase 18/19 routes (STEP_UP_REQUIRED,
    // HIGH_RISK_ACTION_BLOCKED, RATE_LIMITED), so adopting them is
    // backwards-compatible at the wire level.
    ErrorCode["STEP_UP_REQUIRED"] = "STEP_UP_REQUIRED";
    ErrorCode["HIGH_RISK_ACTION_BLOCKED"] = "HIGH_RISK_ACTION_BLOCKED";
    ErrorCode["GOVERNANCE_BLOCKED"] = "GOVERNANCE_BLOCKED";
    ErrorCode["RATE_LIMITED"] = "RATE_LIMITED";
    ErrorCode["PROVIDER_ERROR"] = "PROVIDER_ERROR";
    ErrorCode["PRODUCTION_CONFIG_VIOLATION"] = "PRODUCTION_CONFIG_VIOLATION";
})(ErrorCode || (ErrorCode = {}));
export function getStatusCode(code) {
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
export function getErrorMessage(code) {
    const messages = {
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
        [ErrorCode.HIGH_RISK_ACTION_BLOCKED]: "Access restricted. Contact a workspace administrator.",
        [ErrorCode.GOVERNANCE_BLOCKED]: "Action blocked by workspace governance policy.",
        [ErrorCode.RATE_LIMITED]: "Too many requests. Try again later.",
        [ErrorCode.PROVIDER_ERROR]: "Upstream provider returned an error. Try again later.",
        [ErrorCode.PRODUCTION_CONFIG_VIOLATION]: "Service is misconfigured. Contact an operator.",
    };
    return messages[code] ?? "An unexpected error occurred";
}
export class AppError extends Error {
    code;
    statusCode;
    details;
    constructor(code, message, details) {
        super(message ?? getErrorMessage(code));
        this.code = code;
        this.statusCode = getStatusCode(code);
        this.details = details;
        this.name = "AppError";
        Object.setPrototypeOf(this, AppError.prototype);
    }
}
export function createErrorResponse(code, requestId, details, customMessage) {
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
export function isAppError(error) {
    return error instanceof AppError;
}
