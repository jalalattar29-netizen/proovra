/**
 * Phase O2.1 — Presence backend abstraction.
 *
 * The presence surface (heartbeat + here-now) is intentionally tiny.
 * Two real backends:
 *
 *   * `MemoryPresenceBackend` — single-instance Map<string, Map<...>>.
 *     The Phase G3 implementation. Process-local; restart = clean slate.
 *     This is the DEFAULT — selected when `PROOVRA_PRESENCE_BACKEND`
 *     is unset, set to `memory`, or set to `redis` with no `REDIS_URL`
 *     configured (graceful degradation).
 *
 *   * `RedisPresenceBackend` — single-instance Redis-backed Hash. Use
 *     the existing PROOVRA Redis (the one BullMQ + rate-limit already
 *     connect to). NO Redis Cluster requirement — works against any
 *     single-node ioredis-compatible endpoint. Enabled when
 *     `PROOVRA_PRESENCE_BACKEND=redis` AND `REDIS_URL` is set.
 *
 * Hard rules (both backends MUST honour):
 *
 *   * Workspace-scoped key — teamId is part of every key so a viewer
 *     in workspace A cannot leak into the viewer list for workspace B.
 *   * Bounded payload — only `{userId, displayName, lastSeenAtUtc}`.
 *     NEVER IP / device / location / route.
 *   * Self-eviction at read time — every read evicts entries older
 *     than `HEARTBEAT_TTL_MS`.
 *   * Best-effort — backend errors NEVER throw to callers. Failure
 *     mode is "no viewers shown", not "request fails".
 *   * Bounded fan-out — at most `MAX_VIEWERS_PER_KEY` (25) entries per
 *     resource. Older entries are evicted first when over.
 *
 * The contract surface is bounded — every method takes / returns only
 * the documented small types.
 */
export const PRESENCE_HEARTBEAT_TTL_MS = 90 * 1000;
export const PRESENCE_MAX_VIEWERS_PER_KEY = 25;
export function buildPresenceKey(teamId, resourceKind, resourceId) {
    return `${teamId}|${resourceKind}|${resourceId}`;
}
