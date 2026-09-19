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
  /** User-safe message — never a raw backend string for server/unknown. */
  message: string;
  /** Machine code when the backend supplied one (for programmatic handling). */
  code?: string;
  /** Correlation id kept for support, shown only through a support affordance. */
  requestId?: string;
  status?: number;
  /** For kind==="legal": the policies needing acceptance. */
  missingPolicies?: string[];
}

interface Extracted {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  missingPolicies?: string[];
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

  return { status, code, message, requestId, missingPolicies, isNetwork };
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

/** Convert any thrown value to a classified, user-safe error. */
export function toSafeUserError(err: unknown): SafeError {
  const x = extract(err);
  const kind = classify(x);
  // For input/forbidden/notFound the backend message is safe & useful; for
  // auth/legal/network/server/unknown we use the canonical safe copy.
  const useBackendMessage = (kind === "input" || kind === "forbidden" || kind === "notFound") && !!x.message;
  return {
    kind,
    title: TITLES[kind],
    message: useBackendMessage ? (x.message as string) : SAFE_MESSAGES[kind],
    code: x.code,
    requestId: x.requestId,
    status: x.status,
    missingPolicies: kind === "legal" ? x.missingPolicies : undefined,
  };
}

/** True when the error means the session is no longer valid (drives re-auth). */
export function isAuthError(err: unknown): boolean {
  return toSafeUserError(err).kind === "auth";
}

/** True when the error is a legal re-acceptance gate (428). */
export function isLegalGate(err: unknown): boolean {
  return toSafeUserError(err).kind === "legal";
}
