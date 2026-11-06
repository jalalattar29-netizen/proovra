/**
 * ACCOUNT PRIVACY — data export and account closure.
 *
 * Ports the Settings privacy pane over `GET|POST /v1/identity/data-export`,
 * `POST .../data-export/:id/download`, and
 * `GET|POST /v1/identity/account-closure` with `.../:id/cancel`
 * (services/api/src/routes/account-data-export.routes.ts,
 * account-closure.routes.ts).
 *
 * PRO-114 / MOBILE-02 — the request shapes are the routes' own schemas, not a
 * guess at them: closure posts `{ confirmation, reason?, stepUp? }`, an export
 * request `{ stepUp? }`, and a download is a POST carrying `{ stepUp? }`
 * (there is no GET; a step-up proof never travels in a URL). The statuses are
 * the server's vocabulary — REQUESTED / PROCESSING / READY / FAILED / EXPIRED
 * for an export — the same words the web's PrivacySection reads.
 *
 * ===========================================================================
 * CLOSURE IS THE MOST CONSEQUENTIAL CONTROL IN THE PRODUCT
 * ===========================================================================
 * Three things make it safe, and all three come from the SERVER:
 *
 *   blockers             why closure cannot proceed yet. The server evaluates
 *                        them; the client shows them. A closure form that
 *                        submits into a blocker produces a refusal the user
 *                        cannot act on.
 *   confirmationPhrase   the exact words the user must type. It is published
 *                        rather than hard-coded here, so it can never drift
 *                        from what the route checks — a phrase the client
 *                        believes in and the server rejects would make
 *                        closure impossible with no explanation.
 *   coolingOffDays       closure is not immediate. A user must be told that
 *                        before they confirm, not after.
 *
 * Nothing here invents a blocker, shortens a cooling-off period, or decides
 * that a request may proceed.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const DATA_EXPORT_PATH = "/v1/identity/data-export";
export const ACCOUNT_CLOSURE_PATH = "/v1/identity/account-closure";

export function buildExportDownloadPath(requestId: string): string {
  return `${DATA_EXPORT_PATH}/${encodeURIComponent(requestId)}/download`;
}

export function buildClosureCancelPath(requestId: string): string {
  return `${ACCOUNT_CLOSURE_PATH}/${encodeURIComponent(requestId)}/cancel`;
}

/** The step-up proof, exactly as the identity routes' `stepUp` field accepts it. */
export type PrivacyStepUpProof =
  | { method: "password"; currentPassword: string }
  | { method: "mfa"; code: string };

/** `POST /v1/identity/account-closure` — the route's schema: `confirmation`, never `confirmationPhrase`. */
export function buildClosureRequestBody(
  typed: string,
  reason: string,
  proof: PrivacyStepUpProof | null,
): { confirmation: string; reason?: string; stepUp?: PrivacyStepUpProof } {
  const trimmedReason = reason.trim();
  return {
    confirmation: typed.trim(),
    ...(trimmedReason ? { reason: trimmedReason } : {}),
    ...(proof ? { stepUp: proof } : {}),
  };
}

/** `POST /v1/identity/data-export` and `POST .../:id/download` both take only the proof. */
export function buildExportStepUpBody(proof: PrivacyStepUpProof | null): { stepUp?: PrivacyStepUpProof } {
  return proof ? { stepUp: proof } : {};
}

/** The download is a POST: the route has no GET, and the proof rides in the body. */
export const EXPORT_DOWNLOAD_METHOD = "POST";

/** The file name the route's content-disposition gives the package. */
export function exportPackageFilename(requestId: string): string {
  return `proovra-account-export-${requestId.replace(/[^A-Za-z0-9-]/g, "")}.json`;
}

// ---------------------------------------------------------------------------
// Data export
// ---------------------------------------------------------------------------

export interface DataExportRequest {
  id: string;
  status: string;
  requestedAtIso: string | null;
  completedAtIso: string | null;
  expiresAtIso: string | null;
  failureCode: string | null;
  sha256: string | null;
  downloadCount: number;
}

export function parseDataExports(payload: unknown): DataExportRequest[] {
  return rows(obj(payload).requests)
    .map((raw) => {
      const r = obj(raw);
      const id = str(r.id);
      if (!id) return null;
      return {
        id,
        status: str(r.status) ?? "REQUESTED",
        requestedAtIso: str(r.requestedAtUtc),
        completedAtIso: str(r.completedAtUtc),
        expiresAtIso: str(r.expiresAtUtc),
        failureCode: str(r.failureCode),
        sha256: str(r.packageSha256),
        downloadCount: num(r.downloadCount) ?? 0,
      };
    })
    .filter((r): r is DataExportRequest => r !== null);
}

/**
 * Whether this export can still be downloaded.
 *
 * An EXPIRED package is not a download that will fail — it is one that should
 * not be offered. READY is the server's one downloadable state
 * (account-data-export.routes.ts: `row.status !== "READY"` → 409); a READY
 * export with no expiry stated is treated as available, because the server is
 * the one that expires it.
 */
export function isExportDownloadable(
  request: DataExportRequest,
  nowMs: number = Date.now(),
): boolean {
  if (request.status.toUpperCase() !== "READY") return false;
  if (!request.expiresAtIso) return true;
  const expires = Date.parse(request.expiresAtIso);
  return Number.isFinite(expires) ? expires > nowMs : true;
}

export function exportStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "READY":
      return "verified";
    case "FAILED":
      return "risk";
    case "REQUESTED":
    case "PROCESSING":
      return "pending";
    default:
      return "neutral";
  }
}

/** The web's words for each state (PrivacySection EXPORT_STATUS_LABEL). */
const EXPORT_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested — queued for generation",
  PROCESSING: "Generating…",
  READY: "Ready to download",
  FAILED: "Failed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export function exportStatusLabel(request: DataExportRequest, nowMs = Date.now()): string {
  const s = request.status.toUpperCase();
  if (s === "READY" && !isExportDownloadable(request, nowMs)) return "Expired";
  const known = EXPORT_STATUS_LABEL[s];
  if (known) return known;
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.length === 0 ? "Unknown" : t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The server's "one active request" set (REQUESTED, PROCESSING, READY): while
 * one exists a second request is refused with `export_request_active`, so the
 * control says so instead of producing that refusal.
 */
export function hasExportInFlight(requests: DataExportRequest[]): boolean {
  return requests.some((r) => ["REQUESTED", "PROCESSING", "READY"].includes(r.status.toUpperCase()));
}

// ---------------------------------------------------------------------------
// Account closure
// ---------------------------------------------------------------------------

export interface ClosureRequest {
  id: string;
  status: string;
  reason: string | null;
  requestedAtIso: string | null;
  coolingOffEndsAtIso: string | null;
  cancelledAtIso: string | null;
  failureCode: string | null;
}

export interface ClosureView {
  request: ClosureRequest | null;
  /** The server's reasons closure cannot proceed. Never invented here. */
  blockers: string[];
  /** What closure will do to other people — shown, never blocking (LIFE-13). */
  consequences: string[];
  /** The exact words the route checks. Published so the two cannot drift. */
  confirmationPhrase: string | null;
  coolingOffDays: number | null;
}

export function parseClosure(payload: unknown): ClosureView {
  const d = obj(payload);
  const r = obj(d.request);
  const id = str(r.id);

  return {
    request: id
      ? {
          id,
          status: str(r.status) ?? "REQUESTED",
          reason: str(r.reason),
          requestedAtIso: str(r.requestedAtUtc),
          coolingOffEndsAtIso: str(r.coolingOffEndsAtUtc),
          cancelledAtIso: str(r.cancelledAtUtc),
          failureCode: str(r.failureCode),
        }
      : null,
    blockers: rows(d.blockers)
      .map((b) => (typeof b === "string" ? b : str(obj(b).message) ?? str(obj(b).code)))
      .filter((b): b is string => typeof b === "string" && b.length > 0),
    consequences: rows(d.consequences)
      .map((c) => str(obj(c).message))
      .filter((c): c is string => typeof c === "string" && c.length > 0),
    confirmationPhrase: str(d.confirmationPhrase),
    coolingOffDays: num(d.coolingOffDays),
  };
}

/**
 * Whether the confirmation the user typed matches.
 *
 * Compared against the SERVER'S published phrase, never a copy. A phrase this
 * client believed in and the route rejected would make closure impossible with
 * no explanation the user could act on.
 */
export function confirmationMatches(typed: string, view: ClosureView): boolean {
  if (!view.confirmationPhrase) return false;
  return typed.trim() === view.confirmationPhrase.trim();
}

/**
 * A request that is still open — shown instead of the form. The server's own
 * sets (account-closure.service.ts ACTIVE_CLOSURE_STATUSES plus a BLOCKED
 * request, which stays cancellable), as the web's AccountClosureCard reads them.
 */
export function isClosureActive(request: ClosureRequest | null): boolean {
  if (!request) return false;
  return ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"].includes(
    request.status.toUpperCase(),
  );
}

/** Statuses the cancel route accepts (CANCELLABLE_CLOSURE_STATUSES); PROCESSING is past it. */
export function isClosureCancellable(request: ClosureRequest | null): boolean {
  if (!request) return false;
  return ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"].includes(request.status.toUpperCase());
}

/** The web's words for a closure request's state (PrivacySection CLOSURE_STATUS_LABEL). */
const CLOSURE_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

export function closureStatusLabel(status: string): string {
  return CLOSURE_STATUS_LABEL[status.toUpperCase()] ?? status;
}

/** A refusal of the closure request, in the web's words (PrivacySection requestClosure). */
export function closureRequestFailure(err: unknown): { message: string; reload: boolean } | null {
  const e = obj(err);
  const code = str(obj(obj(e.body).error).code) ?? str(e.code);
  if (code === "closure_blocked") {
    return { message: "Closure is blocked — resolve the items listed above and try again.", reload: true };
  }
  if (code === "confirmation_mismatch") {
    return {
      message: str(obj(obj(e.body).error).message) ?? "The confirmation phrase does not match.",
      reload: false,
    };
  }
  if (code === "closure_request_active") {
    return { message: "An account closure request is already open.", reload: true };
  }
  return null;
}

export function closureStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "risk";
    case "CANCELLED":
      return "verified";
    case "FAILED":
      return "risk";
    default:
      return "pending";
  }
}

/**
 * What happens next, in words, or null when nothing is pending.
 *
 * A user who has asked to close their account needs to know that it has not
 * happened yet and when it will — "pending" alone answers neither.
 */
export function closureCountdown(
  view: ClosureView,
  nowMs: number = Date.now(),
): string | null {
  const request = view.request;
  if (!isClosureActive(request) || !request?.coolingOffEndsAtIso) return null;

  const ends = Date.parse(request.coolingOffEndsAtIso);
  if (!Number.isFinite(ends)) return null;
  if (ends <= nowMs) return "The cooling-off period has ended; closure is being processed.";

  const days = Math.ceil((ends - nowMs) / 86_400_000);
  return `Your account closes in ${days} day${days === 1 ? "" : "s"} unless you cancel.`;
}
