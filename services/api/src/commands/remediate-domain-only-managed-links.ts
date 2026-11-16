/**
 * B5B-F-302 — REMEDIATE ACCOUNTS ALREADY CONVERTED BY DOMAIN-ONLY LINKING.
 *
 * Before B5B-F-302, SCIM create, OIDC JIT and SAML JIT linked an email to a
 * PRE-EXISTING self-serve account on the Organization's verified domain alone,
 * and managed provisioning then converted it to MANAGED_ENTERPRISE: its owner
 * lost their Personal Space, personal capture and personal export, and the
 * Organization's IdP could sign in as the account.
 *
 * WHO IS AFFECTED — reliable provenance only, never a guess:
 *   - the account is MANAGED_ENTERPRISE, bound to Organization O through a
 *     directory or IdP source (managedIdentitySource SCIM / SAML / OIDC);
 *   - O's own directory or IdP did NOT create it
 *     (`resolveAccountOriginForOrganization` — the synthetic provider id each
 *     creation site writes with the account row);
 *   - O holds an identity mapping for it, and the account PRE-DATES O's first
 *     mapping (it existed before O linked it).
 * Reported alongside, as corroboration: a password, a Personal Space, the
 * provider-id kind. An account O created is never listed. A DOMAIN-source
 * binding (an invitation the owner accepted while signed in) is not a
 * domain-only link and is not listed.
 *
 * WHAT APPLY DOES — through the existing identity lifecycle, per account, in
 * one transaction:
 *   1. `releaseManagedIdentity` for O (STANDARD again: Personal Space, personal
 *      capture and export return);
 *   2. O's identity mappings for the account are soft-unlinked (unlinkedAtUtc),
 *      so O's IdP no longer signs in as it; the owner may re-link through the
 *      organization-link consent flow, signed in, which never converts;
 *   3. memberships are KEPT as they are: the person stays an ordinary member.
 * Then every session of the account is revoked (sessions O's IdP minted as it
 * end), and an audit record is written.
 *
 * Default is a DRY RUN that writes nothing. Idempotent: a remediated account
 * is STANDARD and is not listed again.
 *
 *   pnpm --filter proovra-api tsx scripts/remediate-domain-only-managed-links.ts
 *   pnpm --filter proovra-api tsx scripts/remediate-domain-only-managed-links.ts --apply
 */

import type { PrismaClient } from "@prisma/client";

import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { releaseManagedIdentity } from "../services/identity/identity-mode.service.js";
import { revokeAllSessionsForUser } from "../services/identity-security/session-revocation.service.js";
import { resolveAccountOriginForOrganization } from "../services/security/enterprise-account-linking.service.js";

const DIRECTORY_OR_IDP_SOURCES = ["SCIM", "SAML", "OIDC"] as const;
const PAGE = 500;

export type DomainOnlyManagedLink = {
  userId: string;
  organizationId: string;
  managedIdentitySource: string;
  userCreatedAtUtc: string;
  firstOrganizationLinkAtUtc: string;
  liveOrganizationMappings: number;
  hasPassword: boolean;
  hasPersonalWorkspace: boolean;
  providerIdKind: "EMAIL_ADDRESS" | "SOCIAL" | "OTHER_ORGANIZATION_DIRECTORY" | "OTHER";
};

export type DomainOnlyRemediationReport = {
  dryRun: boolean;
  scanned: number;
  affected: DomainOnlyManagedLink[];
  remediated: number;
  /** Listed but changed concurrently (no longer managed by that Organization). */
  skipped: number;
};

function providerIdKind(user: {
  provider: string;
  providerUserId: string;
  email: string | null;
}): DomainOnlyManagedLink["providerIdKind"] {
  if (user.email && user.providerUserId.toLowerCase() === user.email.trim().toLowerCase()) {
    return "EMAIL_ADDRESS";
  }
  if (user.provider === "GOOGLE" || user.provider === "APPLE") return "SOCIAL";
  if (/^(scim|sso|saml)-/.test(user.providerUserId)) return "OTHER_ORGANIZATION_DIRECTORY";
  return "OTHER";
}

/** READ-ONLY: every account a domain-only link converted. Writes nothing. */
export async function findDomainOnlyManagedLinks(
  client: PrismaClient,
): Promise<{ scanned: number; affected: DomainOnlyManagedLink[] }> {
  const affected: DomainOnlyManagedLink[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{
      id: string;
      email: string | null;
      provider: string;
      providerUserId: string;
      passwordHash: string | null;
      createdAt: Date;
      managingOrganizationId: string | null;
      managedIdentitySource: string | null;
    }> = (await client.user.findMany({
      where: {
        identityMode: "MANAGED_ENTERPRISE",
        managingOrganizationId: { not: null },
        managedIdentitySource: { in: [...DIRECTORY_OR_IDP_SOURCES] },
      } as never,
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        email: true,
        provider: true,
        providerUserId: true,
        passwordHash: true,
        createdAt: true,
        managingOrganizationId: true,
        managedIdentitySource: true,
      } as never,
    })) as never;
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    for (const user of page) {
      scanned += 1;
      const organizationId = user.managingOrganizationId!;
      const origin = await resolveAccountOriginForOrganization(
        { userId: user.id, organizationId },
        client,
      );
      if (origin?.kind !== "SELF_SERVE") continue; // the Organization created it
      const first = await client.externalIdentityMapping.findFirst({
        where: { organizationId, userId: user.id },
        orderBy: { linkedAtUtc: "asc" },
        select: { linkedAtUtc: true },
      });
      // No mapping = no evidence of how it was bound: never guessed.
      if (!first || user.createdAt.getTime() > first.linkedAtUtc.getTime()) continue;
      const [liveOrganizationMappings, personal] = await Promise.all([
        client.externalIdentityMapping.count({
          where: { organizationId, userId: user.id, unlinkedAtUtc: null },
        }),
        client.team.findFirst({
          where: { ownerUserId: user.id, isPersonal: true },
          select: { id: true },
        }),
      ]);
      affected.push({
        userId: user.id,
        organizationId,
        managedIdentitySource: user.managedIdentitySource ?? "UNKNOWN",
        userCreatedAtUtc: user.createdAt.toISOString(),
        firstOrganizationLinkAtUtc: first.linkedAtUtc.toISOString(),
        liveOrganizationMappings,
        hasPassword: Boolean(user.passwordHash),
        hasPersonalWorkspace: Boolean(personal),
        providerIdKind: providerIdKind(user),
      });
    }
    if (page.length < PAGE) break;
  }
  return { scanned, affected };
}

/**
 * List (dry run, the default) or remediate (`apply: true`) every account a
 * domain-only link converted. Never touches an Organization-created account,
 * Organization data, or the account's Personal Space.
 */
export async function remediateDomainOnlyManagedLinks(
  client: PrismaClient,
  options: { apply?: boolean } = {},
): Promise<DomainOnlyRemediationReport> {
  const { scanned, affected } = await findDomainOnlyManagedLinks(client);
  const report: DomainOnlyRemediationReport = {
    dryRun: options.apply !== true,
    scanned,
    affected,
    remediated: 0,
    skipped: 0,
  };
  if (options.apply !== true) return report;

  for (const row of affected) {
    const released = await client.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaClient;
      const done = await releaseManagedIdentity(
        { userId: row.userId, managingOrganizationId: row.organizationId },
        txc,
      );
      if (!done) return false;
      await txc.externalIdentityMapping.updateMany({
        where: { organizationId: row.organizationId, userId: row.userId, unlinkedAtUtc: null },
        data: { unlinkedAtUtc: new Date() },
      });
      return true;
    });
    if (!released) {
      report.skipped += 1;
      continue;
    }
    report.remediated += 1;
    await revokeAllSessionsForUser(
      { userId: row.userId, reason: "RECONCILIATION_SWEEP" },
      client,
    ).catch(() => null);
    await emitPlatformAudit({
      action: "identity.domain_only_link_remediated",
      outcome: "success",
      sourceApp: "API",
      actorUserId: null,
      serviceActor: "b5b_f_302_remediation",
      resourceType: "user",
      resourceId: row.userId,
      metadata: {
        finding: "B5B-F-302",
        organizationId: row.organizationId,
        managedIdentitySource: row.managedIdentitySource,
        unlinkedMappings: row.liveOrganizationMappings,
      },
    }, client).catch(() => null);
  }
  return report;
}

/** Operator-safe summary: ids, sources and counts only (no email, no names). */
export function formatDomainOnlyRemediationReport(report: DomainOnlyRemediationReport): string[] {
  return [
    `B5B-F-302 DOMAIN-ONLY MANAGED LINK REMEDIATION (${report.dryRun ? "DRY RUN — nothing changed" : "APPLIED"})`,
    `  scanned managed directory/IdP identities=${report.scanned}`,
    `  affected=${report.affected.length}`,
    ...report.affected.map(
      (a) =>
        `    user=${a.userId} org=${a.organizationId} source=${a.managedIdentitySource} ` +
        `created=${a.userCreatedAtUtc} firstLink=${a.firstOrganizationLinkAtUtc} ` +
        `liveMappings=${a.liveOrganizationMappings} password=${a.hasPassword} ` +
        `personalSpace=${a.hasPersonalWorkspace} providerId=${a.providerIdKind}`,
    ),
    `  remediated=${report.remediated}`,
    `  skipped=${report.skipped}`,
  ];
}
