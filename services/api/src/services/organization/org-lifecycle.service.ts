/**
 * PHASE 4 §7.6 (2026-07-22) — organization SUSPENDED lifecycle.
 *
 * ONE canonical `suspendOrganization` / `resumeOrganization` pair for
 * CUSTOMER organizations (platform-operator action — billing/contract
 * enforcement). Mirrors org-closure minus the ARCHIVED permanence.
 *
 * Suspension effects (all reversible except invites/sessions, which are
 * re-issued/re-authenticated rather than restored):
 *   1. Organization.status → SUSPENDED. This is the master halt:
 *      `authorizeOrFail` denies EVERY ORGANIZATION-workspace operation
 *      when the parent org is not ACTIVE, `checkOrgAccess` denies every
 *      org-governance surface, and the platform-context switcher
 *      excludes non-ACTIVE orgs — so new operations stop structurally.
 *   2. Sessions of the org's workspace members are revoked (JWT source
 *      of truth) — suspended tenants re-authenticate after resume.
 *   3. SSO connections ACTIVE → SUSPENDED (string status; only ACTIVE
 *      connections initiate logins). Resume flips exactly these back.
 *   4. SCIM provisioning tokens ACTIVE → SUSPENDED (middleware requires
 *      status === "ACTIVE", so directory sync halts). Resume restores.
 *   5. Open org invites are expired (expiresAt = now). NOT restored on
 *      resume — invites are re-issued deliberately.
 *   6. API credentials are soft-paused via `disabledAtUtc` (the schema's
 *      documented pause distinct from REVOKED-is-permanent; both the
 *      verify path and access-policy reject disabled credentials). The
 *      exact ids paused are recorded in the ORG_SUSPENDED audit event,
 *      and resume re-enables precisely that set — credentials an
 *      operator disabled individually are never silently re-armed.
 *   7. Switcher/session pointers (currentWorkspaceId) into the org's
 *      workspaces are cleared — users land on their personal workspace.
 *
 * Deliberately untouched (recorded decisions):
 *   * Team memberships — suspension is org-level; membership rows keep
 *     their status so resume restores the exact prior access picture.
 *   * Webhook endpoints — event-producing operations halt with the org,
 *     so endpoints stay ACTIVE and integrations resume seamlessly
 *     (closure — permanent — is where endpoints are disabled).
 *   * Evidence, custody, anchors, audit history — NEVER touched by
 *     lifecycle; retention/legal governance owns evidence destruction.
 */

import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";

/** SSO/SCIM string-status marker written by suspend, reverted by resume. */
export const ORG_SUSPENSION_STATUS = "SUSPENDED";

export type OrgLifecycleError = Error & { statusCode: number; code: string };

function lifecycleError(
  statusCode: number,
  code: string,
  message: string,
): OrgLifecycleError {
  const err = new Error(message) as OrgLifecycleError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

async function loadCustomerOrg(
  tx: Pick<typeof prisma, "organization">,
  organizationId: string,
) {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, kind: true, status: true },
  });
  if (!org) {
    throw lifecycleError(404, "ORG_NOT_FOUND", "Organization not found");
  }
  if (org.kind !== "CUSTOMER") {
    throw lifecycleError(
      409,
      "NOT_CUSTOMER_ORGANIZATION",
      "Lifecycle suspension applies only to customer organizations",
    );
  }
  return org;
}

export async function suspendOrganization(input: {
  organizationId: string;
  actorUserId: string;
  reason?: string | null;
}): Promise<{
  organizationId: string;
  sessionsRevokedForUsers: number;
  ssoConnectionsSuspended: number;
  scimTokensSuspended: number;
  invitesExpired: number;
  apiCredentialsSuspended: number;
}> {
  const { organizationId, actorUserId } = input;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const org = await loadCustomerOrg(tx, organizationId);
    if (org.status === "ARCHIVED") {
      throw lifecycleError(
        409,
        "ORG_ARCHIVED_PERMANENT",
        "An archived organization cannot be suspended",
      );
    }
    if (org.status === "SUSPENDED") {
      throw lifecycleError(
        409,
        "ORG_ALREADY_SUSPENDED",
        "Organization is already suspended",
      );
    }

    // 1. Master halt — authorize/checkOrgAccess/switcher all key off this.
    await tx.organization.update({
      where: { id: organizationId },
      data: { status: "SUSPENDED" },
    });

    const orgTeams = await tx.team.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const teamIds = orgTeams.map((t) => t.id);

    // Distinct ACTIVE workspace members — their sessions die after commit.
    const memberRows = teamIds.length
      ? await tx.teamMember.findMany({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
          select: { userId: true },
          distinct: ["userId"],
        })
      : [];

    let ssoConnectionsSuspended = 0;
    let scimTokensSuspended = 0;
    let apiCredentialsSuspended = 0;
    let pausedCredentialIds: string[] = [];
    if (teamIds.length > 0) {
      // 3. SSO halted, reversibly (only ACTIVE connections initiate logins).
      ssoConnectionsSuspended = (
        await tx.ssoConnection.updateMany({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
          data: { status: ORG_SUSPENSION_STATUS },
        })
      ).count;

      // 4. SCIM halted, reversibly (middleware requires status ACTIVE).
      scimTokensSuspended = (
        await tx.scimProvisioningToken.updateMany({
          where: { teamId: { in: teamIds }, status: "ACTIVE" },
          data: { status: ORG_SUSPENSION_STATUS },
        })
      ).count;

      // 6. API credentials — soft-paused (disabledAtUtc), never REVOKED
      // (revocation is permanent by contract). Ids are captured so the
      // resume leg re-enables exactly this set.
      const pausableCredentials = await tx.apiCredential.findMany({
        where: {
          teamId: { in: teamIds },
          status: "ACTIVE",
          disabledAtUtc: null,
        },
        select: { id: true },
      });
      pausedCredentialIds = pausableCredentials.map((c) => c.id);
      if (pausedCredentialIds.length > 0) {
        await tx.apiCredential.updateMany({
          where: { id: { in: pausedCredentialIds } },
          data: { disabledAtUtc: now, disabledByUserId: actorUserId },
        });
      }
      apiCredentialsSuspended = pausedCredentialIds.length;

      // 7. Switcher pointers cleared — personal-workspace fallback.
      await tx.user.updateMany({
        where: { currentWorkspaceId: { in: teamIds } },
        data: { currentWorkspaceId: null },
      });
    }

    // 5. Open invites expire NOW (not restored on resume).
    const invitesExpired = (
      await tx.organizationInvite.updateMany({
        where: {
          organizationId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { expiresAt: now },
      })
    ).count;

    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId,
      eventType: "ORG_SUSPENDED",
      targetType: "organization",
      targetId: organizationId,
      metadata: {
        reason: input.reason ?? null,
        ssoConnectionsSuspended,
        scimTokensSuspended,
        invitesExpired,
        apiCredentialsSuspended,
        // Resume contract: exactly these credentials get re-enabled.
        pausedApiCredentialIds: pausedCredentialIds,
      },
    });

    return {
      memberUserIds: memberRows.map((m) => m.userId),
      ssoConnectionsSuspended,
      scimTokensSuspended,
      invitesExpired,
      apiCredentialsSuspended,
    };
  });

  // 2. Sessions AFTER the status commit — even a partial failure here
  // leaves the org dark (authorize denies non-ACTIVE org context), and
  // the loop is per-user isolated.
  let sessionsRevokedForUsers = 0;
  for (const userId of result.memberUserIds) {
    try {
      await revokeAllSessionsForUser({ userId, reason: "ORG_SUSPENDED" });
      sessionsRevokedForUsers += 1;
    } catch {
      // isolated — the org is already dark; a failed revocation only
      // shortens the victim's UX path to the denial screen.
    }
  }

  await emitTenantAudit({
    action: "identity.organization_suspended",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: {
      sessionsRevokedForUsers,
      ssoConnectionsSuspended: result.ssoConnectionsSuspended,
      scimTokensSuspended: result.scimTokensSuspended,
      invitesExpired: result.invitesExpired,
      apiCredentialsSuspended: result.apiCredentialsSuspended,
    },
  }).catch(() => null);

  return {
    organizationId,
    sessionsRevokedForUsers,
    ssoConnectionsSuspended: result.ssoConnectionsSuspended,
    scimTokensSuspended: result.scimTokensSuspended,
    invitesExpired: result.invitesExpired,
    apiCredentialsSuspended: result.apiCredentialsSuspended,
  };
}

export async function resumeOrganization(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<{
  organizationId: string;
  ssoConnectionsRestored: number;
  scimTokensRestored: number;
  apiCredentialsRestored: number;
}> {
  const { organizationId, actorUserId } = input;

  const result = await prisma.$transaction(async (tx) => {
    const org = await loadCustomerOrg(tx, organizationId);
    if (org.status !== "SUSPENDED") {
      // ARCHIVED is permanent; ACTIVE has nothing to resume.
      throw lifecycleError(
        409,
        "ORG_NOT_SUSPENDED",
        "Only a suspended organization can be resumed",
      );
    }

    await tx.organization.update({
      where: { id: organizationId },
      data: { status: "ACTIVE" },
    });

    const orgTeams = await tx.team.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const teamIds = orgTeams.map((t) => t.id);

    let ssoConnectionsRestored = 0;
    let scimTokensRestored = 0;
    let apiCredentialsRestored = 0;
    if (teamIds.length > 0) {
      // Restore EXACTLY what suspension wrote — marker-matched flips.
      ssoConnectionsRestored = (
        await tx.ssoConnection.updateMany({
          where: { teamId: { in: teamIds }, status: ORG_SUSPENSION_STATUS },
          data: { status: "ACTIVE" },
        })
      ).count;
      scimTokensRestored = (
        await tx.scimProvisioningToken.updateMany({
          where: { teamId: { in: teamIds }, status: ORG_SUSPENSION_STATUS },
          data: { status: "ACTIVE" },
        })
      ).count;
      // Re-enable EXACTLY the credentials the suspension paused — the id
      // list travels in the ORG_SUSPENDED audit event. Individually
      // disabled credentials are never re-armed by an org resume.
      const suspendEvent = await tx.organizationAuditEvent.findFirst({
        where: { organizationId, eventType: "ORG_SUSPENDED" },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      });
      const pausedIds = Array.isArray(
        (suspendEvent?.metadata as { pausedApiCredentialIds?: unknown } | null)
          ?.pausedApiCredentialIds,
      )
        ? ((suspendEvent!.metadata as { pausedApiCredentialIds: string[] })
            .pausedApiCredentialIds)
        : [];
      if (pausedIds.length > 0) {
        apiCredentialsRestored = (
          await tx.apiCredential.updateMany({
            where: {
              id: { in: pausedIds },
              teamId: { in: teamIds },
              status: "ACTIVE",
              disabledAtUtc: { not: null },
            },
            data: { disabledAtUtc: null, disabledByUserId: null },
          })
        ).count;
      }
    }

    // NOT restored: sessions (users re-authenticate), invites (re-issue),
    // memberships (never touched by org suspension in the first place).

    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId,
      eventType: "ORG_RESUMED",
      targetType: "organization",
      targetId: organizationId,
      metadata: {
        ssoConnectionsRestored,
        scimTokensRestored,
        apiCredentialsRestored,
      },
    });

    return { ssoConnectionsRestored, scimTokensRestored, apiCredentialsRestored };
  });

  await emitTenantAudit({
    action: "identity.organization_resumed",
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    metadata: { ...result },
  }).catch(() => null);

  return { organizationId, ...result };
}
