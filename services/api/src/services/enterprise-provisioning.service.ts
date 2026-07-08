/**
 * Phase 2 — Enterprise activation & provisioning keystone.
 *
 * Two platform-admin-only operations that let an enterprise customer be
 * activated WITHOUT a manual DB edit, reusing the LOCKED org/workspace/
 * invite primitives (Organization, Team, OrganizationInvite,
 * OrganizationMembership). No parallel models are introduced.
 *
 *   grantEnterprisePlanToOrg   — flip every workspace (Team) of an org
 *                                to a billing plan (ENTERPRISE) so the
 *                                existing capability gates auto-unlock
 *                                (getPlanCapabilities(plan).enterpriseFeatures).
 *   provisionEnterpriseCustomer — create a new Organization and either
 *                                (a) attach an enterprise workspace to an
 *                                existing owner, or (b) mint a canonical
 *                                ORG_OWNER invite for a not-yet-existing
 *                                owner (no workspace — ownerUserId is
 *                                required on Team).
 *
 * Hard rules:
 *   - This is the ONLY path (besides the locked billing checkout/webhook,
 *     which we never touch) that assigns ENTERPRISE.
 *   - Every mutation writes its audit rows INSIDE the same transaction
 *     (org audit) plus a platform audit-log row (chain-hashed) after
 *     commit. Effect-without-audit is unacceptable.
 *   - Invite tokens: raw 32-byte hex returned ONCE; only the SHA-256
 *     hash is persisted (mirrors organizations.routes.ts).
 */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TeamBillingStatus, TeamRole } from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import { hashInviteToken } from "../routes/organizations.routes.js";
import { emitOrgAuditEvent } from "./organization/org-audit.service.js";
import { appendPlatformAuditLog } from "./platform-audit-log.service.js";

/** Plans this admin path is allowed to grant. ENTERPRISE only for now. */
export type GrantablePlan = "ENTERPRISE";

/** 7-day invite expiry (mirrors organizations.routes.ts inviteExpiresAt). */
function inviteExpiresAt(now = Date.now()): Date {
  return new Date(now + 7 * 24 * 60 * 60 * 1000);
}

/** 32 random bytes hex-encoded (mirrors organizations.routes.ts newInviteToken). */
function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export class EnterpriseProvisioningError extends Error {
  code: "ORG_NOT_FOUND" | "ORG_HAS_NO_WORKSPACES";
  constructor(code: EnterpriseProvisioningError["code"], message: string) {
    super(message);
    this.name = "EnterpriseProvisioningError";
    this.code = code;
  }
}

export type GrantEnterprisePlanInput = {
  orgId: string;
  plan?: GrantablePlan;
  seats?: number;
  actorUserId: string;
};

export type GrantEnterprisePlanResult = {
  organizationId: string;
  plan: GrantablePlan;
  seats: number;
  workspacesUpdated: number;
};

/**
 * Grant a billing plan (ENTERPRISE) to EVERY workspace (Team) of an org.
 *
 * For each workspace:
 *   billingPlan   = plan
 *   includedSeats = seats ?? getPlanCapabilities(plan).includedSeats
 *   billingStatus = ACTIVE
 *   overSeatLimit = (active member count > seats)
 *
 * Setting billingPlan=ENTERPRISE auto-unlocks SSO/SCIM/legalHold/etc via
 * getPlanCapabilities(plan).enterpriseFeatures — no separate feature flags.
 */
export async function grantEnterprisePlanToOrg(
  input: GrantEnterprisePlanInput,
  client: PrismaClient = defaultPrisma,
): Promise<GrantEnterprisePlanResult> {
  const plan: GrantablePlan = input.plan ?? "ENTERPRISE";
  const seats = input.seats ?? getPlanCapabilities(plan).includedSeats;

  const result = await client.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: input.orgId },
      select: { id: true },
    });
    if (!org) {
      throw new EnterpriseProvisioningError(
        "ORG_NOT_FOUND",
        "Organization not found.",
      );
    }

    const workspaces = await tx.team.findMany({
      where: { organizationId: input.orgId },
      select: { id: true, _count: { select: { members: true } } },
    });

    for (const ws of workspaces) {
      const overSeatLimit = ws._count.members > seats;
      await tx.team.update({
        where: { id: ws.id },
        data: {
          billingPlan: plan,
          includedSeats: seats,
          billingStatus: TeamBillingStatus.ACTIVE,
          overSeatLimit,
        },
      });
    }

    await emitOrgAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.actorUserId,
      eventType: "ORG_PLAN_GRANTED",
      targetType: "organization",
      targetId: input.orgId,
      metadata: {
        plan,
        seats,
        workspacesUpdated: workspaces.length,
      },
    });

    return { workspacesUpdated: workspaces.length };
  });

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "ORG_PLAN_GRANTED",
    category: "enterprise_provisioning",
    severity: "INFO",
    outcome: "success",
    resourceType: "organization",
    resourceId: input.orgId,
    metadata: {
      organizationId: input.orgId,
      plan,
      seats,
      workspacesUpdated: result.workspacesUpdated,
    },
    db: client,
  });

  return {
    organizationId: input.orgId,
    plan,
    seats,
    workspacesUpdated: result.workspacesUpdated,
  };
}

export type ProvisionEnterpriseCustomerInput = {
  organizationName: string;
  ownerEmail: string;
  seats?: number;
  workspaceName?: string;
  actorUserId: string;
};

export type ProvisionEnterpriseCustomerResult =
  | {
      organizationId: string;
      workspaceId: string;
      ownerUserId: string;
      provisioned: true;
    }
  | {
      organizationId: string;
      ownerInviteToken: string;
      inviteUrl: string;
      provisioned: false;
      pendingOwner: true;
    };

/**
 * Provision a brand-new enterprise customer in ONE transaction.
 *
 *   - Owner user EXISTS   → create Organization + enterprise Team(workspace)
 *                           owned by that user, ORG_OWNER membership, set
 *                           org.billingOwnerUserId. Returns provisioned:true.
 *   - Owner user MISSING  → create Organization (billingOwnerUserId null) +
 *                           a canonical ORG_OWNER invite for ownerEmail. No
 *                           workspace (Team.ownerUserId is required). Returns
 *                           provisioned:false, the raw invite token (once),
 *                           and pendingOwner:true.
 */
export async function provisionEnterpriseCustomer(
  input: ProvisionEnterpriseCustomerInput,
  client: PrismaClient = defaultPrisma,
): Promise<ProvisionEnterpriseCustomerResult> {
  const seats = input.seats ?? getPlanCapabilities("ENTERPRISE").includedSeats;
  const email = input.ownerEmail.trim().toLowerCase();

  // `email` is not a unique column on User in this schema (auth is by
  // provider), so we resolve by findFirst — the same lookup SCIM uses.
  const owner = await client.user.findFirst({
    where: { email },
    select: { id: true },
  });

  if (owner) {
    const result = await client.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          billingOwnerUserId: owner.id,
          status: "ACTIVE",
        },
        select: { id: true },
      });

      await tx.organizationMembership.create({
        data: {
          organizationId: org.id,
          userId: owner.id,
          role: "ORG_OWNER",
        },
      });

      const workspace = await tx.team.create({
        data: {
          name: input.workspaceName ?? input.organizationName,
          ownerUserId: owner.id,
          billingOwnerUserId: owner.id,
          organizationId: org.id,
          billingPlan: "ENTERPRISE",
          billingStatus: TeamBillingStatus.ACTIVE,
          includedSeats: seats,
          members: {
            create: {
              userId: owner.id,
              role: TeamRole.OWNER,
            },
          },
        },
        select: { id: true },
      });

      await emitOrgAuditEvent(tx, {
        organizationId: org.id,
        actorUserId: input.actorUserId,
        eventType: "ENTERPRISE_PROVISIONED",
        targetType: "organization",
        targetId: org.id,
        metadata: {
          organizationName: input.organizationName,
          ownerUserId: owner.id,
          workspaceId: workspace.id,
          seats,
          provisioned: true,
        },
      });

      return { organizationId: org.id, workspaceId: workspace.id };
    });

    await appendPlatformAuditLog({
      userId: input.actorUserId,
      action: "ENTERPRISE_PROVISIONED",
      category: "enterprise_provisioning",
      severity: "INFO",
      outcome: "success",
      resourceType: "organization",
      resourceId: result.organizationId,
      metadata: {
        organizationId: result.organizationId,
        workspaceId: result.workspaceId,
        ownerUserId: owner.id,
        ownerEmail: email,
        seats,
        provisioned: true,
      },
      db: client,
    });

    return {
      organizationId: result.organizationId,
      workspaceId: result.workspaceId,
      ownerUserId: owner.id,
      provisioned: true,
    };
  }

  // Owner does not exist yet — create the org and a canonical ORG_OWNER
  // invite. No workspace: Team.ownerUserId is a required non-null column,
  // so we cannot create a workspace before an owner exists.
  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = inviteExpiresAt();

  const result = await client.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.organizationName,
        billingOwnerUserId: null,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    const invite = await tx.organizationInvite.create({
      data: {
        organizationId: org.id,
        email,
        role: "ORG_OWNER",
        token: null,
        tokenHash,
        invitedByUserId: input.actorUserId,
        expiresAt,
      },
      select: { id: true },
    });

    await emitOrgAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: input.actorUserId,
      eventType: "ENTERPRISE_PROVISIONED",
      targetType: "organization",
      targetId: org.id,
      metadata: {
        organizationName: input.organizationName,
        inviteId: invite.id,
        email,
        seats,
        provisioned: false,
        pendingOwner: true,
      },
    });

    // Record the invite lifecycle event too, mirroring the org-invite path.
    await emitOrgAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: input.actorUserId,
      eventType: "ORG_MEMBER_INVITED",
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: {
        inviteId: invite.id,
        email,
        role: "ORG_OWNER",
        expiresAt: expiresAt.toISOString(),
        invitedByUserId: input.actorUserId,
      },
    });

    return { organizationId: org.id };
  });

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "ENTERPRISE_PROVISIONED",
    category: "enterprise_provisioning",
    severity: "INFO",
    outcome: "success",
    resourceType: "organization",
    resourceId: result.organizationId,
    metadata: {
      organizationId: result.organizationId,
      ownerEmail: email,
      seats,
      provisioned: false,
      pendingOwner: true,
    },
    db: client,
  });

  return {
    organizationId: result.organizationId,
    ownerInviteToken: token,
    inviteUrl: `/invite/${token}`,
    provisioned: false,
    pendingOwner: true,
  };
}
