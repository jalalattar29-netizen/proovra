/**
 * P0 REMEDIATION (2026-07-21) — Enterprise account-linking safety.
 *
 * THE canonical guard for the highest-severity enterprise-identity risk
 * (CT1): an enterprise IdP (SAML / OIDC / SCIM) asserting an email that
 * already belongs to an EXISTING global User must NEVER be silently linked
 * to (and a session minted for) that account unless the linkage is
 * administratively safe. Without this guard, any customer who self-
 * configures a JIT-enabled SSO connection on their own enterprise
 * workspace can assert `victim@othercompany.com` and take over the
 * victim's account platform-wide.
 *
 * Canonical rule (fail-closed):
 *
 *   Linking an IdP-asserted email to a PRE-EXISTING User is allowed ONLY
 *   when the email's domain is
 *     (a) DNS-verified by the ORGANIZATION that owns the SSO/SCIM
 *         connection's workspace, AND
 *     (b) verified by NO OTHER organization (a globally-unique claim —
 *         two tenants both "owning" a domain is an unresolved conflict
 *         and must fail closed until an operator resolves it).
 *
 *   Creating a BRAND-NEW User via JIT is not gated here (no takeover
 *   surface — the new row has no prior credentials or data); it remains
 *   governed by the connection's JIT policy + domain gates.
 *
 * Every decision (allow and deny) is observable: callers emit the
 * security event; this service returns a bounded reason code and never
 * throws for policy denials.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  domainFromEmail,
  normalizeDomain,
} from "../organization/organization-domain.service.js";

export type ExistingAccountLinkDenialReason =
  | "email_invalid"
  | "workspace_not_found"
  | "domain_not_verified_for_org"
  | "domain_claim_conflict";

export type ExistingAccountLinkDecision =
  | { ok: true; organizationId: string; domain: string }
  | { ok: false; reason: ExistingAccountLinkDenialReason };

/**
 * Decide whether an enterprise identity flow on `teamId`'s connection may
 * link the asserted `email` to a pre-existing User account.
 *
 * Pure policy over injected client state — unit-testable with a fake
 * Prisma client. Fail-closed on every unresolvable input.
 */
export async function evaluateExistingAccountLink(
  input: { teamId: string; email: string },
  client: PrismaClient = defaultPrisma,
): Promise<ExistingAccountLinkDecision> {
  const rawDomain = domainFromEmail(input.email);
  const domain = rawDomain ? normalizeDomain(rawDomain) : null;
  if (!domain) return { ok: false, reason: "email_invalid" };

  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });
  if (!team?.organizationId) {
    return { ok: false, reason: "workspace_not_found" };
  }

  // Every organization holding a VERIFIED claim on this domain. One query
  // answers both questions: does OUR org hold it, and does anyone else.
  const claims = await client.organizationDomain.findMany({
    where: { domain, verifiedAt: { not: null } },
    select: { organizationId: true },
  });

  const ours = claims.some((c) => c.organizationId === team.organizationId);
  if (!ours) return { ok: false, reason: "domain_not_verified_for_org" };

  const foreign = claims.some(
    (c) => c.organizationId !== team.organizationId,
  );
  if (foreign) return { ok: false, reason: "domain_claim_conflict" };

  return { ok: true, organizationId: team.organizationId, domain };
}
