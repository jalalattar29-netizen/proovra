import { isApiResponseError } from "../api";

/**
 * COMPAT (round 3, 2026-11-15) — the web deploys on every push to main, the
 * API later and by hand. Between the two, this build talks to an API that may
 * not have a route this build calls first.
 *
 * True only for the answer an API gives when the ROUTE itself does not exist:
 * the canonical not-found handler's 404 `ROUTE_NOT_FOUND`
 * (services/api http/not-found-handler.ts) or a 405 for a method the path
 * does not take. A business refusal never uses either (an unknown invitation
 * is 404 `INVITE_NOT_FOUND`), so a refusal from a current API is never retried.
 */
export function isRouteMissing(err: unknown): boolean {
  if (!isApiResponseError(err)) return false;
  const status = (err as { statusCode?: number }).statusCode;
  const code = (err as { code?: unknown }).code;
  return (status === 404 && code === "ROUTE_NOT_FOUND") || status === 405;
}

/**
 * Call the current route; only when the API answers that the route does not
 * exist (an API older than this build), call the older form it does have.
 * Every other answer, success or refusal, is the current route's own. Remove a
 * caller's fallback once every live API serves the current route.
 */
export async function withLegacyRouteFallback<T>(
  current: () => Promise<T>,
  legacy: () => Promise<T>,
): Promise<T> {
  try {
    return await current();
  } catch (err) {
    if (!isRouteMissing(err)) throw err;
  }
  return legacy();
}
