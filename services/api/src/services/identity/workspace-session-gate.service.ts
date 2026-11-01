/**
 * MAY THIS SESSION ACT IN THIS WORKSPACE (AUTHZ-001, IDENT-001, MOBILE-001).
 *
 * The composition `requireAuth` used to run only against the workspace recorded
 * on the session row at login. It answers for ANY workspace, so the authorities
 * that resolve a workspace can ask it about the one actually being operated on:
 * a password session may keep working in its Personal space and still be refused
 * inside an Organization that requires SSO.
 *
 * Reads live policy on every request. Performs no mutation. A read failure
 * rejects, and every caller turns that into a refusal, never an allow. This is
 * not a membership gate: membership is `evaluateMemberAccess`, which calls this
 * for a member it has already found, as `listAccessibleWorkspaces` does.
 *
 * The session policy rules themselves stay in `org-security-policy.service.ts`,
 * the SECURITY policy engine and `mfa-policy.service.ts`; nothing is restated.
 */
import type { PrismaClient } from "@prisma/client";
import { mfaRequiredForRole } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  currentRequestSession,
  onceForWorkspace,
  type RequestSessionFacts,
  type WorkspaceGateDecision,
} from "../auth/request-session-context.js";
import { isDomainError } from "../../errors.js";
import { gateSecurityAction } from "../governance/policy-runtime-gates.service.js";
import { enforceSessionTimeoutPolicy } from "../identity-security/session-timeout-policy.service.js";
import { getMfaPolicy } from "../identity-security/mfa-policy.service.js";
import { evaluateOrgContextForSession } from "./org-security-policy.service.js";

export async function evaluateSessionInWorkspace(
  session: RequestSessionFacts,
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceGateDecision> {
  const verdict = await gateSecurityAction({
    prisma: client,
    teamId,
    userId: session.userId,
    action: "session_authenticate",
    mfaSatisfied: session.mfaAtSec !== null,
    samlAuthenticated: session.policyMethod === "SSO",
  });
  if (!verdict.ok) return { allowed: false, reason: verdict.reason ?? "security_policy" };

  const orgGate = await evaluateOrgContextForSession(
    {
      userId: session.userId,
      teamId,
      method: session.policyMethod,
      ssoConnId: session.ssoConnId,
      authAtMs: session.authAtMs,
      lastSeenAtMs: session.lastSeenAtMs,
    },
    client,
  );
  if (!orgGate.allowed) return { allowed: false, reason: orgGate.reason };

  const timeout = await enforceSessionTimeoutPolicy(
    {
      userId: session.userId,
      teamId,
      iat: session.issuedAtSec,
      lastSeenAtMs: session.lastSeenAtMs,
    },
    client,
  );
  if (timeout.action === "expire") return { allowed: false, reason: "session_expired" };

  // IDENT-007 — the MFA policy governs a live session as well as a login: a
  // session with no verified second factor does not enter a workspace whose
  // policy requires one for this person's role.
  if (session.mfaAtSec === null) {
    const member = await client.teamMember.findFirst({
      where: { teamId, userId: session.userId, status: "ACTIVE" },
      select: { role: true },
    });
    if (member) {
      const policy = await getMfaPolicy(teamId, client);
      if (mfaRequiredForRole(policy.level, member.role)) {
        return { allowed: false, reason: "mfa_required" };
      }
    }
  }
  return { allowed: true };
}

/**
 * The gate for the request in progress. Allowed when there is no session to
 * judge (worker, sweep, API key, public token) or when the access being decided
 * is someone else's: this judges the caller's own session, never a third party
 * the caller happens to be asking about.
 */
export function gateRequestSessionForWorkspace(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceGateDecision> {
  const session = currentRequestSession();
  if (!session || session.userId !== input.userId) return Promise.resolve({ allowed: true });
  return onceForWorkspace(input.teamId, async () => {
    try {
      return await evaluateSessionInWorkspace(session, input.teamId, client);
    } catch (err) {
      // A customer Organization with no provisioned policy has no rule this
      // session could satisfy. Refused, as the workspace switch refuses it.
      if (isDomainError(err) && err.publicCode === "POLICY_NOT_PROVISIONED") {
        return { allowed: false, reason: "organization_security_policy_unavailable" };
      }
      throw err;
    }
  });
}
