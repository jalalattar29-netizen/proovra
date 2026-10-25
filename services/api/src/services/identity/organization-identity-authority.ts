/**
 * WHO MAY CHANGE AN ORGANIZATION'S IDENTITY CONFIGURATION (members audit
 * DOM-13, owner decision 2026-10-25).
 *
 * SSO connections, SCIM credentials, SCIM groups and their Workspace
 * projections, and external identity links belong to the ORGANIZATION: a
 * change made from one Workspace applies to every Workspace of it. A
 * Workspace administrator therefore cannot make it on Workspace authority
 * alone — the actor must also hold an Organization identity role, the same
 * named set that administers the Organization's verified domains
 * (`ORG_DOMAIN_WRITE_ROLES`: ORG_OWNER, ORG_ADMIN, ORG_SECURITY_ADMIN).
 *
 * A SYSTEM Organization is the internal container of exactly one Workspace
 * and has no Organization roles; there the Workspace IS the Organization's
 * whole extent, so the Workspace authority the route already checked is the
 * Organization authority, and nothing more is asked.
 *
 * This runs IN ADDITION to the route's Workspace permission check, never
 * instead of it. Reads stay on Workspace authority.
 */
import type { FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { checkOrgAccess, ORG_DOMAIN_WRITE_ROLES } from "../organization/org-access.js";

export const ORGANIZATION_IDENTITY_ADMIN_REQUIRED = "ORGANIZATION_IDENTITY_ADMIN_REQUIRED" as const;

export type OrganizationIdentityAuthority =
  | { ok: true; organizationId: string }
  | { ok: false; organizationId: string | null };

export async function evaluateOrganizationIdentityAuthority(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationIdentityAuthority> {
  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true, organization: { select: { kind: true } } },
  });
  if (!team) return { ok: false, organizationId: null };
  if (team.organization.kind !== "CUSTOMER") return { ok: true, organizationId: team.organizationId };
  const access = await checkOrgAccess(client, {
    orgId: team.organizationId,
    userId: input.userId,
    roles: ORG_DOMAIN_WRITE_ROLES,
  });
  return access.kind === "ok"
    ? { ok: true, organizationId: team.organizationId }
    : { ok: false, organizationId: team.organizationId };
}

/**
 * Route guard: answers 403 ORGANIZATION_IDENTITY_ADMIN_REQUIRED and returns
 * false when the actor lacks the Organization identity role.
 */
export async function requireOrganizationIdentityAuthority(
  reply: FastifyReply,
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const decision = await evaluateOrganizationIdentityAuthority(input, client);
  if (decision.ok) return true;
  reply.code(403).send({
    error: {
      code: ORGANIZATION_IDENTITY_ADMIN_REQUIRED,
      message:
        "Identity settings belong to the organization. An organization owner, admin or security admin can change them.",
    },
  });
  return false;
}
