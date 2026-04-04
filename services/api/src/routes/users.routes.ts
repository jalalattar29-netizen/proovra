import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

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
    };

    setStr("displayName", 120);
    setStr("firstName", 80);
    setStr("lastName", 80);
    setStr("avatarUrl", 512);
    setStr("locale", 12);
    setStr("timezone", 64);

    // country = full country name (stored as-is, trimmed, up to 120 chars)
    if (typeof body.country === "string") {
      const trimmed = body.country.trim();
      if (trimmed.length > 0) {
        data.country = trimmed.slice(0, 120);
      }
    } else if (body.country === null) {
      data.country = null;
    }

    // bio
    if (typeof body.bio === "string") data.bio = body.bio.trim().slice(0, 280);

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
    });

    return { user: pickMe(updated) };
  });
}