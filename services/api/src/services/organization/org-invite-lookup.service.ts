/**
 * Describe an organization invitation without consuming it (PRO-072).
 *
 * The acceptance page had to state what accepting grants without being able
 * to ask, and it guessed wrong: it said the invitation granted no workspace
 * access while acceptance wrote the invitation's workspace assignments (up to
 * workspace ADMIN). This is the read that lets it tell the truth.
 *
 * It is the organization twin of `lookupWorkspaceInvitation`, with the same
 * disclosure rules (see `OrganizationInvitationLookup`), and it reads the
 * facts the accept transaction acts on:
 *
 *   - status in the same order `runAcceptance` checks it (revoked, accepted,
 *     expired), then the organization's ACTIVE status;
 *   - the stored `workspaceAssignments`, parsed by the same
 *     `parseWorkspaceAssignments`, filtered as `replayProjection` filters them
 *     (the workspace still belongs to the organization and is not personal).
 *
 * It writes nothing, claims nothing and audits nothing.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { maskInvitedEmail, type OrganizationInvitationLookup } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { parseWorkspaceAssignments } from "../identity/membership-provisioning.service.js";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export async function lookupOrganizationInvitation(
  input: { rawToken: string },
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationInvitationLookup | null> {
  const invite = await client.organizationInvite.findUnique({
    where: { tokenHash: hashToken(input.rawToken) },
    select: {
      organizationId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      workspaceAssignments: true,
    },
  });
  if (!invite) return null;

  if (invite.revokedAt) return { state: "REVOKED", context: null };
  if (invite.acceptedAt) return { state: "ACCEPTED", context: null };
  if (invite.expiresAt <= new Date()) return { state: "EXPIRED", context: null };

  const organization = await client.organization.findUnique({
    where: { id: invite.organizationId },
    select: { name: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") {
    return { state: "NOT_ACCEPTING_MEMBERS", context: null };
  }

  const parsed = parseWorkspaceAssignments(invite.workspaceAssignments);
  const workspaces: Array<{ workspaceName: string; role: string }> = [];
  if (parsed.ok) {
    for (const assignment of parsed.assignments) {
      const team = await client.team.findUnique({
        where: { id: assignment.teamId },
        select: { name: true, organizationId: true, isPersonal: true },
      });
      if (team && team.organizationId === invite.organizationId && !team.isPersonal) {
        workspaces.push({ workspaceName: team.name, role: assignment.role });
      }
    }
  }

  return {
    state: "PENDING",
    context: {
      organizationName: organization.name,
      role: String(invite.role),
      invitedEmailMasked: maskInvitedEmail(invite.email),
      expiresAtUtc: invite.expiresAt.toISOString(),
      workspaces,
    },
  };
}
