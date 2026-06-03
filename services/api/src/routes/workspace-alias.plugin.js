/**
 * Phase B0 — Workspace URL alias plugin.
 *
 * The DB-level concept ("Team") stays. The product-level concept
 * becomes "Workspace". This plugin makes the API speak the new
 * vocabulary WITHOUT duplicating the 2,497-line `teams.routes.ts`
 * file or breaking any existing client.
 *
 * Mechanism:
 *   * Single `onRequest` hook (runs before Fastify's routing match).
 *   * If the incoming URL begins with `/v1/workspaces`, the hook
 *     rewrites `request.raw.url` to the equivalent `/v1/teams` path.
 *   * Routing then matches the existing handlers exactly. Response
 *     bodies are unchanged.
 *
 * Hard rules:
 *   * The rewrite is one-way: `/v1/workspaces` → `/v1/teams`.
 *     `/v1/teams` is NOT rewritten — legacy clients continue
 *     working unchanged.
 *   * The rewrite NEVER applies to `/v1/teams` itself, to
 *     `/v1/teams-...` non-prefix matches, or to any other path.
 *   * The rewrite is path-prefix only — query string + body remain
 *     untouched.
 *   * No audit / metric is emitted; the hook is a transparent
 *     vocabulary shim, not a route.
 *   * The plugin emits a one-line `phase_b0.workspace_alias.routed`
 *     log at debug level for QA observability. Operators can
 *     count vocabulary migration progress without scraping
 *     handlers.
 *
 * The HTTP response is byte-identical between the two paths. A
 * client doing `GET /v1/workspaces` and a client doing
 * `GET /v1/teams` receive the same payload.
 */
const ALIAS_PREFIX = "/v1/workspaces";
const CANONICAL_PREFIX = "/v1/teams";
export const workspaceAliasPlugin = async (app) => {
    app.addHook("onRequest", (request, _reply, done) => {
        const rawUrl = request.raw.url ?? "";
        if (!rawUrl.startsWith(ALIAS_PREFIX)) {
            done();
            return;
        }
        // Ensure the next character is `/`, `?`, or end-of-string — so
        // a hypothetical future `/v1/workspacesfoo` is NOT rewritten.
        const nextChar = rawUrl.charAt(ALIAS_PREFIX.length);
        if (nextChar !== "" && nextChar !== "/" && nextChar !== "?") {
            done();
            return;
        }
        const rewritten = CANONICAL_PREFIX + rawUrl.slice(ALIAS_PREFIX.length);
        request.raw.url = rewritten;
        request.log.debug({
            from: rawUrl,
            to: rewritten,
        }, "phase_b0.workspace_alias.routed");
        done();
    });
};
