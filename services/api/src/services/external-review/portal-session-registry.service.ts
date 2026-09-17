/**
 * D2 / D31 (2026-09-17) — External reviewer portal: the session registry.
 *
 * WHY THIS EXISTS
 *
 * A portal request authenticates with the grant's raw token plus the
 * `x-portal-session` id the token exchange handed out. Nothing recorded which
 * session ids had been handed out: any 32-hex string was accepted as "the
 * session", and a request with no id at all was silently given a new one. So
 * the operator action "end this reviewer's sessions"
 * (POST /v1/external-review/invitations/:id/sessions/revoke) could only write
 * an activity row, and signing out (POST /v1/portal/logout) left the session id
 * working.
 *
 * THE DESIGN
 *
 *   - One Redis hash per grant, `portal:sessions:<grantId>`. Each field is a
 *     session id the token exchange issued; its value is
 *     `<issuedAtMs>:<lastSeenMs>`.
 *   - Only the token exchange (POST /v1/portal/auth) registers a session.
 *     Every other portal request must name a registered, live session.
 *   - A session is live while it has been used within the inactivity window
 *     and is younger than the maximum session lifetime (both from
 *     `@proovra/shared`). Each use slides `lastSeen`; a lapsed field is
 *     removed on sight.
 *   - Sign-out removes one field. The operator action deletes the whole hash
 *     in one command, so no session issued before it can be used again. A
 *     token holder can still open a NEW session through the token exchange
 *     while the grant is live (and must answer a fresh emailed code when the
 *     grant requires MFA); cutting the token holder off is grant revocation.
 *   - The hash expires one maximum-lifetime after the last registration, so
 *     nothing outlives the sessions it describes.
 *   - No memory fallback, same as the MFA challenge store: a second API
 *     instance would not see the first one's sessions or revocations. Every
 *     store failure throws `PortalMfaChallengeUnavailableError` and callers
 *     fail closed.
 */

import {
  EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS,
  EXTERNAL_PORTAL_MAX_SESSION_MS,
} from "@proovra/shared";

import { clearPortalMfaSessions, withPortalRedis } from "./portal-mfa-challenge.service.js";

const REGISTRY_PREFIX = "portal:sessions:";
const registryKey = (grantId: string) => `${REGISTRY_PREFIX}${grantId}`;

export const PORTAL_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

const REGISTER_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. ':' .. ARGV[2])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 1
`;

/** 1 = live (slid), 0 = never issued or already ended, -1 = lapsed (removed). */
const TOUCH_SCRIPT = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local sep = string.find(v, ':', 1, true)
local issued = sep and tonumber(string.sub(v, 1, sep - 1))
local seen = sep and tonumber(string.sub(v, sep + 1))
local now = tonumber(ARGV[2])
if (not issued) or (not seen)
  or now - seen > tonumber(ARGV[3])
  or now - issued > tonumber(ARGV[4]) then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return -1
end
redis.call('HSET', KEYS[1], ARGV[1], string.sub(v, 1, sep - 1) .. ':' .. ARGV[2])
return 1
`;

/** Deletes every session of the grant; returns {every id, how many were still live}. */
const REVOKE_ALL_SCRIPT = `
local all = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
local now = tonumber(ARGV[1])
local ids = {}
local live = 0
for i = 1, #all, 2 do
  ids[#ids + 1] = all[i]
  local v = all[i + 1]
  local sep = string.find(v, ':', 1, true)
  local issued = sep and tonumber(string.sub(v, 1, sep - 1))
  local seen = sep and tonumber(string.sub(v, sep + 1))
  if issued and seen
    and now - seen <= tonumber(ARGV[2])
    and now - issued <= tonumber(ARGV[3]) then
    live = live + 1
  end
end
return {live, ids}
`;

/** Record a session the token exchange just issued. Throws when the store is unreachable. */
export async function registerPortalSession(input: {
  grantId: string;
  sessionId: string;
}): Promise<void> {
  const now = Date.now();
  await withPortalRedis((r) =>
    r.eval(
      REGISTER_SCRIPT,
      1,
      registryKey(input.grantId),
      input.sessionId,
      String(now),
      String(EXTERNAL_PORTAL_MAX_SESSION_MS),
    ),
  );
}

/**
 * True when the session was issued for this grant and is still live; the use
 * slides its inactivity window. Throws when the store is unreachable.
 */
export async function touchPortalSession(input: {
  grantId: string;
  sessionId: string;
}): Promise<boolean> {
  if (!PORTAL_SESSION_ID_PATTERN.test(input.sessionId)) return false;
  const res = await withPortalRedis((r) =>
    r.eval(
      TOUCH_SCRIPT,
      1,
      registryKey(input.grantId),
      input.sessionId,
      String(Date.now()),
      String(EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS),
      String(EXTERNAL_PORTAL_MAX_SESSION_MS),
    ),
  );
  return Number(res) === 1;
}

/**
 * Sign-out: this session id stops working. Returns 1 when it was registered,
 * else 0. Throws when the store is unreachable.
 */
export async function endRegisteredPortalSession(input: {
  grantId: string;
  sessionId: string;
}): Promise<number> {
  const removed = await withPortalRedis((r) =>
    r.eval("return redis.call('HDEL', KEYS[1], ARGV[1])", 1, registryKey(input.grantId), input.sessionId),
  );
  // The registry is the authority; a leftover MFA record cannot open a session
  // that is no longer registered, and it expires with the inactivity window.
  await clearPortalMfaSessions({ grantId: input.grantId, sessionIds: [input.sessionId] }).catch(() => undefined);
  return Number(removed) === 1 ? 1 : 0;
}

/**
 * Operator action: every session issued for the grant stops working, and none
 * of them keeps an answered MFA code. Returns how many were still live.
 * Throws when the store is unreachable.
 */
export async function revokeAllPortalSessions(input: { grantId: string }): Promise<{
  sessionsEnded: number;
}> {
  const res = (await withPortalRedis((r) =>
    r.eval(
      REVOKE_ALL_SCRIPT,
      1,
      registryKey(input.grantId),
      String(Date.now()),
      String(EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS),
      String(EXTERNAL_PORTAL_MAX_SESSION_MS),
    ),
  )) as [unknown, unknown];
  const live = Number(res?.[0] ?? 0);
  const ids = Array.isArray(res?.[1]) ? (res[1] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  await clearPortalMfaSessions({ grantId: input.grantId, sessionIds: ids }).catch(() => undefined);
  return { sessionsEnded: Number.isFinite(live) ? live : 0 };
}
