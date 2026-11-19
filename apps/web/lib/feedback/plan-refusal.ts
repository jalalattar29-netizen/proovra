/**
 * PRO-R2-14 — "the workspace's plan does not include this", recognised once.
 *
 * The API now answers every review-capability refusal in one shape (403
 * `{ error: { code: "ENTITLEMENT_REQUIRED", reason, entitlement } }`), but the
 * currently deployed API may still send the older shapes: 404/403
 * `{ error: { code: "reviewer_operations_not_included" } }` and the reviewer
 * workspace's flat `{ denial: "ENTITLEMENT_REQUIRED" }`. Each review page used
 * to read one of them and show "The publish action failed", "requires
 * workspace membership" or "Could not load" for the others. Every page asks
 * this instead, and shows the plan sentence.
 */
export const PLAN_REFUSAL_COPY =
  "This workspace's plan does not include this review feature. A workspace owner can change the plan in Billing.";

export function isPlanRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    details?: { denial?: unknown; reason?: unknown } | null;
    body?: { denial?: unknown; error?: { code?: unknown; reason?: unknown; denial?: unknown } };
  };
  const values = [
    e.code,
    e.details?.denial,
    e.details?.reason,
    e.body?.denial,
    e.body?.error?.code,
    e.body?.error?.reason,
    e.body?.error?.denial,
  ];
  return values.some((v) => v === "ENTITLEMENT_REQUIRED" || v === "reviewer_operations_not_included");
}
