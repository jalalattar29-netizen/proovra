/**
 * WHAT FOLLOWS A VERIFIED SSO SIGN-IN, WHICHEVER WAY IT FINISHES (IDENT-011).
 *
 * A sign-in with no second factor finishes in the SAML or OIDC route. One with a
 * second factor finishes later, in the MFA routes. The stricter organizations are
 * the ones that require MFA, and they were the ones that lost managed binding,
 * seat enforcement and the session limit, because this work lived only on the
 * first branch. Every path that completes an SSO session runs this, once, against
 * the session row just written and before any credential reaches the browser.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { detectAndScoreSession } from "../access-control/suspicious-session.service.js";
import { withSeatClaimRetry } from "../billing/workspace-seats.service.js";
import { hashSessionId } from "../identity-security/session-revocation.service.js";
import { establishOrganizationSessionContext } from "./concurrent-session.service.js";
import { provisionManagedMembership } from "./membership-provisioning.service.js";
import { organizationIdForPolicy, resolveOrganizationPolicy } from "./org-security-policy.service.js";

export type SsoSessionCompletion = { allowed: true } | { allowed: false; reason: string };

export async function completeSsoSession(
  input: {
    userId: string;
    /** The workspace of the connection the sign-in came through. */
    teamId: string;
    ssoConnectionId: string;
    source: "SAML" | "OIDC";
    sessionId: string;
    sid: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<SsoSessionCompletion> {
  const dropSession = () =>
    client.authenticatedSession.delete({ where: { id: input.sessionId } }).catch(() => null);

  await detectAndScoreSession({ teamId: input.teamId, sessionId: input.sessionId }, client).catch(
    () => null,
  );

  const organizationId = await organizationIdForPolicy(input.teamId, client);
  if (!organizationId) return { allowed: true };

  // Managed provisioning: bound, seated and a member before any Organization
  // context or cookie. A cross-Organization conflict is never silently re-claimed.
  const policy = await resolveOrganizationPolicy(input.teamId, client);
  if (policy.applicability === "ORGANIZATION" && policy.policy.managedIdentityRequired) {
    try {
      await withSeatClaimRetry(() => client.$transaction((tx) =>
        provisionManagedMembership(tx, {
          userId: input.userId,
          managingTeamId: input.teamId,
          evidence: { source: input.source, ssoConnectionId: input.ssoConnectionId },
          membershipIntent: "SSO_JIT",
          source: "SSO_JIT",
          workspace: { teamId: input.teamId, role: "MEMBER" },
          actorUserId: null, // IdP-driven
          externalRef: `${input.source.toLowerCase()}:${input.ssoConnectionId}`,
          accessReason: `${input.source} managed provisioning`,
          preserveExistingStatus: true, // a login never silently reactivates
          seatPolicy: "ENFORCE",
          seatTeamId: input.teamId,
        }),
      ));
    } catch (err) {
      await dropSession();
      const code = (err as { code?: string })?.code;
      return {
        allowed: false,
        reason:
          code === "MANAGED_SEAT_LIMIT_REACHED"
            ? "seat_limit_reached"
            : code === "WORKSPACE_SEAT_CONTENTION"
              ? "seat_contention"
              : "managed_identity_conflict",
      };
    }
  }

  // The sid is random per login, so the row deleted on a refusal is never an
  // idempotent retry, and no client holds this token yet.
  let seat;
  try {
    seat = await establishOrganizationSessionContext(
      {
        userId: input.userId,
        organizationId,
        sessionIdHash: hashSessionId(input.sid),
      },
      client,
    );
  } catch (err) {
    await dropSession();
    throw err;
  }
  if (!seat.allowed) {
    await dropSession();
    return { allowed: false, reason: seat.reason };
  }
  return { allowed: true };
}
