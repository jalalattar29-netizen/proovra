/**
 * T-038 (SEC-01, P10 timing overridden) — ROW-LESS SESSION TOKENS ARE ADOPTED.
 *
 * Every interactive sign-in has written its `AuthenticatedSession` row before
 * issuing a token since 99280441b / 8e3b57ba3 (2026-11-22). Before that the
 * write was best-effort, so a sign-in whose insert failed left a valid token
 * with no row. Such a token skipped the adaptive risk gate, the privileged
 * session-age windows and quarantine, was not listed under "My sessions", and
 * survived "Sign out other sessions" and a password change.
 *
 * COMPATIBILITY STRATEGY (documented in docs/security/session-adoption.md):
 *   - Nobody is signed out en masse. On the token's next authenticated request
 *     `requireAuth` writes its inventory row ("adoption"), marked
 *     `authMethod = ADOPTED_LEGACY`, with `issuedAtUtc = iat`.
 *   - Because the row carries the token's real issue time, the privileged
 *     age windows apply as for any session: every genuine legacy token (issued
 *     before 2026-11-22) is older than every window, so approve, reject,
 *     archive, bulk, resolve and suppress answer `reauth_required` until the
 *     person signs in again. Reads and ordinary edits continue.
 *   - The adopted row is visible in "My sessions", scored by the runtime
 *     sweep, can be quarantined, and is ended by "Sign out other sessions"
 *     and a password change (each also writes an iat cut-off, T-039).
 *   - If the row cannot be written the request is refused with
 *     401 `reauthentication_required`: a token nobody can see or end is not
 *     served.
 *   - The adaptive gate treats a missing row (a token that reached it without
 *     `requireAuth`'s adoption) as `reauth_required/legacy_session`.
 */
import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordAuthenticatedSession, requestDeviceIdHash } from "../access-control/session-inventory.service.js";

/** The inventory marker an adopted legacy session carries (≤ 16 chars). */
export const ADOPTED_LEGACY_AUTH_METHOD = "ADOPTED_LEGACY";

/** A token with no `exp` is given the interactive-session lifetime. */
const DEFAULT_LIFETIME_SECONDS = 30 * 24 * 3600;

function ipPreview(req: FastifyRequest): string | null {
  const ip = req.ip ?? "";
  if (!ip) return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.•••`;
  }
  return ip.slice(0, 10) + "…";
}

function uaPreview(req: FastifyRequest): string | null {
  const raw = req.headers["user-agent"];
  return typeof raw === "string" ? raw.trim().slice(0, 120) : null;
}

export type AdoptedSessionRow = {
  teamId: string | null;
  lastSeenAtUtc: Date;
  revokedAtUtc: Date | null;
};

/**
 * Write the inventory row for a verified, unrevoked token whose `sid` has
 * none. Idempotent (upsert on user + sid hash), so two first requests in
 * parallel write one row. Throws on a database failure; the caller refuses.
 */
export async function adoptRowlessSession(
  req: FastifyRequest,
  input: { userId: string; sid: string; iat: number; exp: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<AdoptedSessionRow> {
  const user = await client.user.findUnique({
    where: { id: input.userId },
    select: { currentWorkspaceId: true },
  });
  const teamId = user?.currentWorkspaceId ?? null;
  const exp = typeof input.exp === "number" && input.exp > input.iat ? input.exp : input.iat + DEFAULT_LIFETIME_SECONDS;
  const session = await recordAuthenticatedSession(
    {
      userId: input.userId,
      teamId,
      sid: input.sid,
      iat: input.iat,
      exp,
      ipPreview: ipPreview(req),
      uaPreview: uaPreview(req),
      deviceIdHash: requestDeviceIdHash(req.headers),
      authMethod: ADOPTED_LEGACY_AUTH_METHOD,
    },
    client,
  );
  safeEmitSecurityEvent(
    {
      teamId,
      eventType: "legacy_session_adopted",
      severity: "INFO",
      details: {
        sessionId: session.id,
        subjectUserId: input.userId,
        issuedAtUtc: new Date(input.iat * 1000).toISOString(),
      },
    },
    client,
  );
  return { teamId, lastSeenAtUtc: new Date(), revokedAtUtc: null };
}
