import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserLegalAcceptanceStatus, recordLegalAcceptances } from "../services/legal-acceptance.service.js";
import {
  listActiveSessions,
  revokeActiveSession,
} from "../services/access-control/session-inventory.service.js";
import {
  hashPassword,
  verifyPassword,
} from "../services/email-password-auth.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";

const LegalAcceptanceBody = z.object({
  source: z.string().min(1).max(64).optional(),
  acceptances: z
    .array(
      z.object({
        policyKey: z.string().min(1).max(64),
        policyVersion: z.string().min(1).max(32),
      })
    )
    .min(1),
});

const CookieConsentBody = z.object({
  consentVersion: z.string().min(1).max(32),
  necessary: z.boolean().optional(),
  preferences: z.boolean().optional(),
  analytics: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

function pickMe(u: any) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    firstName: u.firstName,
    lastName: u.lastName,
    avatarUrl: u.avatarUrl,
    locale: u.locale,
    timezone: u.timezone,
    country: u.country,
    bio: u.bio,
    provider: u.provider,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    // Hotfix — the web app (reviewer-ops, governance, intake-links, and
    // every "operator console" page) reads
    // `response.user.currentWorkspaceId` to scope its API calls. The
    // field was previously dropped here, so those pages saw
    // `currentWorkspaceId === undefined` and rendered the
    // "Switch to a workspace" empty state EVEN WHEN the user had an
    // active workspace selected on the server. /home didn't depend on
    // this field (it uses session-scoped queries directly) so the
    // regression only manifested on consoles. The User model already
    // stores the value (`User.currentWorkspaceId @map("current_workspace_id")`).
    // Returning `null` when the user has no workspace is the right
    // semantic; that lets the canonical "no workspace" message fire
    // only when it's actually true.
    currentWorkspaceId: u.currentWorkspaceId ?? null,
    ...(u.platformRole === "admin" ? { role: "admin" as const } : {}),
  };
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

export async function usersRoutes(app: FastifyInstance) {
  app.get("/v1/users/me", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { user: null };

    return { user: pickMe(user) };
  });

  app.patch("/v1/users/me", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const data: Record<string, any> = {};
    const setStr = (key: string, max: number) => {
      const v = body[key];
      if (typeof v === "string") data[key] = v.trim().slice(0, max);
      if (v === null) data[key] = null;
    };

    setStr("displayName", 120);
    setStr("firstName", 80);
    setStr("lastName", 80);
    setStr("avatarUrl", 512);
    setStr("locale", 12);
    setStr("timezone", 64);

    if (typeof body.country === "string") {
      const trimmed = body.country.trim();
      data.country = trimmed.length > 0 ? trimmed.slice(0, 120) : null;
    } else if (body.country === null) {
      data.country = null;
    }

    if (typeof body.bio === "string") data.bio = body.bio.trim().slice(0, 280);
    if (body.bio === null) data.bio = null;

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
    });

    return { user: pickMe(updated) };
  });

  app.get("/v1/users/legal-status", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;
    const status = await getUserLegalAcceptanceStatus({ userId });

    return {
      ok: status.ok,
      requiresReacceptance: status.requiresReacceptance,
      missingPolicies: status.missingPolicies,
      acceptedVersions: status.acceptedVersions,
      requiredVersions: status.requiredVersions,
    };
  });

  app.get("/v1/users/legal-acceptance", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;

    const items = await prisma.userLegalAcceptance.findMany({
      where: { userId },
      orderBy: { acceptedAt: "desc" },
      select: {
        id: true,
        policyKey: true,
        policyVersion: true,
        acceptedAt: true,
        source: true,
      },
    });

    return { items };
  });

  app.post("/v1/users/legal-acceptance", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;
    const body = LegalAcceptanceBody.parse(req.body);

    await recordLegalAcceptances({
      userId,
      acceptances: body.acceptances,
      source: body.source ?? "web",
      req,
    });

    const items = await prisma.userLegalAcceptance.findMany({
      where: { userId },
      orderBy: { acceptedAt: "desc" },
      select: {
        id: true,
        policyKey: true,
        policyVersion: true,
        acceptedAt: true,
        source: true,
      },
    });

    return { ok: true, items };
  });

  app.get("/v1/users/cookie-consent/latest", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;

    const latest = await prisma.cookieConsentRecord.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return {
      record: latest
        ? {
            id: latest.id,
            consentVersion: latest.consentVersion,
            necessary: latest.necessary,
            preferences: latest.preferences,
            analytics: latest.analytics,
            marketing: latest.marketing,
            createdAt: latest.createdAt,
            updatedAt: latest.updatedAt,
          }
        : null,
    };
  });

  app.post("/v1/users/cookie-consent", { preHandler: requireAuth }, async (req: any) => {
    const userId = req.user.sub;
    const body = CookieConsentBody.parse(req.body);

    const created = await prisma.cookieConsentRecord.create({
      data: {
        userId,
        consentVersion: body.consentVersion,
        necessary: body.necessary ?? true,
        preferences: body.preferences ?? false,
        analytics: body.analytics ?? false,
        marketing: body.marketing ?? false,
        source: "web",
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req) ?? null,
      },
    });

    return {
      ok: true,
      record: {
        id: created.id,
        consentVersion: created.consentVersion,
        necessary: created.necessary,
        preferences: created.preferences,
        analytics: created.analytics,
        marketing: created.marketing,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    };
  });

  // ===========================================================================
  // Phase 2.4 — User-facing session inventory
  //
  // The admin side already had `/v1/admin/identity/sessions` for SOC
  // operators. Phase 2.4 closes the obvious "I can't see where I'm
  // signed in" gap by exposing the SAME `AuthenticatedSession` table
  // to its OWN owner with a strict `userId === self` filter.
  //
  // Hard rules:
  //   - Returns only rows belonging to the caller. Never any other user.
  //   - Returns only display-safe fields: no raw IP, no raw UA, no
  //     deviceIdHash (the hash itself is internal). The `ipPreview` /
  //     `uaPreview` are pre-truncated by the admin path's same code.
  //   - Marks the caller's current session with `current: true` using
  //     `req.user.sessionIdHash` so the UI can render "this device"
  //     correctly without disclosing other sessions' raw ids.
  // ===========================================================================
  app.get(
    "/v1/users/me/sessions",
    { preHandler: requireAuth },
    async (req: any) => {
      const userId = req.user.sub as string;
      const currentSessionIdHash =
        typeof req.user.sessionIdHash === "string"
          ? (req.user.sessionIdHash as string)
          : null;

      // Direct prisma query — the existing `listActiveSessions` requires
      // a teamId filter (admin per-team view). For the user-facing list
      // we want every session the caller has, across all workspaces.
      const now = new Date();
      const rows = await prisma.authenticatedSession.findMany({
        where: { userId },
        orderBy: [{ lastSeenAtUtc: "desc" }],
        take: 200,
        select: {
          id: true,
          teamId: true,
          ssoConnectionId: true,
          sessionIdHash: true,
          issuedAtUtc: true,
          expiresAtUtc: true,
          lastSeenAtUtc: true,
          ipPreview: true,
          uaPreview: true,
          revokedAtUtc: true,
          revokedReason: true,
        },
      });

      const sessions = rows.map((row) => {
        const isActive =
          row.revokedAtUtc == null && row.expiresAtUtc > now;
        return {
          id: row.id,
          teamId: row.teamId,
          ssoConnectionId: row.ssoConnectionId,
          issuedAtUtc: row.issuedAtUtc.toISOString(),
          expiresAtUtc: row.expiresAtUtc.toISOString(),
          lastSeenAtUtc: row.lastSeenAtUtc.toISOString(),
          ipPreview: row.ipPreview,
          uaPreview: row.uaPreview,
          revoked: row.revokedAtUtc != null,
          revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
          revokedReason: row.revokedReason,
          active: isActive,
          current:
            currentSessionIdHash != null &&
            row.sessionIdHash === currentSessionIdHash,
        };
      });

      return { sessions };
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/users/me/sessions/:id",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = req.user.sub as string;
      const sessionId = String(req.params?.id ?? "");
      const parsed = z.string().uuid().safeParse(sessionId);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_SESSION_ID",
          message: "Session id must be a valid UUID.",
        });
      }

      // Strict ownership check: the row must belong to the caller.
      // Without this an attacker who learns another user's session id
      // (the id is internal and not surfaced anywhere public, but defense
      // in depth) could revoke them. We also accept revoking the caller's
      // own current session — they will be signed out on the next
      // request, which is the expected behavior.
      const row = await prisma.authenticatedSession.findFirst({
        where: { id: parsed.data, userId },
        select: {
          id: true,
          teamId: true,
          sessionIdHash: true,
          revokedAtUtc: true,
        },
      });
      if (!row) {
        return reply.code(404).send({
          code: "SESSION_NOT_FOUND",
          message: "No active session with that id belongs to you.",
        });
      }
      if (row.revokedAtUtc != null) {
        // Idempotent — already revoked is success.
        return reply.code(200).send({ ok: true, alreadyRevoked: true });
      }

      // Reuse the existing revocation service so the RevokedSession
      // registry stays the canonical source of truth + the
      // authenticated_sessions row gets its pointer set in the same call.
      // We pass teamId only when the row has one (some sessions are
      // workspace-less, e.g. fresh guest tokens before workspace
      // bootstrap completes).
      if (row.teamId) {
        const revoked = await revokeActiveSession({
          teamId: row.teamId,
          sessionId: row.id,
          actorUserId: userId,
          reason: "USER_LOGGED_OUT",
        });
        if (!revoked) {
          return reply.code(404).send({
            code: "SESSION_NOT_FOUND",
            message: "Session disappeared during revocation.",
          });
        }
      } else {
        // Fallback path for workspace-less rows. Mark the active-session
        // row revoked and write a RevokedSession entry directly via
        // prisma. Best-effort security event emission.
        await prisma.authenticatedSession.update({
          where: { id: row.id },
          data: {
            revokedAtUtc: new Date(),
            revokedByUserId: userId,
            revokedReason: "USER_LOGGED_OUT",
          },
        });
        await prisma.revokedSession.create({
          data: {
            userId,
            sessionIdHash: row.sessionIdHash,
            reason: "USER_LOGGED_OUT",
            revokedByUserId: userId,
          },
        });
      }

      // Reuse the existing `session_revoked` taxonomy. The `details`
      // payload carries `actorUserId === targetUserId` so SOC analysts
      // can distinguish operator-initiated from self-revocation.
      safeEmitSecurityEvent({
        teamId: row.teamId ?? null,
        eventType: "session_revoked",
        severity: "INFO",
        details: {
          actorUserId: userId,
          targetUserId: userId,
          targetSessionId: row.id,
          reason: "user_revoked_from_account_settings",
        },
      });

      return { ok: true };
    }
  );

  // ===========================================================================
  // Phase 2.4 — Direct password change for email-password users.
  //
  // Hard rules:
  //   - Only `provider === EMAIL` accounts can use this route. OAuth /
  //     guest accounts must use their identity provider's password flow
  //     (Google / Apple) or are not password-backed at all (guest). We
  //     return 409 PROVIDER_UNSUPPORTED so the AccountSecurityCard can
  //     render an honest "managed by Google" panel instead of pretending
  //     the change worked.
  //   - The current password is verified using the existing
  //     `verifyPassword(...)` helper. A failed match returns 403 with the
  //     same generic copy as a wrong-password login, NEVER discloses
  //     "user has no password set".
  //   - The new password is enforced with the same minimum length (>= 8)
  //     as `EmailRegisterBody` (auth.routes.ts:84). We do not extend the
  //     policy beyond what the registration path already enforces —
  //     consistency between flows matters more than ad-hoc tightening.
  //   - The new hash is written; we do NOT touch sessions in this PR.
  //     A separate follow-up can add an opt-in "sign out all other
  //     sessions" body flag once we have a UI affordance.
  //   - A SecurityEvent is emitted on success so SOC / audit can see
  //     password rotations.
  // ===========================================================================
  const PasswordChangeBody = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(8).max(256),
  });

  app.post(
    "/v1/users/me/password/change",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = req.user.sub as string;
      const parsed = PasswordChangeBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_BODY",
          message:
            "currentPassword and newPassword (min 8 chars) are required.",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          provider: true,
          passwordHash: true,
        },
      });
      if (!user) {
        return reply.code(404).send({
          code: "USER_NOT_FOUND",
          message: "User not found.",
        });
      }

      // Only EMAIL-provider users can change a password here. Any other
      // provider (GOOGLE, APPLE, GUEST) does not have a local password
      // by construction.
      if (user.provider !== "EMAIL" || !user.passwordHash) {
        return reply.code(409).send({
          code: "PROVIDER_UNSUPPORTED",
          message:
            "Your account is managed by an identity provider — change your password there.",
          details: { provider: user.provider },
        });
      }

      const ok = verifyPassword(parsed.data.currentPassword, user.passwordHash);
      if (!ok) {
        safeEmitSecurityEvent({
          teamId: null,
          eventType: "password_change_failed",
          severity: "WARNING",
          details: {
            actorUserId: userId,
            reason: "current_password_mismatch",
          },
        });
        return reply.code(403).send({
          code: "CURRENT_PASSWORD_INVALID",
          message: "Current password is incorrect.",
        });
      }

      const newHash = hashPassword(parsed.data.newPassword);
      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      });

      safeEmitSecurityEvent({
        teamId: null,
        eventType: "password_changed",
        severity: "INFO",
        details: {
          actorUserId: userId,
          method: "self_service",
        },
      });

      return { ok: true };
    }
  );
}