/**
 * DEPRECATED ROUTE ALIASES — one canonical handler, an honest wire signal.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * Two remediation renames left older paths registered beside their successors:
 *
 *   GET /v1/admin/organizations       -> GET /v1/admin/customers
 *   GET /v1/admin/organizations/:id   -> GET /v1/admin/customers/:id
 *   GET /v1/ops/metrics               -> GET /v1/admin/platform/metrics
 *   GET /v1/ops/alerts                -> GET /v1/admin/platform/alerts
 *
 * The audit that found them recorded "zero consumers" and recommended
 * deletion. Repository search is not evidence of external non-use: this
 * repository publishes no OpenAPI document, keeps no access logs, and declares
 * no integration configuration that would name a caller. Absence of a search
 * hit is absence of evidence, so the aliases are RETAINED and marked, not
 * deleted on the strength of a grep. (Two of the four turned out to have a
 * live in-repository consumer the search had missed, which is the point.)
 *
 * =============================================================================
 * WHAT "THIN ALIAS" MEANS HERE
 * =============================================================================
 * The alias and its successor run THE SAME handler function. Not a copy, not a
 * re-implementation that happens to agree today — the same function value,
 * registered twice. That is what makes the equivalence tests in
 * `test/deprecated-aliases.test.ts` a statement about the code rather than a
 * snapshot of two bodies that can drift apart tomorrow.
 *
 * =============================================================================
 * THE BOUNDED REMOVAL PATH
 * =============================================================================
 * Every alias answers with the standard deprecation signals so a caller can
 * discover the move without reading this file:
 *
 *   Deprecation: true                       (RFC 8594)
 *   Sunset: <HTTP-date>                     (RFC 8594)
 *   Link: <successor>; rel="successor-version"   (RFC 8288)
 *
 * `ALIAS_SUNSET_UTC` is the date after which removal is in scope. It is
 * deliberately a single constant: moving the date moves every alias, and the
 * test asserts the header is present and parses, so a removal cannot quietly
 * become "someday".
 */
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

/**
 * Removal is in scope from this date. Chosen as two full quarters after the
 * aliases were marked (2026-09-08), which is long enough for an unknown
 * external caller to see the header on a routine poll and act on it.
 */
export const ALIAS_SUNSET_UTC = "2027-03-01T00:00:00.000Z";

/** The `Sunset` header value, as the HTTP-date the RFC requires. */
export const ALIAS_SUNSET_HTTP_DATE = new Date(ALIAS_SUNSET_UTC).toUTCString();

/**
 * Wrap a canonical handler so the alias registration answers identically and
 * additionally carries the deprecation signals.
 *
 * The wrapper adds headers and calls through. It does not read the request, it
 * does not branch on it, and it does not touch the body — so an alias response
 * differs from its successor's ONLY in these three headers.
 */
export function deprecatedAlias(
  successorPath: string,
  handler: RouteHandlerMethod,
): RouteHandlerMethod {
  return function deprecatedAliasHandler(
    this: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    reply.header("deprecation", "true");
    reply.header("sunset", ALIAS_SUNSET_HTTP_DATE);
    reply.header("link", `<${successorPath}>; rel="successor-version"`);
    return (handler as (r: FastifyRequest, p: FastifyReply) => unknown).call(
      this,
      req,
      reply,
    );
  } as RouteHandlerMethod;
}
