import { prisma } from "../db.js";

function parsePlatformAdminEnvIds(): string[] {
  const raw = process.env.PLATFORM_ADMIN_USER_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Platform admin: JWT role claim, env allow-list, or users.platform_role === 'admin'.
 */
export async function isPlatformAdmin(
  userId: string,
  jwtRole?: string | null
): Promise<boolean> {
  if (jwtRole === "admin") return true;
  if (parsePlatformAdminEnvIds().includes(userId)) return true;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });
  return u?.platformRole === "admin";
}
