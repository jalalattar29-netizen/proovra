/**
 * Team Management Service
 * Manages organizations, team members, invitations, and role-based access control
 */

import crypto from "crypto";

export enum TeamRole {
  OWNER = "owner",
  ADMIN = "admin",
  MEMBER = "member",
  VIEWER = "viewer",
}

export interface TeamMember {
  id: string;
  organizationId: string;
  userId: string;
  email: string;
  name?: string;
  role: TeamRole;
  joinedAt: Date;
  invitedBy?: string;
  invitedAt?: Date;
}

export interface Organization {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description?: string;
  logo?: string;
  createdAt: Date;
  members: TeamMember[];
  maxMembers: number;
}

export interface TeamInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: TeamRole;
  invitedBy: string;
  invitedAt: Date;
  acceptedAt?: Date;
  expiresAt: Date;
  token: string;
}

class TeamManagementService {
  private organizations = new Map<string, Organization>();
  private invitations = new Map<string, TeamInvitation>();

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Create a new organization
   */
  createOrganization(
    ownerId: string,
    name: string,
    slug: string,
    description?: string
  ): Organization {
    const orgId = `org_${crypto.randomBytes(12).toString("hex")}`;

    const organization: Organization = {
      id: orgId,
      ownerId,
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      description: description?.trim(),
      createdAt: new Date(),
      members: [
        {
          id: `mem_${crypto.randomBytes(12).toString("hex")}`,
          organizationId: orgId,
          userId: ownerId,
          email: ownerId,
          role: TeamRole.OWNER,
          joinedAt: new Date(),
        },
      ],
      maxMembers: 10,
    };

    this.organizations.set(orgId, organization);
    return organization;
  }

  /**
   * Get organization by ID
   */
  getOrganization(orgId: string): Organization | null {
    return this.organizations.get(orgId) || null;
  }

  /**
   * Get organization by slug
   */
  getOrganizationBySlug(slug: string): Organization | null {
    const normalizedSlug = slug.trim().toLowerCase();

    for (const org of this.organizations.values()) {
      if (org.slug === normalizedSlug) return org;
    }

    return null;
  }

  /**
   * List organizations for user (as owner or member)
   */
  getUserOrganizations(userId: string): Organization[] {
    const orgs: Organization[] = [];

    this.organizations.forEach((org) => {
      if (org.ownerId === userId || org.members.some((m) => m.userId === userId)) {
        orgs.push(org);
      }
    });

    return orgs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Invite user to organization
   */
  inviteToOrganization(
    organizationId: string,
    email: string,
    role: TeamRole = TeamRole.MEMBER,
    invitedBy: string
  ): TeamInvitation {
    const org = this.organizations.get(organizationId);
    if (!org) {
      throw new Error("Organization not found");
    }

    const normalizedEmail = this.normalizeEmail(email);

    const alreadyMember = org.members.some(
      (m) => this.normalizeEmail(m.email) === normalizedEmail
    );
    if (alreadyMember) {
      throw new Error("User is already a member of this organization");
    }

    for (const inv of this.invitations.values()) {
      if (
        inv.organizationId === organizationId &&
        this.normalizeEmail(inv.email) === normalizedEmail &&
        !inv.acceptedAt &&
        new Date() < inv.expiresAt
      ) {
        return inv;
      }
    }

    const invitationId = `inv_${crypto.randomBytes(12).toString("hex")}`;
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation: TeamInvitation = {
      id: invitationId,
      organizationId,
      email: normalizedEmail,
      role,
      invitedBy,
      invitedAt: new Date(),
      expiresAt,
      token,
    };

    this.invitations.set(invitationId, invitation);
    return invitation;
  }

  /**
   * Accept invitation
   */
  acceptInvitation(token: string, userId: string, email: string): TeamMember | null {
    let invitation: TeamInvitation | null = null;

    for (const inv of this.invitations.values()) {
      if (inv.token === token && !inv.acceptedAt) {
        if (new Date() < inv.expiresAt) {
          invitation = inv;
        }
        break;
      }
    }

    if (!invitation) return null;

    const normalizedEmail = this.normalizeEmail(email);
    if (normalizedEmail !== this.normalizeEmail(invitation.email)) {
      throw new Error("Invitation email does not match");
    }

    const org = this.organizations.get(invitation.organizationId);
    if (!org) return null;

    if (org.members.length >= org.maxMembers) {
      throw new Error("Organization has reached member limit");
    }

    const existingMember = org.members.find((m) => m.userId === userId);
    if (existingMember) {
      existingMember.role = invitation.role;
      existingMember.email = normalizedEmail;
      invitation.acceptedAt = new Date();
      return existingMember;
    }

    const member: TeamMember = {
      id: `mem_${crypto.randomBytes(12).toString("hex")}`,
      organizationId: org.id,
      userId,
      email: normalizedEmail,
      role: invitation.role,
      joinedAt: new Date(),
      invitedAt: invitation.invitedAt,
      invitedBy: invitation.invitedBy,
    };

    org.members.push(member);
    invitation.acceptedAt = new Date();

    return member;
  }

  /**
   * Get team members
   */
  getTeamMembers(organizationId: string): TeamMember[] {
    const org = this.organizations.get(organizationId);
    return org?.members ?? [];
  }

  /**
   * Update member role
   */
  updateMemberRole(organizationId: string, memberId: string, newRole: TeamRole): boolean {
    const org = this.organizations.get(organizationId);
    if (!org) return false;

    const member = org.members.find((m) => m.id === memberId);
    if (!member) return false;

    if (member.role === TeamRole.OWNER && newRole !== TeamRole.OWNER) {
      throw new Error("Cannot change owner role");
    }

    member.role = newRole;
    return true;
  }

  /**
   * Remove team member
   */
  removeTeamMember(organizationId: string, memberId: string): boolean {
    const org = this.organizations.get(organizationId);
    if (!org) return false;

    const memberIndex = org.members.findIndex((m) => m.id === memberId);
    if (memberIndex === -1) return false;

    const member = org.members[memberIndex];

    if (member.role === TeamRole.OWNER) {
      throw new Error("Cannot remove organization owner");
    }

    org.members.splice(memberIndex, 1);
    return true;
  }

  /**
   * Check if user has permission
   */
  hasPermission(
    organizationId: string,
    userId: string,
    requiredRole: TeamRole
  ): boolean {
    const org = this.organizations.get(organizationId);
    if (!org) return false;

    const member = org.members.find((m) => m.userId === userId);
    if (!member) return false;

    const roleHierarchy = {
      [TeamRole.OWNER]: 4,
      [TeamRole.ADMIN]: 3,
      [TeamRole.MEMBER]: 2,
      [TeamRole.VIEWER]: 1,
    };

    return roleHierarchy[member.role] >= roleHierarchy[requiredRole];
  }

  /**
   * List pending invitations
   */
  listInvitations(organizationId: string): TeamInvitation[] {
    const invitations: TeamInvitation[] = [];

    this.invitations.forEach((inv) => {
      if (
        inv.organizationId === organizationId &&
        !inv.acceptedAt &&
        new Date() < inv.expiresAt
      ) {
        invitations.push(inv);
      }
    });

    return invitations.sort((a, b) => b.invitedAt.getTime() - a.invitedAt.getTime());
  }

  /**
   * Revoke invitation
   */
  revokeInvitation(organizationId: string, invitationId: string): boolean {
    const inv = this.invitations.get(invitationId);
    if (!inv || inv.organizationId !== organizationId) return false;

    this.invitations.delete(invitationId);
    return true;
  }

  /**
   * Update organization
   */
  updateOrganization(
    organizationId: string,
    updates: {
      name?: string;
      description?: string;
      logo?: string;
      maxMembers?: number;
    }
  ): Organization | null {
    const org = this.organizations.get(organizationId);
    if (!org) return null;

    if (typeof updates.name === "string" && updates.name.trim()) {
      org.name = updates.name.trim();
    }

    if (typeof updates.description === "string") {
      org.description = updates.description.trim() || undefined;
    }

    if (typeof updates.logo === "string") {
      org.logo = updates.logo.trim() || undefined;
    }

    if (typeof updates.maxMembers === "number" && updates.maxMembers > 0) {
      org.maxMembers = updates.maxMembers;
    }

    return org;
  }
}

export const teamManagementService = new TeamManagementService();