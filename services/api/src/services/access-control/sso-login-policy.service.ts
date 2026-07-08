/**
 * Phase 3 — Enterprise Identity: SSO login enforcement point.
 *
 * A single, shared policy gate that BOTH the SAML ACS handler and the OIDC
 * callback handler run before minting a session. It guarantees the invariants
 * the enterprise-identity architecture requires:
 *
 *   1. SSO is usable ONLY by enterprise organizations. The connection's owning
 *      workspace must grant the `ssoScim` Enterprise feature.
 *
 *   2. SSO JIT lands the user in an ORGANIZATION workspace, NEVER a PERSONAL
 *      one. Every Team is bound to an Organization (Team.organizationId is NOT
 *      NULL), but a connection attached to an `isPersonal` workspace would drop
 *      the user into a personal boundary. We reject that outright — SSO belongs
 *      to the org identity boundary.
 *
 *   3. When the connection is configured with `restrictToVerifiedDomains`, the
 *      login email's domain MUST be a VERIFIED OrganizationDomain for the
 *      connection's org. This is layered ON TOP of the existing (unverified)
 *      allowedEmailDomains behaviour — it does not replace it.
 *
 * The gate is failure-closed and never throws for policy denials; it returns a
 * structured result the route maps to a sanitised bounce reason. It DOES read
 * connection + team + org rows, but performs no mutation.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveTeamEnterpriseFeatureGate } from "../enterprise-gate-resolvers.service.js";
import { isEmailDomainVerifiedForOrg } from "../organization/organization-domain.service.js";

export type SsoLoginPolicyDenyReason =
  | "sso_not_enterprise"
  | "sso_workspace_personal"
  | "sso_domain_not_verified";

export type SsoLoginPolicyResult =
  | { ok: true; organizationId: string; teamId: string }
  | { ok: false; reason: SsoLoginPolicyDenyReason };

/**
 * Pre-mint gate. Call AFTER the connection is loaded and the login email is
 * resolved, BEFORE minting a session or (for JIT) creating any membership.
 *
 * @param teamId  the SSO connection's owning workspace id.
 * @param email   the resolved login email (used for verified-domain checks).
 * @param restrictToVerifiedDomains  the connection flag.
 */
export async function enforceSsoLoginPolicy(
  input: {
    teamId: string;
    email: string;
    restrictToVerifiedDomains: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<SsoLoginPolicyResult> {
  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { id: true, isPersonal: true, organizationId: true },
  });

  // A connection whose team vanished, or that lives on a PERSONAL workspace,
  // must never mint an SSO session. SSO is an organization identity boundary.
  if (!team || team.isPersonal) {
    return { ok: false, reason: "sso_workspace_personal" };
  }

  // (1) Enterprise-only.
  const gate = await resolveTeamEnterpriseFeatureGate(team.id, "ssoScim");
  if (!gate.ok) {
    return { ok: false, reason: "sso_not_enterprise" };
  }

  // (3) Verified-domain restriction, layered on top of allowedEmailDomains.
  if (input.restrictToVerifiedDomains) {
    const verified = await isEmailDomainVerifiedForOrg(
      { organizationId: team.organizationId, email: input.email },
      client,
    );
    if (!verified) {
      return { ok: false, reason: "sso_domain_not_verified" };
    }
  }

  return { ok: true, organizationId: team.organizationId, teamId: team.id };
}
