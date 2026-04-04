// D:\digital-witness\services\api\src\routes\auth.routes.ts
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
  verifyGoogleIdToken
} from "../services/auth.service.js";

import {
  registerWithEmailPassword,
  loginWithEmailPassword,
  createPasswordResetTokenForEmail,
  resetPasswordWithToken
} from "../services/email-password-auth.service.js";

import { getEmailService } from "../services/email.service.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { signJwt } from "../services/jwt.js";
import { getAuthUserId } from "../auth.js";

const TokenBody = z.object({
  idToken: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  code: z.string().min(1).optional()
});

const AppleBody = z.object({
  idToken: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  code: z.string().min(1).optional()
});

const EmailRegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).optional()
});

const EmailLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const PasswordResetRequestBody = z.object({
  email: z.string().email()
});

const PasswordResetConfirmBody = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8)
});

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

  function maybeSetWebCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
    if (req.headers["x-web-client"] !== "1") {
      console.log("[Auth] Skipping cookie: x-web-client not set");
      return;
    }
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
    const cookieOpts = isProductionDomain
      ? {
          httpOnly: true,
          secure: true,
          sameSite: "lax" as const,
          path: "/",
          domain: ".proovra.com",
          maxAge: 60 * 60 * 24 * 30
        }
      : {
          httpOnly: true,
          secure: false,
          sameSite: "lax" as const,
          path: "/",
          domain: undefined,
          maxAge: 60 * 60 * 24 * 30
        };
    console.log("[Auth] Setting cookie", {
      host,
      origin,
      cookieDomain: cookieOpts.domain ?? "(none)",
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite
    });
    reply.clearCookie("proovra_session", { path: "/", domain: ".proovra.com" });
    reply.clearCookie("proovra_session", { path: "/" });
    reply.setCookie("proovra_session", token, cookieOpts);
  }

  // =========================
  // Guest
  // =========================
  app.post("/v1/auth/guest", async (req, reply) => {
    const profile = await createGuestProfile();
    const user = await upsertUser(profile);
    await ensureGuestIdentity(user.id);

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
    maybeSetWebCookie(req, reply, token);
    return reply.code(201).send({ token, user });
  });

  // =========================
  // Google
  // =========================
  app.post("/v1/auth/google", async (req, reply) => {
    try {
      const body = TokenBody.parse(req.body);
      let idToken = body.idToken ?? body.id_token ?? null;
      if (body.code) {
        idToken = await exchangeGoogleCodeForIdToken(body.code);
      }
      if (!idToken) {
        return reply.code(400).send({ message: "invalid_id_token" });
      }

      const profile = await verifyGoogleIdToken(idToken);
      const user = await upsertUser(profile);

      const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);
      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";
      if (message === "invalid_code") {
        return reply.code(400).send({
          message: "invalid_code",
          hint: "Code may be expired or already used. Ensure GOOGLE_REDIRECT_URI matches exactly."
        });
      }
      if (message === "redirect_uri_mismatch") {
        return reply.code(400).send({
          message: "redirect_uri_mismatch",
          hint: "GOOGLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback"
        });
      }
      if (message === "token_exchange_failed") {
        return reply.code(502).send({ message: "token_exchange_failed" });
      }
      return reply.code(401).send({ message: "invalid_id_token" });
    }
  });

  // =========================
  // Apple
  // =========================
  app.post("/v1/auth/apple", async (req, reply) => {
    try {
      const body = AppleBody.parse(req.body);
      let idToken = body.idToken ?? body.id_token ?? null;

      if (body.code) {
        console.log("[Apple Auth] Exchanging code for id_token...");
        idToken = await exchangeAppleCodeForIdToken(body.code);
        console.log("[Apple Auth] Code exchange success, got id_token");
      }
      if (!idToken) {
        console.log("[Apple Auth] Missing id_token after exchange");
        return reply.code(400).send({ message: "invalid_id_token" });
      }

      console.log("[Apple Auth] Verifying id_token...");
      const profile = await verifyAppleIdToken(idToken);
      console.log("[Apple Auth] Token verified, profile:", {
        provider: profile.provider,
        email: profile.email
      });

      const user = await upsertUserWithEmailLink(profile);
      console.log("[Apple Auth] User created/updated:", { id: user.id, email: user.email });

      const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";
      console.error("[Apple Auth] Error:", message, err instanceof Error ? err.stack : "");
      if (message === "invalid_code") {
        return reply.code(400).send({
          message: "invalid_code",
          hint: "Code may be expired or already used. Ensure APPLE_REDIRECT_URI matches exactly."
        });
      }
      if (message === "redirect_uri_mismatch") {
        return reply.code(400).send({
          message: "redirect_uri_mismatch",
          hint: "APPLE_REDIRECT_URI in API .env must match exactly: https://www.proovra.com/auth/callback"
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

  // =========================
  // Email + Password
  // =========================
  app.post("/v1/auth/email/register", async (req, reply) => {
    const body = EmailRegisterBody.parse(req.body);

    const user = await registerWithEmailPassword({
      email: body.email,
      password: body.password,
      displayName: body.displayName ?? null
    });

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

    maybeSetWebCookie(req, reply, token);
    return reply.code(201).send({ token, user });
  });

  app.post("/v1/auth/email/login", async (req, reply) => {
    const body = EmailLoginBody.parse(req.body);

    const user = await loginWithEmailPassword({
      email: body.email,
      password: body.password
    });

    if (!user) {
      return reply.code(401).send({ message: "invalid_credentials" });
    }

    const token = signJwt(jwtPayloadFromUser(user), jwtSecret, 60 * 60 * 24 * 30);

    // ANALYTICS: Track login_completed event (non-blocking, silently ignore errors)
    prisma.analyticsEvent.create({
      data: {
        eventType: "login_completed",
        userId: user.id,
        sessionId: `server_${Date.now()}`,
        visitorId: user?.id ? `server_user_${user.id}` : `server_anon_${Date.now()}`,
        metadata: {
          provider: user.provider ?? null
        }
      }
    }).catch(() => {
      // Silently ignore analytics errors
    });

    maybeSetWebCookie(req, reply, token);
    return reply.code(200).send({ token, user });
  });

  // =========================
  // Password reset
  // =========================
  app.post("/v1/auth/password-reset/request", async (req, reply) => {
    const body = PasswordResetRequestBody.parse(req.body);

    try {
      const result = await createPasswordResetTokenForEmail(body.email);

      // لا تكشف وجود المستخدم
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
      } catch (emailErr) {
        console.error("[PasswordReset] email send failed", emailErr);
      }

      return reply.code(200).send({ ok: true });
    } catch (err) {
      console.error("[PasswordReset] request failed", err);
      // دايمًا ok:true حتى ما نكشف existence
      return reply.code(200).send({ ok: true });
    }
  });

  app.post("/v1/auth/password-reset/confirm", async (req, reply) => {
    const body = PasswordResetConfirmBody.parse(req.body);

    const res = await resetPasswordWithToken({
      token: body.token,
      newPassword: body.newPassword
    });

    if (!res.ok) {
      return reply.code(400).send({ message: res.reason });
    }

    return reply.code(200).send({ ok: true });
  });

  // =========================
  // Logout
  // =========================
  app.post("/v1/auth/logout", async (req, reply) => {
    if (req.headers["x-web-client"] === "1") {
      const host = req.headers.host ?? "";
      const origin = req.headers.origin ?? "";
      const isProductionDomain = host.includes("proovra.com") || origin.includes("proovra.com");
      reply.clearCookie("proovra_session", {
        path: "/",
        domain: isProductionDomain ? ".proovra.com" : undefined
      });
    }
    return reply.code(200).send({ ok: true });
  });

  // =========================
  // Me
  // =========================
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
