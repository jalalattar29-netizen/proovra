/**
 * Team Management Routes
 * Endpoints for managing organizations, team members, and invitations
 */

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { AppError, ErrorCode } from "../errors.js";
import { teamManagementService, TeamRole } from "../services/team-management.service.js";
import { getEmailService } from "../services/email.service.js";

export async function teamManagementRoutes(app: FastifyInstance) {
  /**
   * Organizations
   */

  /**
   * Create organization
   * POST /v1/organizations
   */
  app.post<{
    Body: { name: string; slug: string; description?: string };
  }>(
    "/v1/organizations",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { name, slug, description } = req.body;

      if (!name || !slug) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Name and slug are required"
        );
      }

      if (!/^[a-z0-9-]+$/.test(slug)) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Slug can only contain lowercase letters, numbers, and hyphens"
        );
      }

      try {
        const org = teamManagementService.createOrganization(
          userId,
          name,
          slug,
          description
        );

        return {
          data: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            description: org.description,
            createdAt: org.createdAt,
            memberCount: org.members.length,
            maxMembers: org.maxMembers,
          },
          message: "Organization created successfully",
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to create organization"
        );
      }
    }
  );

  /**
   * Get organizations for user
   * GET /v1/organizations
   */
  app.get(
    "/v1/organizations",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const organizations = teamManagementService.getUserOrganizations(userId);

        return {
          data: organizations.map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            description: org.description,
            createdAt: org.createdAt,
            memberCount: org.members.length,
            maxMembers: org.maxMembers,
            isOwner: org.ownerId === userId,
          })),
        };
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list organizations"
        );
      }
    }
  );

  /**
   * Get organization details
   * GET /v1/organizations/:id
   */
  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const org = teamManagementService.getOrganization(id);

        if (!org) {
          throw new AppError(ErrorCode.NOT_FOUND, "Organization not found");
        }

        // Check permission
        if (!teamManagementService.hasPermission(id, userId, TeamRole.VIEWER)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "You don't have access to this organization"
          );
        }

        const members = teamManagementService.getTeamMembers(id);

        return {
          data: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            description: org.description,
            createdAt: org.createdAt,
            memberCount: members.length,
            maxMembers: org.maxMembers,
            isOwner: org.ownerId === userId,
            members: members.map((m) => ({
              id: m.id,
              userId: m.userId,
              email: m.email,
              name: m.name,
              role: m.role,
              joinedAt: m.joinedAt,
            })),
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to retrieve organization"
        );
      }
    }
  );

  /**
   * Update organization
   * PATCH /v1/organizations/:id
   */
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; logo?: string };
  }>(
    "/v1/organizations/:id",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        // Check permission - must be admin or owner
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can update organization"
          );
        }

        const updated = teamManagementService.updateOrganization(id, req.body);

        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, "Organization not found");
        }

        return { message: "Organization updated successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update organization"
        );
      }
    }
  );

  /**
   * Team Members & Invitations
   */

  /**
   * Invite member to organization
   * POST /v1/organizations/:id/members/invite
   */
  app.post<{
    Params: { id: string };
    Body: { email: string; role?: TeamRole };
  }>(
    "/v1/organizations/:id/members/invite",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;
      const { email, role = TeamRole.MEMBER } = req.body;

      try {
        // Check permission - must be admin or owner
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can invite members"
          );
        }

        const invitation = teamManagementService.inviteToOrganization(
          id,
          email,
          role,
          userId
        );

        // Send invitation email if email service is configured
        try {
          const emailService = getEmailService();
          if (emailService.isConfigured()) {
            const org = teamManagementService.getOrganization(id);
            await emailService.sendTeamInvitation(
              email,
              org?.name || "Digital Witness",
              invitation.token
            );
          }
        } catch (emailError) {
          console.error('Failed to send invitation email:', emailError);
          // Continue anyway - invitation was created successfully
        }

        return {
          data: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            expiresAt: invitation.expiresAt,
          },
          message: "Invitation sent successfully",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to send invitation"
        );
      }
    }
  );

  /**
   * List team members
   * GET /v1/organizations/:id/members
   */
  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id/members",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.VIEWER)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "You don't have access to this organization"
          );
        }

        const members = teamManagementService.getTeamMembers(id);

        return {
          data: members.map((m) => ({
            id: m.id,
            userId: m.userId,
            email: m.email,
            name: m.name,
            role: m.role,
            joinedAt: m.joinedAt,
            invitedBy: m.invitedBy,
          })),
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list team members"
        );
      }
    }
  );

  /**
   * Update member role
   * PATCH /v1/organizations/:id/members/:memberId/role
   */
  app.patch<{
    Params: { id: string; memberId: string };
    Body: { role: TeamRole };
  }>(
    "/v1/organizations/:id/members/:memberId/role",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, memberId } = req.params;
      const { role } = req.body;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can change member roles"
          );
        }

        const updated = teamManagementService.updateMemberRole(id, memberId, role);

        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, "Member not found");
        }

        return { message: "Member role updated successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update member role"
        );
      }
    }
  );

  /**
   * Remove team member
   * DELETE /v1/organizations/:id/members/:memberId
   */
  app.delete<{ Params: { id: string; memberId: string } }>(
    "/v1/organizations/:id/members/:memberId",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, memberId } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can remove members"
          );
        }

        const removed = teamManagementService.removeTeamMember(id, memberId);

        if (!removed) {
          throw new AppError(ErrorCode.NOT_FOUND, "Member not found");
        }

        return { message: "Team member removed successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to remove team member"
        );
      }
    }
  );

  /**
   * List pending invitations
   * GET /v1/organizations/:id/invitations
   */
  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id/invitations",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can view invitations"
          );
        }

        const invitations = teamManagementService.listInvitations(id);

        return {
          data: invitations.map((inv) => ({
            id: inv.id,
            email: inv.email,
            role: inv.role,
            invitedAt: inv.invitedAt,
            expiresAt: inv.expiresAt,
          })),
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list invitations"
        );
      }
    }
  );

  /**
   * Revoke invitation
   * DELETE /v1/organizations/:id/invitations/:invitationId
   */
  app.delete<{ Params: { id: string; invitationId: string } }>(
    "/v1/organizations/:id/invitations/:invitationId",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, invitationId } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can revoke invitations"
          );
        }

        const revoked = teamManagementService.revokeInvitation(id, invitationId);

        if (!revoked) {
          throw new AppError(ErrorCode.NOT_FOUND, "Invitation not found");
        }

        return { message: "Invitation revoked successfully" };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to revoke invitation"
        );
      }
    }
  );

  /**
   * Accept invitation
   * POST /v1/organizations/invitations/:token/accept
   */
  app.post<{
    Params: { token: string };
    Body: { email: string };
  }>(
    "/v1/organizations/invitations/:token/accept",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { token } = req.params;
      const { email } = req.body;

      try {
        const member = teamManagementService.acceptInvitation(token, userId, email);

        if (!member) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid or expired invitation"
          );
        }

        return {
          data: {
            id: member.id,
            organizationId: member.organizationId,
            role: member.role,
            joinedAt: member.joinedAt,
          },
          message: "Invitation accepted successfully",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to accept invitation"
        );
      }
    }
  );
}
