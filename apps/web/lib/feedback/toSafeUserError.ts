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

import {
  SERVER_MESSAGE_ERROR_CODES,
  SERVER_MESSAGE_MAX_LENGTH,
  SYNTHETIC_ERROR_MESSAGE,
  USER_FACING_ERRORS,
} from "@proovra/shared/user-facing-errors";

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
  /**
   * Read ONLY for the codes on `SERVER_MESSAGE_CODES`. Declared here so that
   * reading it is a typed, greppable decision rather than a cast at the point
   * of use — the whole risk in this file is a backend string reaching a user,
   * and the one place it may is worth naming.
   */
  message?: unknown;
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
/**
 * Known error codes → safe copy.
 *
 * The table itself lives in `@proovra/shared`, because the native app needs
 * the same answers and a second copy would drift: before the move, a plan
 * limit, a legal hold and a genuine permission problem all read "You don't
 * have access to this." on a phone, while the web had a sentence for each.
 *
 * Nothing about this file's behaviour changes. Codes are still matched
 * case-insensitively, and anything absent still falls through to the status
 * buckets below, so a novel backend code can never leak as raw text.
 */
const CODE_MAP: Record<string, Omit<SafeUserError, "supportReference">> =
  USER_FACING_ERRORS;

const GENERIC: Omit<SafeUserError, "supportReference"> = {
  title: "We couldn't complete that action",
  message: "Please try again. Your evidence data has not been changed. If the problem continues, contact support.",
  severity: "error",
};

/**
 * CODES WHOSE SERVER MESSAGE IS THE ANSWER.
 *
 * `CODE_MAP` answers "what does this code always mean?", which is the right
 * question for a code with one outcome. Some domain refusals do not have one:
 * `team_conflict` is raised for the last-LEAD invariant on suspend, on remove
 * and on demote, and each carries a different, already user-safe sentence
 * naming the operation and the way out. Writing one of those here would be
 * wrong for the other two; writing a sentence vague enough to cover all three
 * would say less than the server already said.
 *
 * So for these codes — and ONLY these — the server's message is rendered. That
 * is a deliberate, bounded exception to "never show a backend message", and it
 * is safe precisely because these are authored refusals from our own domain
 * layer, not exception text: each is a fixed literal in
 * `collaboration-team.service.ts`, none interpolates user input, a database
 * error or an internal path, and the API's own 500 handler never uses these
 * codes.
 *
 * Everything that keeps it honest:
 *   - the code must be on this list; nothing else may reach it;
 *   - the message must exist and must not be the client's synthetic
 *     `HTTP nnn: API error` placeholder;
 *   - it is length-bounded, so a pathological body cannot fill the toast;
 *   - anything failing those checks falls through to the normal resolution.
 */
const SERVER_MESSAGE_CODES = SERVER_MESSAGE_ERROR_CODES;

/** The placeholder `apps/web/lib/api.ts` substitutes when a body carries no message. */
const SYNTHETIC_MESSAGE = SYNTHETIC_ERROR_MESSAGE;
const SERVER_MESSAGE_MAX = SERVER_MESSAGE_MAX_LENGTH;

function trustedServerMessage(code: string, e: ErrorLike): string | undefined {
  if (!SERVER_MESSAGE_CODES[code]) return undefined;
  const message = readString(e.message);
  if (!message || SYNTHETIC_MESSAGE.test(message)) return undefined;
  return message.slice(0, SERVER_MESSAGE_MAX);
}

/**
 * Does this repository have DELIBERATE copy for the error's code?
 *
 * The question a client-side error reporter should be asking before it files
 * an issue. A code with an entry in `CODE_MAP` is an outcome somebody
 * anticipated, wrote a sentence for, and gave the customer a next step on —
 * a plan allowance reached, a session expired, a name already taken. Sending
 * those to the error tracker buries the failures nobody anticipated under the
 * ones everybody did.
 *
 * It is deliberately NOT "is this a 4xx". Status is the transport's opinion;
 * this asks whether the PRODUCT has an answer. An unmapped 409 is still worth
 * reporting, because the fact that we have nothing to say about it is itself
 * the finding.
 */
export function hasExplanationFor(error: unknown): boolean {
  const e = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const code = readString(e.code)?.toUpperCase();
  return Boolean(code && CODE_MAP[code]);
}

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
  const serverMessage = code ? trustedServerMessage(code, e) : undefined;
  if (code && serverMessage) {
    // Ahead of the status branch on purpose: `fromStatus` would answer a 409
    // with "Please review your input and try again", which is exactly the
    // generic sentence the server took the trouble to replace.
    base = { ...SERVER_MESSAGE_CODES[code], message: serverMessage };
  } else if (code && CODE_MAP[code]) {
    base = CODE_MAP[code];
  } else if (code && code.endsWith("_RETIRED")) {
    // THE SUFFIX IS THE SIGNAL, NOT THE STATUS.
    //
    // Twenty-two routes answer 410 with a `*_RETIRED` code and a truthful
    // sentence, and every one was discarded: only `TEAM_CONFLICT` may show a
    // server message, so these fell to the generic 4xx bucket and read
    // "review your input and try again" about an endpoint no input reaches.
    //
    // Keyed on the code rather than on 410, because 410 is not only used for
    // retirement: `external-intake.routes.ts` answers 410 for an expired or
    // already-used link, which the public intake page explains in its own
    // words. Calling that "this feature is no longer available" would be a
    // new wrong answer in place of an old one.
    base = CODE_MAP.FEATURE_RETIRED;
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
