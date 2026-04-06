import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserLegalAcceptanceStatus, recordLegalAcceptances } from "../services/legal-acceptance.service.js";

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
}