/**
 * LIVE EMAIL AVAILABILITY on Create account (T-10 / RC-11, AUTH-REGISTER-PARITY §3).
 *
 * The web register page checks, as the address is typed, whether it is free
 * (`app/register/page.tsx:340-379`) and tells the person before they submit —
 * including, when an account already exists, where to go instead. Native had
 * none of this: someone who already had an account filled in a password,
 * satisfied five rules, submitted, and only then learned they were in the
 * wrong place.
 *
 * Same endpoint, same state machine, same copy. PURE; the debounce lives in
 * the screen.
 */

/** `app/register/page.tsx:218`, verbatim. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Web's debounce, `page.tsx:379`. */
export const EMAIL_AVAILABILITY_DEBOUNCE_MS = 500;

export type EmailAvailability = "idle" | "invalid-format" | "checking" | "available" | "exists" | "error";

export function emailAvailabilityPath(email: string): string {
  return `/v1/auth/email/availability?email=${encodeURIComponent(email)}`;
}

/** The state BEFORE any request: idle, invalid, or about to check. */
export function preCheckState(email: string): EmailAvailability {
  const trimmed = email.trim();
  if (trimmed.length === 0) return "idle";
  if (!EMAIL_REGEX.test(trimmed)) return "invalid-format";
  return "checking";
}

/**
 * The server's answer (`auth.routes.ts:964-987`) → a state. Anything
 * unrecognised is "error", never "available": telling someone an address is
 * free when we could not tell is the one wrong answer here.
 */
export function classifyAvailability(data: unknown): EmailAvailability {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (d["available"] === true) return "available";
  if (d["reason"] === "EMAIL_ALREADY_EXISTS") return "exists";
  if (d["reason"] === "INVALID_FORMAT") return "invalid-format";
  return "error";
}

/** Web copy, verbatim (`page.tsx:1182-1222`). */
export const EMAIL_AVAILABILITY_COPY: Readonly<Record<Exclude<EmailAvailability, "idle">, string>> = {
  "invalid-format": "Enter a valid email address.",
  checking: "Checking email…",
  available: "Email is available.",
  exists: "An account already exists for this email.",
  error: "Could not verify email — you can still try to register.",
};

/** Tone per state: error / neutral / success / warning, matching the web's colours. */
export const EMAIL_AVAILABILITY_TONE: Readonly<Record<Exclude<EmailAvailability, "idle">, "danger" | "muted" | "success" | "warning">> = {
  "invalid-format": "danger",
  checking: "muted",
  available: "success",
  exists: "danger",
  error: "warning",
};
