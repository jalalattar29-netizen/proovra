/**
 * Operations — WHAT A REFUSAL OR FAILURE MEANS, and whether asking again helps.
 *
 * (D6 / OPS-11, 2026-10-12.) Every failure on this surface used to collapse
 * into one of two sentences: a generic "could not be applied", or — for any
 * refused workspace re-check — "the app and its data store don't match,
 * contact whoever manages this deployment". A database blip was presented as
 * a deployment fault, and a 403 read like a transient.
 *
 * This module classifies a thrown `apiFetch` error (or a 2xx refusal body)
 * into ONE bounded kind, and says whether a "Try again" affordance is honest.
 * The server's own `retryable` flag wins whenever it is present; the status
 * code is only consulted when the server said nothing.
 *
 * It renders no copy itself: `opsErrorMessage` maps a kind to the shared
 * dictionary, so the words are the reader's language.
 */
import type { OperationsCopy } from "@proovra/shared/i18n";

export type OpsErrorKind =
  | "still_active"
  | "activity_unknown"
  | "not_directly_resolvable"
  | "state_changed"
  | "suppression_not_offered"
  | "invalid_assignee"
  | "permission"
  | "not_eligible"
  | "deployment"
  | "temporary"
  | "integrity"
  | "unknown";

export type OpsErrorClass = {
  kind: OpsErrorKind;
  /** True only when pressing the same control again can plausibly succeed. */
  retryable: boolean;
  code: string;
  statusCode: number | null;
};

type ErrorShape = {
  code?: unknown;
  statusCode?: unknown;
  body?: { error?: { code?: unknown; retryable?: unknown } } | null;
};

function readShape(err: unknown): { code: string; statusCode: number | null; serverRetryable: boolean | null } {
  const e = (err && typeof err === "object" ? err : {}) as ErrorShape;
  const bodyErr = e.body && typeof e.body === "object" ? e.body.error : undefined;
  const code =
    typeof bodyErr?.code === "string"
      ? bodyErr.code
      : typeof e.code === "string"
        ? e.code
        : "";
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : null;
  const serverRetryable = typeof bodyErr?.retryable === "boolean" ? bodyErr.retryable : null;
  return { code, statusCode, serverRetryable };
}

const TEMPORARY_CODES = new Set([
  "remediation_failed",
  "remediation_queue_unavailable",
  "queue_unavailable",
  "rate_limited",
  "NETWORK_ERROR",
  "database_unavailable",
  "timeout",
]);

const PERMISSION_CODES = new Set([
  "permission_denied",
  "remediation_not_permitted",
  "remediation_refused",
  "not_permitted",
  "FORBIDDEN",
]);

const ELIGIBILITY_CODES = new Set([
  "remediation_not_eligible",
  "NOT_ELIGIBLE",
  "plan_required",
  "feature_not_included",
  "invalid_transition",
]);

/** Classify a thrown error from an Operations mutation or read. */
export function classifyOpsError(err: unknown): OpsErrorClass {
  const { code, statusCode, serverRetryable } = readShape(err);
  const out = (kind: OpsErrorKind, retryable: boolean): OpsErrorClass => ({
    kind,
    // The server's word, when it gave one, is final.
    retryable: serverRetryable ?? retryable,
    code,
    statusCode,
  });

  switch (code) {
    case "CONDITION_STILL_ACTIVE":
      return out("still_active", false);
    case "CONDITION_ACTIVITY_UNKNOWN":
      return out("activity_unknown", false);
    case "CONDITION_NOT_DIRECTLY_RESOLVABLE":
      return out("not_directly_resolvable", false);
    case "CONDITION_STATE_CHANGED":
      return out("state_changed", false);
    case "SUPPRESSION_NOT_OFFERED":
      return out("suppression_not_offered", false);
    case "invalid_assignee":
      return out("invalid_assignee", false);
    case "schema_mismatch":
      return out("deployment", false);
    default:
      break;
  }
  if (/integrity|terminal/i.test(code)) return out("integrity", false);
  if (PERMISSION_CODES.has(code)) return out("permission", false);
  if (ELIGIBILITY_CODES.has(code)) return out("not_eligible", false);
  if (TEMPORARY_CODES.has(code)) return out("temporary", true);
  if (statusCode === 403) return out("permission", false);
  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 429 || statusCode === 0) {
    return out("temporary", true);
  }
  return out("unknown", false);
}

/**
 * Classify a 2xx workspace re-check refusal (`POST /v1/ops/workspace-reconcile`
 * answering `{ refusedReason, retryable }`).
 */
export function classifyReconcileRefusal(input: {
  refusedReason: string | null | undefined;
  retryable: boolean | null | undefined;
}): OpsErrorClass {
  const code = input.refusedReason ?? "";
  if (code === "schema_mismatch") return { kind: "deployment", retryable: false, code, statusCode: 200 };
  if (code === "permission_denied") return { kind: "permission", retryable: false, code, statusCode: 200 };
  // Every other refusal is transient unless the server said otherwise.
  return { kind: "temporary", retryable: input.retryable !== false, code, statusCode: 200 };
}

/** The sentence for a kind, from the shared dictionary. */
export function opsErrorMessage(
  kind: OpsErrorKind,
  copy: OperationsCopy,
  fallback: string,
): string {
  switch (kind) {
    case "still_active":
      return copy.errors.stillActiveBody;
    case "activity_unknown":
      return copy.errors.activityUnknownBody;
    case "not_directly_resolvable":
      return copy.errors.notResolvableBody;
    case "state_changed":
      return copy.errors.stateChangedBody;
    case "suppression_not_offered":
      return copy.errors.suppressionNotOffered;
    case "invalid_assignee":
      return copy.errors.invalidAssignee;
    case "permission":
      return copy.errors.permission;
    case "not_eligible":
      return copy.errors.notEligible;
    case "deployment":
      return copy.errors.checkDeployment;
    case "temporary":
      return copy.errors.temporary;
    case "integrity":
      return copy.errors.integrity;
    case "unknown":
    default:
      return fallback;
  }
}

/** The sentence for a refused or failed workspace RE-CHECK specifically. */
export function reconcileErrorMessage(kind: OpsErrorKind, copy: OperationsCopy): string {
  if (kind === "deployment") return copy.errors.checkDeployment;
  if (kind === "permission") return copy.errors.checkPermission;
  return copy.errors.checkTemporary;
}
