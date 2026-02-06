import * as prismaPkg from "@prisma/client";

const roleRank: Record<prismaPkg.TeamRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
  VIEWER: 0
};

export function hasRole(
  role: prismaPkg.TeamRole,
  required: prismaPkg.TeamRole
): boolean {
  return roleRank[role] >= roleRank[required];
}
