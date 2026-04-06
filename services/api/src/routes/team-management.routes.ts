/**
 * Team Management Routes
 * Legacy organization-style endpoints
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { AppError, ErrorCode } from "../errors.js";
import {
  teamManagementService,
  TeamRole,
} from "../services/team-management.service.js";
import { getEmailService } from "../services/email.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditOrgAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "team_management",
    severity: params.severity ?? "info",
    source: "api_team_management",
    outcome: params.outcome ?? "success",
    resourceType: params.resourceType ?? "organization",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireOrgAnalytics(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "organization",
    entityId: params.entityId ?? null,
    severity: "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function teamManagementRoutes(app: FastifyInstance) {
  app.post<{
    Body: { name: string; slug: string; description?: string };
  }>(
    "/v1/organizations",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { name, slug, description } = req.body;

      if (!name || !slug) {
        auditOrgAction(req, {
          userId,
          action: "organization.create",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "missing_name_or_slug" },
        });
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Name and slug are required");
      }

      if (!/^[a-z0-9-]+$/.test(slug)) {
        auditOrgAction(req, {
          userId,
          action: "organization.create",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "invalid_slug", slug },
        });
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

        auditOrgAction(req, {
          userId,
          action: "organization.create",
          outcome: "success",
          resourceId: org.id,
          metadata: { slug: org.slug },
        });

        fireOrgAnalytics({
          eventType: "organization_created",
          userId,
          req,
          entityId: org.id,
        });

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
      } catch {
        auditOrgAction(req, {
          userId,
          action: "organization.create",
          outcome: "failure",
          severity: "critical",
          metadata: { reason: "create_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to create organization"
        );
      }
    }
  );

  app.get(
    "/v1/organizations",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;

      try {
        const organizations = teamManagementService.getUserOrganizations(userId);

        auditOrgAction(req, {
          userId,
          action: "organization.list",
          outcome: "success",
          metadata: { count: organizations.length },
        });

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
      } catch {
        auditOrgAction(req, {
          userId,
          action: "organization.list",
          outcome: "failure",
          severity: "critical",
          metadata: { reason: "list_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list organizations"
        );
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        const org = teamManagementService.getOrganization(id);

        if (!org) {
          auditOrgAction(req, {
            userId,
            action: "organization.view",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Organization not found");
        }

        if (!teamManagementService.hasPermission(id, userId, TeamRole.VIEWER)) {
          auditOrgAction(req, {
            userId,
            action: "organization.view",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden" },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "You don't have access to this organization"
          );
        }

        const members = teamManagementService.getTeamMembers(id);

        auditOrgAction(req, {
          userId,
          action: "organization.view",
          outcome: "success",
          resourceId: id,
          metadata: { memberCount: members.length },
        });

        fireOrgAnalytics({
          eventType: "organization_viewed",
          userId,
          req,
          entityId: id,
        });

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
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.view",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "retrieve_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to retrieve organization"
        );
      }
    }
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; logo?: string; maxMembers?: number };
  }>(
    "/v1/organizations/:id",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.update",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden" },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can update organization"
          );
        }

        const updated = teamManagementService.updateOrganization(id, req.body);

        if (!updated) {
          auditOrgAction(req, {
            userId,
            action: "organization.update",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "not_found" },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Organization not found");
        }

        auditOrgAction(req, {
          userId,
          action: "organization.update",
          outcome: "success",
          resourceId: id,
          metadata: { updatedFields: Object.keys(req.body ?? {}) },
        });

        fireOrgAnalytics({
          eventType: "organization_updated",
          userId,
          req,
          entityId: id,
          metadata: { updatedFields: Object.keys(req.body ?? {}) },
        });

        return {
          data: {
            id: updated.id,
            name: updated.name,
            slug: updated.slug,
            description: updated.description,
            logo: updated.logo,
            maxMembers: updated.maxMembers,
          },
          message: "Organization updated successfully",
        };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.update",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "update_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update organization"
        );
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { email: string; role?: TeamRole };
  }>(
    "/v1/organizations/:id/members/invite",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;
      const { email, role = TeamRole.MEMBER } = req.body;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.member_invite",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden", email },
          });
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

        let emailSent = false;
        try {
          const emailService = getEmailService();
          if (emailService.isConfigured()) {
            const org = teamManagementService.getOrganization(id);
            await emailService.sendTeamInvitation(
              email,
              org?.name || "PROOVRA",
              invitation.token
            );
            emailSent = true;
          }
        } catch (emailError) {
          console.error("Failed to send invitation email:", emailError);
        }

        auditOrgAction(req, {
          userId,
          action: "organization.member_invite",
          outcome: "success",
          resourceId: id,
          metadata: {
            email,
            role,
            invitationId: invitation.id,
            emailSent,
          },
        });

        fireOrgAnalytics({
          eventType: "organization_member_invited",
          userId,
          req,
          entityId: id,
          metadata: { role },
        });

        return {
          data: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            invitedAt: invitation.invitedAt,
            expiresAt: invitation.expiresAt,
            token: invitation.token,
            emailSent,
          },
          message: emailSent
            ? "Invitation sent successfully"
            : "Invitation created successfully",
        };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.member_invite",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "invite_failed", email },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to send invitation"
        );
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id/members",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.VIEWER)) {
          auditOrgAction(req, {
            userId,
            action: "organization.members_list",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden" },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "You don't have access to this organization"
          );
        }

        const members = teamManagementService.getTeamMembers(id);

        auditOrgAction(req, {
          userId,
          action: "organization.members_list",
          outcome: "success",
          resourceId: id,
          metadata: { count: members.length },
        });

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
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.members_list",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "list_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list team members"
        );
      }
    }
  );

  app.patch<{
    Params: { id: string; memberId: string };
    Body: { role: TeamRole };
  }>(
    "/v1/organizations/:id/members/:memberId/role",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, memberId } = req.params;
      const { role } = req.body;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.member_role_update",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden", memberId },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can change member roles"
          );
        }

        const updated = teamManagementService.updateMemberRole(id, memberId, role);

        if (!updated) {
          auditOrgAction(req, {
            userId,
            action: "organization.member_role_update",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "member_not_found", memberId },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Member not found");
        }

        auditOrgAction(req, {
          userId,
          action: "organization.member_role_update",
          outcome: "success",
          resourceId: id,
          metadata: { memberId, role },
        });

        fireOrgAnalytics({
          eventType: "organization_member_role_updated",
          userId,
          req,
          entityId: id,
          metadata: { memberId, role },
        });

        return { message: "Member role updated successfully" };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.member_role_update",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "update_failed", memberId },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to update member role"
        );
      }
    }
  );

  app.delete<{ Params: { id: string; memberId: string } }>(
    "/v1/organizations/:id/members/:memberId",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, memberId } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.member_remove",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden", memberId },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can remove members"
          );
        }

        const removed = teamManagementService.removeTeamMember(id, memberId);

        if (!removed) {
          auditOrgAction(req, {
            userId,
            action: "organization.member_remove",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "member_not_found", memberId },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Member not found");
        }

        auditOrgAction(req, {
          userId,
          action: "organization.member_remove",
          outcome: "success",
          resourceId: id,
          metadata: { memberId },
        });

        fireOrgAnalytics({
          eventType: "organization_member_removed",
          userId,
          req,
          entityId: id,
          metadata: { memberId },
        });

        return { message: "Team member removed successfully" };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.member_remove",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "remove_failed", memberId },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to remove team member"
        );
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/organizations/:id/invitations",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.invitations_list",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden" },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can view invitations"
          );
        }

        const invitations = teamManagementService.listInvitations(id);

        auditOrgAction(req, {
          userId,
          action: "organization.invitations_list",
          outcome: "success",
          resourceId: id,
          metadata: { count: invitations.length },
        });

        return {
          data: invitations.map((inv) => ({
            id: inv.id,
            email: inv.email,
            role: inv.role,
            invitedAt: inv.invitedAt,
            expiresAt: inv.expiresAt,
            token: inv.token,
          })),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.invitations_list",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "list_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to list invitations"
        );
      }
    }
  );

  app.delete<{ Params: { id: string; invitationId: string } }>(
    "/v1/organizations/:id/invitations/:invitationId",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { id, invitationId } = req.params;

      try {
        if (!teamManagementService.hasPermission(id, userId, TeamRole.ADMIN)) {
          auditOrgAction(req, {
            userId,
            action: "organization.invitation_revoke",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden", invitationId },
          });
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only admins can revoke invitations"
          );
        }

        const revoked = teamManagementService.revokeInvitation(id, invitationId);

        if (!revoked) {
          auditOrgAction(req, {
            userId,
            action: "organization.invitation_revoke",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "invitation_not_found", invitationId },
          });
          throw new AppError(ErrorCode.NOT_FOUND, "Invitation not found");
        }

        auditOrgAction(req, {
          userId,
          action: "organization.invitation_revoke",
          outcome: "success",
          resourceId: id,
          metadata: { invitationId },
        });

        fireOrgAnalytics({
          eventType: "organization_invitation_revoked",
          userId,
          req,
          entityId: id,
          metadata: { invitationId },
        });

        return { message: "Invitation revoked successfully" };
      } catch (error) {
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.invitation_revoke",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: { reason: "revoke_failed", invitationId },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to revoke invitation"
        );
      }
    }
  );

  app.post<{
    Params: { token: string };
    Body: { email: string };
  }>(
    "/v1/organizations/invitations/:token/accept",
    { preHandler: [requireAuthAndLegal] },
    async (req: any) => {
      const userId = req.user!.sub;
      const { token } = req.params;
      const { email } = req.body;

      try {
        const member = teamManagementService.acceptInvitation(token, userId, email);

        if (!member) {
          auditOrgAction(req, {
            userId,
            action: "organization.invitation_accept",
            outcome: "failure",
            severity: "warning",
            metadata: { reason: "invalid_or_expired_invitation" },
          });
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid or expired invitation"
          );
        }

        auditOrgAction(req, {
          userId,
          action: "organization.invitation_accept",
          outcome: "success",
          resourceId: member.organizationId,
          metadata: { role: member.role },
        });

        fireOrgAnalytics({
          eventType: "organization_invitation_accepted",
          userId,
          req,
          entityId: member.organizationId,
          metadata: { role: member.role },
        });

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
        if (error instanceof AppError) throw error;

        auditOrgAction(req, {
          userId,
          action: "organization.invitation_accept",
          outcome: "failure",
          severity: "critical",
          metadata: { reason: "accept_failed" },
        });

        throw new AppError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          "Failed to accept invitation"
        );
      }
    }
  );
}