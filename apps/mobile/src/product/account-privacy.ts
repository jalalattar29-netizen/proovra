/**
 * ACCOUNT PRIVACY — data export and account closure.
 *
 * Ports the Settings privacy pane over `GET|POST /v1/identity/data-export`,
 * `GET .../data-export/:id/download`, and
 * `GET|POST /v1/identity/account-closure` with `.../:id/cancel`.
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
        status: str(r.status) ?? "PENDING",
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
 * not be offered. And a COMPLETED export with no expiry stated is treated as
 * available, because the server is the one that expires it.
 */
export function isExportDownloadable(
  request: DataExportRequest,
  nowMs: number = Date.now(),
): boolean {
  if (request.status.toUpperCase() !== "COMPLETED") return false;
  if (!request.expiresAtIso) return true;
  const expires = Date.parse(request.expiresAtIso);
  return Number.isFinite(expires) ? expires > nowMs : true;
}

export function exportStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "verified";
    case "FAILED":
      return "risk";
    case "PENDING":
    case "PROCESSING":
      return "pending";
    case "EXPIRED":
      return "neutral";
    default:
      return "neutral";
  }
}

export function exportStatusLabel(request: DataExportRequest, nowMs = Date.now()): string {
  const s = request.status.toUpperCase();
  if (s === "COMPLETED" && !isExportDownloadable(request, nowMs)) return "Expired";
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.length === 0 ? "Unknown" : t.charAt(0).toUpperCase() + t.slice(1);
}

/** A request already in flight — asking for a second is refused. */
export function hasExportInFlight(requests: DataExportRequest[]): boolean {
  return requests.some((r) => ["PENDING", "PROCESSING"].includes(r.status.toUpperCase()));
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
          status: str(r.status) ?? "PENDING",
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

/** A request that is still live — the user can cancel it, not file another. */
export function isClosureActive(request: ClosureRequest | null): boolean {
  if (!request) return false;
  const s = request.status.toUpperCase();
  return s === "PENDING" || s === "COOLING_OFF" || s === "SCHEDULED";
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
