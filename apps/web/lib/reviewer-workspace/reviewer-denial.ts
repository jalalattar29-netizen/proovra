/**
 * PRO-R2Z-06 — the ONE reader of a reviewer-surface refusal.
 *
 * `apiFetch` never sets `err.body.denial`: a flat `{ denial }` reply lands at
 * `err.code`, `err.details.denial` and `err.body.error.denial` (apps/web/lib/api.ts).
 * Eight call sites read `err.body.denial ?? "RATE_LIMITED"`, so every refusal
 * — QC independence, permission, plan, step-up, validation — was reported as
 * rate limiting (or "unknown"), and reviewers retried instead of fixing the
 * cause. This reads the fields the client actually sets; only a real 429 is
 * rate limiting, and a lost answer is a network failure, not a refusal.
 */
export function reviewerDenialFromError(err: unknown): string {
  const e = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
    details?: unknown;
    body?: { denial?: unknown; error?: { denial?: unknown; code?: unknown } };
  };
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  const details = e.details && typeof e.details === "object" ? (e.details as { denial?: unknown }) : null;
  const named = [e.body?.error?.denial, details?.denial, e.body?.denial].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (named) return named;
  const code = typeof e.code === "string" ? e.code : typeof e.body?.error?.code === "string" ? e.body.error.code : "";
  if (code === "NETWORK_ERROR") return "NETWORK_ERROR";
  if (code === "ENTITLEMENT_REQUIRED") return "ENTITLEMENT_REQUIRED";
  if (status === 429 || code === "RATE_LIMITED") return "RATE_LIMITED";
  if (status === 401 || status === 403 || code === "NOT_PERMITTED" || code === "FORBIDDEN") return "NOT_PERMITTED";
  return code || "REFUSED";
}
