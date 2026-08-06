/**
 * PHASE 12 VERTICAL C — shared load-phase vocabulary for the Trust
 * administration console.
 *
 * Every section renders FOUR distinct phases — loading, empty, DENIAL, and
 * error — because collapsing them is how a governance console silently
 * reports "nothing is wrong" when the real answer was "you are not allowed
 * to see this". A denial is never rendered as an empty list.
 *
 * No policy is decided here. `classifyTrustPhase` only READS the status the
 * server already returned; it never predicts whether a call would succeed.
 */

import { toSafeUserError } from "../../../../../../../lib/feedback/toSafeUserError";

export type TrustDenial = {
  kind: "denied";
  title: string;
  detail: string;
};

export type TrustFailure =
  | TrustDenial
  | { kind: "error"; detail: string };

type ErrorShape = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
};

/**
 * Map a thrown `apiFetch` error onto the console's DENIAL vs ERROR split.
 *
 * 403 / 404 / permission_denied — the server refused. `antiEnumeration` on
 * the trust routes turns a cross-Organization probe into a 404, so 404 is
 * treated as a denial rather than "this thing does not exist": the console
 * must never help an operator distinguish the two.
 */
export function classifyTrustPhase(
  err: unknown,
  copy: { deniedTitle: string; deniedDetail: string; errorMessage: string },
): TrustFailure {
  const e = (err ?? {}) as ErrorShape;
  const status =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : undefined;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  if (
    status === 403 ||
    status === 404 ||
    code === "forbidden" ||
    code === "not_found" ||
    code === "permission_denied"
  ) {
    return {
      kind: "denied",
      title: copy.deniedTitle,
      detail: copy.deniedDetail,
    };
  }
  return {
    kind: "error",
    detail: toSafeUserError(err, { message: copy.errorMessage }).message,
  };
}

/** True when the caller cancelled a step-up challenge — not a failure. */
export function isStepUpCancel(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown };
  return e.code === "STEP_UP_CANCEL";
}

export const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary, #475569)",
} as const;
