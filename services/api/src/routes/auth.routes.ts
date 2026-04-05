import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import {
  createGuestProfile,
  exchangeAppleCodeForIdToken,
  exchangeGoogleCodeForIdToken,
  ensureGuestIdentity,
  upsertUser,
  upsertUserWithEmailLink,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from "../services/auth.service.js";

import {
  registerWithEmailPassword,
  loginWithEmailPassword,
  createPasswordResetTokenForEmail,
  resetPasswordWithToken,
} from "../services/email-password-auth.service.js";

import { getEmailService } from "../services/email.service.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { signJwt, verifyJwt } from "../services/jwt.js";
import { getAuthUserId } from "../auth.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

const TokenBody = z.object({
  idToken: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
});

const AppleBody = z.object({
  idToken: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
});

const EmailRegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).optional(),
});

const EmailLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const PasswordResetRequestBody = z.object({
  email: z.string().email(),
});

const PasswordResetConfirmBody = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8),
});

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function auditAuthEvent(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "auth",
    severity: params.severity ?? "info",
    source: "api_auth",
    outcome: params.outcome ?? "success",
    resourceType: "user_auth",
    resourceId: params.resourceId ?? params.userId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireLoginCompletedAnalytics(
  userId: string,
  req?: FastifyRequest,
  metadata?: Record<string, unknown>
): void {
  void writeAnalyticsEvent({
    eventType: "login_completed",
    userId,
    path: req?.url ?? null,
    entityType: "user",
    entityId: userId,
    severity: "info",
    metadata,
    req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

function fireRegisterCompletedAnalytics(
  userId: string,
  req?: FastifyRequest,
  metadata?: Record<string, unknown>
): void {
  void writeAnalyticsEvent({
    eventType: "register_completed",
    userId,
    path: req?.url ?? null,
    entityType: "user",
    entityId: userId,
    severity: "info",
    metadata,
    req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function authRoutes(app: FastifyInstance) {
  const jwtSecret = process.env.AUTH_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }

  function jwtPayloadFromUser(user: {
    id: string;
    provider: string;
    email: string | null;
    platformRole?: string | null;
  }) {
    return {
      sub: user.id,
      provider: user.provider,
      email: user.email,
      ...(user.platformRole === "admin" ? { role: "admin" as const } : {}),
    };
  }

  function maybeSetWebCookie(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string
  ) {
    if (req.headers["x-web-client"] !== "1") {
      return;
    }

    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const isProductionDomain =
      host.includes("proovra.com") || origin.includes("proovra.com");

    const cookieOpts = isProductionDomain
      ? {
          httpOnly: true,
          secure: true,
          sameSite: "lax" as const,
          path: "/",
          domain: ".proovra.com",
          maxAge: 60 * 60 * 24 * 30,
        }
      : {
          httpOnly: true,
          secure: false,
          sameSite: "lax" as const,
          path: "/",
          domain: undefined,
          maxAge: 60 * 60 * 24 * 30,
        };

    reply.clearCookie("proovra_session", { path: "/", domain: ".proovra.com" });
    reply.clearCookie("proovra_session", { path: "/" });
    reply.setCookie("proovra_session", token, cookieOpts);
  }

  app.post("/v1/auth/guest", async (req, reply) => {
    const profile = await createGuestProfile();
    const user = await upsertUser(profile);
    await ensureGuestIdentity(user.id);

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
    maybeSetWebCookie(req, reply, token);

    auditAuthEvent(req, {
      userId: user.id,
      action: "auth.guest_session_created",
      outcome: "success",
      resourceId: user.id,
      metadata: {
        provider: user.provider,
        email: user.email,
      },
    });

    fireRegisterCompletedAnalytics(user.id, req, {
      provider: user.provider,
      method: "guest",
    });

    return reply.code(201).send({ token, user });
  });

  app.post("/v1/auth/google", async (req, reply) => {
    try {
      const body = TokenBody.parse(req.body);
      let idToken = body.idToken ?? body.id_token ?? null;

      if (body.code) {
        idToken = await exchangeGoogleCodeForIdToken(body.code);
      }

      if (!idToken) {
        auditAuthEvent(req, {
          userId: null,
          action: "auth.google_login",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "missing_id_token_or_code" },
        });

        return reply.code(400).send({ message: "invalid_id_token" });
      }

      const profile = await verifyGoogleIdToken(idToken);
      const user = await upsertUser(profile);

      const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

      fireLoginCompletedAnalytics(user.id, req, {
        provider: user.provider,
        method: body.code ? "oauth_code" : "id_token",
      });

      auditAuthEvent(req, {
        userId: user.id,
        action: "auth.google_login",
        outcome: "success",
        resourceId: user.id,
        metadata: {
          provider: user.provider,
          email: user.email,
          loginMethod: body.code ? "oauth_code" : "id_token",
        },
      });

      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";

      auditAuthEvent(req, {
        userId: null,
        action: "auth.google_login",
        outcome: "failure",
        severity: "warning",
        metadata: { reason: message },
      });

      if (message === "invalid_code") {
        return reply.code(400).send({
          message: "invalid_code",
          hint: "Code may be expired or already used. Ensure GOOGLE_REDIRECT_URI matches exactly.",
        });
      }

      if (message === "redirect_uri_mismatch") {
        return reply.code(400).send({
          message: "redirect_uri_mismatch",
          hint: "GOOGLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback",
        });
      }

      if (message === "token_exchange_failed") {
        return reply.code(502).send({ message: "token_exchange_failed" });
      }

      return reply.code(401).send({ message: "invalid_id_token" });
    }
  });

  app.post("/v1/auth/apple", async (req, reply) => {
    try {
      const body = AppleBody.parse(req.body);
      let idToken = body.idToken ?? body.id_token ?? null;

      if (body.code) {
        idToken = await exchangeAppleCodeForIdToken(body.code);
      }

      if (!idToken) {
        auditAuthEvent(req, {
          userId: null,
          action: "auth.apple_login",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "missing_id_token_or_code" },
        });

        return reply.code(400).send({ message: "invalid_id_token" });
      }

      const profile = await verifyAppleIdToken(idToken);
      const user = await upsertUserWithEmailLink(profile);

      const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

      fireLoginCompletedAnalytics(user.id, req, {
        provider: user.provider,
        method: body.code ? "oauth_code" : "id_token",
      });

      auditAuthEvent(req, {
        userId: user.id,
        action: "auth.apple_login",
        outcome: "success",
        resourceId: user.id,
        metadata: {
          provider: user.provider,
          email: user.email,
          loginMethod: body.code ? "oauth_code" : "id_token",
        },
      });

      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";

      auditAuthEvent(req, {
        userId: null,
        action: "auth.apple_login",
        outcome: "failure",
        severity: "warning",
        metadata: { reason: message },
      });

      if (message === "invalid_code") {
        return reply.code(400).send({
          message: "invalid_code",
          hint: "Code may be expired or already used. Ensure APPLE_REDIRECT_URI matches exactly.",
        });
      }

      if (message === "redirect_uri_mismatch") {
        return reply.code(400).send({
          message: "redirect_uri_mismatch",
          hint: "APPLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback",
        });
      }

      if (message === "token_exchange_failed") {
        return reply.code(502).send({ message: "token_exchange_failed" });
      }

      if (message === "apple_jwks_fetch_failed") {
        return reply.code(502).send({ message: "apple_jwks_fetch_failed" });
      }

      return reply.code(401).send({ message: "invalid_id_token" });
    }
  });

  app.post("/v1/auth/email/register", async (req, reply) => {
    const body = EmailRegisterBody.parse(req.body);

    const user = await registerWithEmailPassword({
      email: body.email,
      password: body.password,
      displayName: body.displayName ?? null,
    });

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

    maybeSetWebCookie(req, reply, token);

    auditAuthEvent(req, {
      userId: user.id,
      action: "auth.email_register",
      outcome: "success",
      resourceId: user.id,
      metadata: {
        provider: user.provider,
        email: user.email,
        displayName: body.displayName ?? null,
      },
    });

    fireRegisterCompletedAnalytics(user.id, req, {
      provider: user.provider,
      method: "email_password",
    });

    return reply.code(201).send({ token, user });
  });

  app.post("/v1/auth/email/login", async (req, reply) => {
    const body = EmailLoginBody.parse(req.body);

    const user = await loginWithEmailPassword({
      email: body.email,
      password: body.password,
    });

    if (!user) {
      auditAuthEvent(req, {
        userId: null,
        action: "auth.email_login",
        outcome: "failure",
        severity: "warning",
        metadata: {
          email: body.email,
          reason: "invalid_credentials",
        },
      });

      return reply.code(401).send({ message: "invalid_credentials" });
    }

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

    fireLoginCompletedAnalytics(user.id, req, {
      provider: user.provider,
      method: "email_password",
    });

    auditAuthEvent(req, {
      userId: user.id,
      action: "auth.email_login",
      outcome: "success",
      resourceId: user.id,
      metadata: {
        provider: user.provider,
        email: user.email,
      },
    });

    maybeSetWebCookie(req, reply, token);
    return reply.code(200).send({ token, user });
  });

  app.post("/v1/auth/password-reset/request", async (req, reply) => {
    const body = PasswordResetRequestBody.parse(req.body);

    try {
      const result = await createPasswordResetTokenForEmail(body.email);

      auditAuthEvent(req, {
        userId: null,
        action: "auth.password_reset_requested",
        outcome: "success",
        metadata: {
          email: body.email,
          userMatched: Boolean(result),
        },
      });

      if (!result) {
        return reply.code(200).send({ ok: true });
      }

      const webBase = process.env.WEB_BASE_URL || "https://www.proovra.com";
      const resetUrl = `${webBase.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(
        result.rawToken
      )}`;

      try {
        const emailService = getEmailService();
        await emailService.sendPasswordResetEmail(body.email, resetUrl);
      } catch {
        auditAuthEvent(req, {
          userId: null,
          action: "auth.password_reset_email_send",
          outcome: "failure",
          severity: "warning",
          metadata: {
            email: body.email,
          },
        });
      }

      return reply.code(200).send({ ok: true });
    } catch {
      auditAuthEvent(req, {
        userId: null,
        action: "auth.password_reset_requested",
        outcome: "failure",
        severity: "warning",
        metadata: {
          email: body.email,
          reason: "request_failed",
        },
      });

      return reply.code(200).send({ ok: true });
    }
  });

  app.post("/v1/auth/password-reset/confirm", async (req, reply) => {
    const body = PasswordResetConfirmBody.parse(req.body);

    const res = await resetPasswordWithToken({
      token: body.token,
      newPassword: body.newPassword,
    });

    if (!res.ok) {
      auditAuthEvent(req, {
        userId: null,
        action: "auth.password_reset_confirm",
        outcome: "failure",
        severity: "warning",
        metadata: {
          reason: res.reason,
        },
      });

      return reply.code(400).send({ message: res.reason });
    }

    auditAuthEvent(req, {
      userId: null,
      action: "auth.password_reset_confirm",
      outcome: "success",
      metadata: {
        passwordChanged: true,
      },
    });

    return reply.code(200).send({ ok: true });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    let userId: string | null = null;

    try {
      const authHeader = req.headers.authorization ?? "";
      const bearer = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";

      if (bearer) {
        const payload = verifyJwt(bearer, jwtSecret);
        userId = payload.sub;
      }
    } catch {
      // noop
    }

    if (req.headers["x-web-client"] === "1") {
      const host = req.headers.host ?? "";
      const origin = req.headers.origin ?? "";
      const isProductionDomain =
        host.includes("proovra.com") || origin.includes("proovra.com");

      reply.clearCookie("proovra_session", {
        path: "/",
        domain: isProductionDomain ? ".proovra.com" : undefined,
      });
    }

    auditAuthEvent(req, {
      userId,
      action: "auth.logout",
      outcome: "success",
      metadata: {
        webClient: req.headers["x-web-client"] === "1",
      },
    });

    return reply.code(200).send({ ok: true });
  });

  app.get("/v1/auth/me", { preHandler: requireAuth }, async (req: FastifyRequest) => {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) return { user: null };

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        firstName: (user as any).firstName,
        lastName: (user as any).lastName,
        avatarUrl: (user as any).avatarUrl,
        locale: (user as any).locale,
        timezone: (user as any).timezone,
        country: (user as any).country,
        bio: (user as any).bio,
        provider: user.provider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.platformRole === "admin" ? { role: "admin" as const } : {}),
      },
    };
  });
}