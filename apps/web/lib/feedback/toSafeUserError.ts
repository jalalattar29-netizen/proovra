/**
 * PROOVRA Feedback System — central API/backend error sanitization.
 *
 * The ONE place that turns any thrown error (ApiError, generic API error,
 * network failure, DOMException, unknown) into user-safe feedback.
 *
 * Guarantees:
 *   - NEVER returns a raw backend `message`, SQL/Prisma/service text,
 *     stack trace, or raw enum code as the user-facing string.
 *   - Maps known error codes / HTTP statuses to calm, actionable copy
 *     answering: what happened · is data safe · what to do next.
 *   - Surfaces the requestId/trace id ONLY as `supportReference`
 *     (rendered by ProovraSupportReference with a Copy button) — never
 *     inline inside the sentence.
 */

export type SafeErrorSeverity = "error" | "warning" | "info";

export interface SafeUserError {
  title: string;
  message: string;
  severity: SafeErrorSeverity;
  actionLabel?: string;
  actionHref?: string;
  /** Internal trace/request id — display ONLY via ProovraSupportReference. */
  supportReference?: string;
}

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  requestId?: unknown;
  name?: unknown;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readStatus(e: ErrorLike): number | undefined {
  const s = typeof e.statusCode === "number" ? e.statusCode : e.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Known error codes → safe copy. Codes are matched case-insensitively.
 * Anything NOT in this table falls back to status-code buckets, so a
 * novel backend code can never leak as raw text.
 */
const CODE_MAP: Record<
  string,
  Omit<SafeUserError, "supportReference">
> = {
  /**
   * The server refused to mark an operational condition resolved because its
   * own source still reports it as failing.
   *
   * Given its own entry rather than falling through to the generic 409,
   * because the generic message ("something has changed, try again") is wrong
   * here in a way that matters: nothing has changed, retrying will not help,
   * and there are exactly two things the operator can do instead. Saying them
   * is the difference between a refusal and a dead end.
   */
  CONDITION_STILL_ACTIVE: {
    title: "This condition is still active",
    message:
      "This condition is still active. Complete the remediation or suppress it with a recorded reason.",
    severity: "warning",
  },
  /**
   * The probe could not READ the source, so the server does not know whether
   * the condition is over.
   *
   * A separate entry from the one above, and the separation is the whole
   * point. "Still active" is an assertion; this is an admission, and telling
   * an operator their condition is still failing when the platform simply
   * could not check would be inventing a fact to avoid an awkward sentence.
   *
   * No provider name, no database identifier, no stack. The operator learns
   * exactly two things: nothing was changed, and checking again later is the
   * next step.
   */
  CONDITION_ACTIVITY_UNKNOWN: {
    title: "Condition status could not be verified",
    message:
      "PROOVRA could not confirm that the underlying condition has recovered. No status was changed. Check again after the source becomes available.",
    severity: "warning",
  },
  /**
   * The condition's source declares that nobody may close it directly.
   *
   * Reached only from a stale tab or a direct API call — the queue offers no
   * Resolve control for these — so the message explains the rule rather than
   * suggesting a retry that would be refused identically.
   */
  CONDITION_NOT_DIRECTLY_RESOLVABLE: {
    title: "This condition cannot be resolved here",
    message:
      "This condition is owned by the surface that reported it and closes when that surface recovers. You can still acknowledge it, assign it, or suppress it with a recorded reason.",
    severity: "warning",
  },
  UNAUTHORIZED: {
    title: "Please sign in again",
    message: "Your session may have expired. Sign in again to continue — your evidence data has not been changed.",
    severity: "warning",
    actionLabel: "Sign in",
    actionHref: "/login",
  },
  SESSION_EXPIRED: {
    title: "Your session expired",
    message: "For your security you've been signed out. Sign in again to continue.",
    severity: "warning",
    actionLabel: "Sign in",
    actionHref: "/login",
  },
  FORBIDDEN: {
    title: "You don't have access to this area",
    message: "This workspace or feature may require additional permissions. Ask a workspace admin for access, or return to the dashboard.",
    severity: "warning",
  },
  ACCESS_DENIED: {
    title: "You don't have access to this area",
    message: "This workspace or feature may require additional permissions. Ask a workspace admin for access, or return to the dashboard.",
    severity: "warning",
  },
  NOT_FOUND: {
    title: "We couldn't find that",
    message: "The item may have moved or is no longer available. Refresh and try again.",
    severity: "info",
  },
  RATE_LIMITED: {
    title: "Too many requests",
    message: "Please wait a moment and try again.",
    severity: "warning",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Verify your email address",
    message: "Please verify your email address before continuing. Check your inbox for the activation link.",
    severity: "info",
  },
  TEAM_PLAN_REQUIRED: {
    title: "Teams aren't included in your plan",
    message: "Teams are available on Pro, Team, and Enterprise plans.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_LIMIT_REACHED: {
    title: "Team limit reached",
    message: "Your plan's Team limit has been reached. Upgrade to create another Team.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_MEMBER_LIMIT_REACHED: {
    title: "This Team is at capacity",
    message: "This Team has reached the member limit for the owner's plan. Free a seat or upgrade to add more members.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_INVITE_LIMIT_REACHED: {
    title: "Invite limit reached",
    message: "This Team has reached its invitation limit for now. Revoke a pending invite, wait for the window to reset, or upgrade your plan.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_INVITES_NOT_INCLUDED: {
    title: "Invitations aren't included in the current plan",
    message: "The Team owner's current plan no longer supports this invitation.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  SUBSCRIPTION_INACTIVE: {
    title: "Subscription inactive",
    message: "Your subscription is not currently active. Update billing to manage Teams.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  STORAGE_LIMIT_REACHED: {
    title: "Storage limit reached",
    message: "Add storage or upgrade your plan to keep preserving evidence. Your existing records remain available.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  ENTITLEMENT_REQUIRED: {
    title: "This action isn't available on your plan",
    message: "This capability requires a higher plan or additional permissions. Review plans or ask an admin.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  VALIDATION_ERROR: {
    title: "Please check the highlighted fields",
    message: "Some details need attention before we can continue.",
    severity: "warning",
  },
  NETWORK_ERROR: {
    title: "Connection problem",
    message: "We couldn't reach the service. Check your connection and try again — your evidence data has not been changed.",
    severity: "error",
  },
};

const GENERIC: Omit<SafeUserError, "supportReference"> = {
  title: "We couldn't complete that action",
  message: "Please try again. Your evidence data has not been changed. If the problem continues, contact support.",
  severity: "error",
};

function fromStatus(status: number): Omit<SafeUserError, "supportReference"> {
  if (status === 401) return CODE_MAP.UNAUTHORIZED;
  if (status === 403) return CODE_MAP.FORBIDDEN;
  if (status === 404) return CODE_MAP.NOT_FOUND;
  if (status === 429) return CODE_MAP.RATE_LIMITED;
  if (status === 408 || status === 0) return CODE_MAP.NETWORK_ERROR;
  if (status >= 500) {
    return {
      title: "The service is temporarily unavailable",
      message: "Please try again in a moment. Your evidence data has not been changed.",
      severity: "error",
    };
  }
  if (status >= 400) {
    return {
      title: "We couldn't complete that action",
      message: "Please review your input and try again.",
      severity: "warning",
    };
  }
  return GENERIC;
}

/**
 * Optional per-call context used ONLY when the error is otherwise
 * unmapped (no known code / status). Lets a call site preserve which
 * action failed ("We couldn't load the billing overview.") while still
 * never leaking a raw backend message and still mapping known codes.
 */
export interface SafeErrorFallback {
  title?: string;
  message?: string;
  severity?: SafeErrorSeverity;
}

/**
 * Convert ANY error into user-safe feedback. Pure + dependency-free so it
 * is safe to import anywhere (client or server).
 */
export function toSafeUserError(
  error: unknown,
  fallback?: SafeErrorFallback,
): SafeUserError {
  const e = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const code = readString(e.code)?.toUpperCase();
  const status = readStatus(e);
  const supportReference = readString(e.requestId);

  let base: Omit<SafeUserError, "supportReference"> | undefined;
  if (code && CODE_MAP[code]) {
    base = CODE_MAP[code];
  } else if (typeof status === "number") {
    base = fromStatus(status);
  } else if (readString(e.name) === "TypeError") {
    // fetch() network failure surfaces as TypeError
    base = CODE_MAP.NETWORK_ERROR;
  } else if (fallback && (fallback.title || fallback.message)) {
    base = {
      title: fallback.title ?? GENERIC.title,
      message: fallback.message ?? GENERIC.message,
      severity: fallback.severity ?? "error",
    };
  } else {
    base = GENERIC;
  }

  return { ...base, supportReference };
}
