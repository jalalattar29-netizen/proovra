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

export async function authRoutes(app: FastifyInstance) {
  const jwtSecret = process.env.AUTH_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is not set");
  }

  function maybeSetWebCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
    if (req.headers["x-web-client"] !== "1") return;
    const secure = process.env.NODE_ENV === "production";
    reply.setCookie("proovra_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
  }

  app.post("/v1/auth/guest", async (req, reply) => {
    const profile = await createGuestProfile();
    const user = await upsertUser(profile);
    await ensureGuestIdentity(user.id);
    const token = signJwt(
      {
        sub: user.id,
        provider: user.provider,
        email: user.email ?? null
      },
      jwtSecret,
      60 * 60 * 24 * 30
    );
    maybeSetWebCookie(req, reply, token);
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
        return reply.code(400).send({ message: "invalid_id_token" });
      }
      const profile = await verifyGoogleIdToken(idToken);
      const user = await upsertUser(profile);
      const token = signJwt(
        {
          sub: user.id,
          provider: user.provider,
          email: user.email ?? null
        },
        jwtSecret,
        60 * 60 * 24 * 30
      );
      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";
      if (message === "invalid_code") {
        return reply.code(400).send({ message: "invalid_code" });
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
        return reply.code(400).send({ message: "invalid_id_token" });
      }
      const profile = await verifyAppleIdToken(idToken);
      const user = await upsertUserWithEmailLink(profile);
      const token = signJwt(
        {
          sub: user.id,
          provider: user.provider,
          email: user.email ?? null
        },
        jwtSecret,
        60 * 60 * 24 * 30
      );
      maybeSetWebCookie(req, reply, token);
      return reply.code(200).send({ token, user });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_id_token";
      if (message === "invalid_code") {
        return reply.code(400).send({ message: "invalid_code" });
      }
      if (message === "token_exchange_failed") {
        return reply.code(502).send({ message: "token_exchange_failed" });
      }
      if (message === "apple_jwks_fetch_failed") {
        return reply.code(502).send({ message: "apple_jwks_fetch_failed" });
      }
      if (message === "invalid_id_token") {
        return reply.code(401).send({ message: "invalid_id_token" });
      }
      return reply.code(401).send({ message: "invalid_id_token" });
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    if (req.headers["x-web-client"] === "1") {
      reply.clearCookie("proovra_session", { path: "/" });
    }
    return reply.code(200).send({ ok: true });
  });

  app.get("/v1/auth/me", { preHandler: requireAuth }, async (req: FastifyRequest) => {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    return { user };
  });
}
