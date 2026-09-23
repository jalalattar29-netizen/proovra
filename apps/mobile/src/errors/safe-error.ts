/**
 * CANONICAL SAFE-ERROR LAYER (Phase 3). The ONE mapping from any thrown error
 * to a user-safe, classified result. Pure (type-only imports) so it is
 * unit-testable and free of RN. It understands every backend envelope variant
 * the API emits (canonical {error:{code,message,requestId}}, Fastify-flat
 * {error,message,statusCode}, and the MobileApiError thrown by src/api.ts) and
 * never surfaces a raw server string for server/unknown failures.
 *
 * This replaces the mobile anti-pattern of `catch → [] → "No items"` and of
 * rendering `err.message` (incl. requestId / API base) directly in the UI.
 */

import { userFacingErrorFor } from "@proovra/shared/user-facing-errors";

export type SafeErrorKind =
  | "auth" // 401 — session expired / invalid
  | "legal" // 428 — legal re-acceptance required
  | "forbidden" // 403
  | "notFound" // 404
  | "input" // 400 — validation
  | "network" // transport failure / offline
  | "server" // 5xx
  | "unknown";

export interface SafeError {
  kind: SafeErrorKind;
  title: string;
  /**
   * True when this copy came from the product's own dictionary rather than
   * from a status bucket.
   *
   * A surface that needs to decide between "explain this" and "offer a retry"
   * has to be able to tell the two apart: a mapped refusal has a next step, a
   * bucket answer usually only has "try again".
   */
  explained?: boolean;
  /** User-safe message — never a raw backend string for server/unknown. */
  message: string;
  /** Machine code when the backend supplied one (for programmatic handling). */
  code?: string;
  /** Correlation id kept for support, shown only through a support affordance. */
  requestId?: string;
  status?: number;
  /** For kind==="legal": the policies needing acceptance. */
  missingPolicies?: string[];
  /**
   * FIELD-LEVEL VALIDATION, for inline rendering beside the input.
   *
   * `INVALID_INPUT` carries a bounded `fields[]` — path, code and a short
   * message per issue (`server.ts:456`) — and it is the only part of a
   * validation refusal that tells somebody WHICH box to fix. The summary
   * sentence is deliberately generic, because the server's own summary reads
   * "Invalid input: <root> — Too big: expected number to be <=100", which is
   * a shape nobody outside this repository should have to parse.
   *
   * A form renders these next to their inputs; a screen without a form
   * ignores them.
   */
  fields?: Array<{ path: string; message: string }>;
}

interface Extracted {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  missingPolicies?: string[];
  fields?: Array<{ path: string; message: string }>;
  isNetwork: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Pull fields from any of the known error/envelope shapes, defensively. */
function extract(err: unknown): Extracted {
  const e = asRecord(err);
  const envelope = asRecord(e.error); // canonical {error:{...}} or Fastify flat {error:"..."}
  const details = asRecord(e.details ?? envelope.details);

  const status =
    num(e.status) ?? num(e.statusCode) ?? num(envelope.statusCode) ?? num(e.httpStatus);

  const code = str(e.code) ?? str(envelope.code);

  const message = str(envelope.message) ?? str(e.message) ?? (typeof e.error === "string" ? str(e.error) : undefined);

  const requestId = str(e.requestId) ?? str(envelope.requestId) ?? str(e.requestID);

  const rawPolicies = (details.missingPolicies ?? asRecord(envelope.details).missingPolicies) as unknown;
  const missingPolicies = Array.isArray(rawPolicies)
    ? rawPolicies.filter((p): p is string => typeof p === "string")
    : undefined;

  // Fetch/transport failures surface as TypeError("Network request failed") etc.
  const name = str(e.name);
  const isNetwork =
    (name === "TypeError" && /network|fetch|failed/i.test(message ?? "")) ||
    /network request failed|failed to fetch|timeout|timed out/i.test(message ?? "");

  const rawFields = (e.fields ?? envelope.fields) as unknown;
  const fields = Array.isArray(rawFields)
    ? rawFields
        .map((f) => {
          const r = asRecord(f);
          const path = str(r.path) ?? "";
          const fieldMessage = str(r.message);
          return fieldMessage ? { path, message: fieldMessage } : null;
        })
        .filter((f): f is { path: string; message: string } => f !== null)
    : undefined;

  return { status, code, message, requestId, missingPolicies, fields, isNetwork };
}

/**
 * What a CALL SITE knows that the error does not.
 *
 * A thrown value from a native module — screen-capture consent refused, a
 * recorder that would not start — carries no status and no code, and the
 * classifier reads that absence as a transport failure, because for an API
 * call it almost always is. On the capture screens it is not: answering
 * "You appear to be offline" to a consent denial is a confident wrong answer.
 *
 * So a call site may supply the sentence it would have written itself. It is
 * used ONLY when the error is otherwise unclassifiable — never over a mapped
 * code, never over a real transport failure.
 */
export interface SafeErrorFallback {
  title?: string;
  message: string;
}

function classify(x: Extracted): SafeErrorKind {
  if (x.code === "LEGAL_REACCEPT_REQUIRED" || x.status === 428) return "legal";
  if (x.status === 401 || x.code === "UNAUTHENTICATED") return "auth";
  if (x.status === 403) return "forbidden";
  if (x.status === 404) return "notFound";
  if (x.status === 400 || x.code === "INVALID_INPUT") return "input";
  if (x.isNetwork) return "network";
  if (typeof x.status === "number" && x.status >= 500) return "server";
  if (x.status === undefined && !x.code) return "network"; // no status + no code ≈ transport
  return "unknown";
}

const TITLES: Record<SafeErrorKind, string> = {
  auth: "Session ended",
  legal: "Please review the updated terms",
  forbidden: "Not available",
  notFound: "Not found",
  input: "Check the details",
  network: "You appear to be offline",
  server: "Something went wrong",
  unknown: "Something went wrong",
};

const SAFE_MESSAGES: Record<SafeErrorKind, string> = {
  auth: "Please sign in again to continue.",
  legal: "Accept the updated terms to continue.",
  forbidden: "You don't have access to this.",
  notFound: "This item is no longer available.",
  input: "Some information looks incorrect. Please review and try again.",
  network: "Check your connection and try again.",
  server: "We hit a problem on our side. Please try again.",
  unknown: "Please try again.",
};

/**
 * Convert any thrown value to a classified, user-safe error.
 *
 * ORDER MATTERS, and it is the same order the web resolves in:
 *
 *   1. THE PRODUCT'S OWN ANSWER for this code, if it has one. A plan limit is
 *      not a permission problem and a legal hold is not a server fault; the
 *      dictionary is where the difference is written down.
 *   2. The backend's own message, for the kinds where it is safe and more
 *      specific than anything generic — a validation complaint, a refusal
 *      that names what is missing.
 *   3. The status bucket. Always present, so an unmapped code still produces
 *      safe copy rather than a raw string.
 *
 * Before step 1 existed, every 409 on a phone read "Something went wrong.
 * Please try again." — for refusals that retrying can never resolve.
 */
export function toSafeUserError(err: unknown, fallback?: SafeErrorFallback): SafeError {
  const x = extract(err);
  const kind = classify(x);

  const explained = userFacingErrorFor(x.code ?? null);
  if (explained) {
    return {
      kind,
      title: explained.title,
      message: explained.message,
      explained: true,
      code: x.code,
      requestId: x.requestId,
      status: x.status,
      missingPolicies: kind === "legal" ? x.missingPolicies : undefined,
      fields: x.fields,
    };
  }

  /*
   * A LOCAL FAILURE, NOT A TRANSPORT ONE.
   *
   * `classify` reads "no status and no code" as network, which is right for
   * an API call and wrong for a native module that threw. When the call site
   * supplied its own sentence and nothing about the error says transport, its
   * sentence is the honest answer.
   */
  if (fallback && kind === "network" && !x.isNetwork && x.status === undefined && !x.code) {
    return {
      kind: "unknown",
      title: fallback.title ?? TITLES.unknown,
      message: fallback.message,
      explained: false,
      requestId: x.requestId,
    };
  }

  // For input/forbidden/notFound the backend message is safe & useful; for
  // auth/legal/network/server/unknown we use the canonical safe copy.
  const useBackendMessage = (kind === "input" || kind === "forbidden" || kind === "notFound") && !!x.message;
  return {
    kind,
    title: TITLES[kind],
    message: useBackendMessage ? (x.message as string) : SAFE_MESSAGES[kind],
    explained: false,
    code: x.code,
    requestId: x.requestId,
    status: x.status,
    missingPolicies: kind === "legal" ? x.missingPolicies : undefined,
    fields: x.fields,
  };
}

/**
 * Does the product have deliberate copy for this failure?
 *
 * The question a surface asks before offering "Try again": a mapped refusal
 * names a next step, and retrying an evidence lock or a plan limit is not it.
 */
export function hasExplanationFor(err: unknown): boolean {
  return toSafeUserError(err).explained === true;
}

/** True when the error means the session is no longer valid (drives re-auth). */
export function isAuthError(err: unknown): boolean {
  return toSafeUserError(err).kind === "auth";
}

/** True when the error is a legal re-acceptance gate (428). */
export function isLegalGate(err: unknown): boolean {
  return toSafeUserError(err).kind === "legal";
}
