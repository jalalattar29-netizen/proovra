/**
 * Phase B0 — Workspace URL alias.
 *
 * The DB-level concept ("Team") stays. The product-level concept becomes
 * "Workspace". This module makes the API speak the new vocabulary WITHOUT
 * duplicating the 2,497-line `teams.routes.ts` file or breaking any existing
 * client: `/v1/workspaces/*` is rewritten to `/v1/teams/*` before routing, so
 * both spellings reach the same handler and the response is byte-identical.
 *
 * PHASE 13 §1.5 — WHY THIS IS NO LONGER AN `onRequest` HOOK
 * ---------------------------------------------------------------------------
 * It used to rewrite `request.raw.url` inside an `onRequest` hook, registered
 * before the route plugins with a comment stating that this made the hook fire
 * "before routing match". That is not Fastify's lifecycle. Fastify ROUTES
 * FIRST and runs `onRequest` afterwards, on the already-matched route — so
 * mutating the URL there changed a string nobody would read again.
 *
 * The consequence was total and silent: EVERY `/v1/workspaces/*` request 404'd,
 * for the whole life of the plugin. Measured directly against a minimal Fastify
 * instance carrying only this hook and a `/v1/teams` route:
 *
 *     GET /v1/teams             → 200
 *     GET /v1/workspaces        → 404
 *     GET /v1/teams/ai-policy   → 200
 *     GET /v1/workspaces/ai-policy → 404
 *
 * FINAL-005 found the symptom on the AI-policy routes and fixed it by moving
 * those registrations to the post-rewrite path — which made the CANONICAL
 * spelling work while leaving the alias, and therefore the actual web callers
 * in `settings/_sections/AiSection.tsx` and `AiCapabilityStatusTable.tsx`,
 * still 404ing. The row's claim that "existing callers keep working unchanged
 * via the plugin" was not true, because the plugin never rewrote anything.
 *
 * `rewriteUrl` is Fastify's documented hook for this: it is a SERVER OPTION,
 * called with the raw request before the router looks at the URL. The rewrite
 * RULE below is unchanged — same prefix, same one-way direction, same
 * boundary guard — only the place it is applied has moved to somewhere that
 * runs early enough to matter.
 *
 * Hard rules (unchanged):
 *   * One-way: `/v1/workspaces` → `/v1/teams`. `/v1/teams` is NEVER rewritten,
 *     so legacy clients keep working and no rewrite can loop.
 *   * Never applies to `/v1/teams` itself, nor to non-boundary matches such as
 *     `/v1/workspacesfoo`.
 *   * Path-prefix only — query string and body are untouched.
 *   * Transparent: no audit, no metric, no route of its own.
 *
 * The plugin's debug log is gone with the hook. `rewriteUrl` runs before a
 * request logger exists, so there is nothing to log through; the alternative
 * would be a second mechanism kept alive only to log, which is how the two
 * would drift apart again.
 */

const ALIAS_PREFIX = "/v1/workspaces";
const CANONICAL_PREFIX = "/v1/teams";

/**
 * The rewrite rule, as a pure function of the URL.
 *
 * Exported so `buildServer` can install it as `rewriteUrl` and the conformance
 * tests can exercise the rule directly. It is the ONLY place the alias mapping
 * is expressed.
 */
export function rewriteWorkspaceAliasUrl(rawUrl: string | undefined): string {
  const url = rawUrl ?? "";
  if (!url.startsWith(ALIAS_PREFIX)) return url;

  // The next character must end the segment — so `/v1/workspacesfoo` is NOT
  // rewritten into a different namespace.
  const nextChar = url.charAt(ALIAS_PREFIX.length);
  if (nextChar !== "" && nextChar !== "/" && nextChar !== "?") return url;

  return CANONICAL_PREFIX + url.slice(ALIAS_PREFIX.length);
}
