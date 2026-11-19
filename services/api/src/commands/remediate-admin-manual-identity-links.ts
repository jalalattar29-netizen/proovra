/**
 * PRO-A2-02 (WS-ORG RG-06) — LEGACY ORGANIZATION IDENTITY LINKS ON
 * SELF-SERVE ACCOUNTS, CLASSIFIED BY EVIDENCE.
 *
 * Before `external_identity_mappings.link_source` existed, an Organization
 * identity administrator could bind an IdP subject to a pre-existing
 * self-serve member through POST /v1/identity/external-mappings and then sign
 * in AS that account. New links carry their provenance and the manual route
 * refuses self-serve accounts; sign-in, IdP step-up and the directory honour a
 * legacy (NULL-source) link on a self-serve account only with owner-consent
 * evidence BOUND TO THAT LINK'S PROVIDER AND SUBJECT (the canonical rule,
 * evaluateExternalLinkAuthority). This command inventories the remaining
 * legacy and ADMIN_MANUAL links on self-serve accounts, in this order:
 *
 *   ADMIN_MANUAL_EVIDENCE   link_source ADMIN_MANUAL, or a tenant audit row
 *                           `identity.external_mapping.link` names the mapping.
 *                           The audit row identifies an administrator-made
 *                           link exactly, so it WINS over any consent grant.
 *                           → apply soft-unlinks it and revokes the account's
 *                             sessions (sessions the IdP may have minted as it)
 *   OWNER_CONSENT_EVIDENCE  a live membership grant
 *                           `org-link:<provider>:<connection>:sub-<digest>`
 *                           naming THIS link's subject exists for the person
 *                           → apply records link_source = OWNER_CONSENT
 *   UNBOUND_CONSENT_GRANT   only a pre-rule grant `org-link:<provider>:<connection>`
 *                           exists. It names no subject, so it cannot tell the
 *                           subject the owner approved from one an administrator
 *                           linked afterwards: it is NEVER recorded as consent.
 *                           Reported only; never changed.
 *   NO_EVIDENCE             reported only; never changed.
 *
 * An UNBOUND_CONSENT_GRANT or NO_EVIDENCE link no longer signs anyone in: the
 * sign-in answers the owner-consent path and the owner approves it again.
 *
 * Never a guess: provenance is the account-origin authority; an account the
 * Organization created is never listed. DRY RUN BY DEFAULT; idempotent.
 * Run it only after migration 20281121010000_external_identity_link_source is
 * applied (it reads and writes link_source).
 */
import type { PrismaClient } from "@prisma/client";

import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { revokeAllSessionsForUser } from "../services/identity-security/session-revocation.service.js";
import {
  OWNER_CONSENT_LINK_SOURCE,
  findOwnerConsentEvidence,
  isSelfServeAccountForOrganization,
} from "../services/security/enterprise-account-linking.service.js";

const PAGE = 500;

export type LegacyLinkEvidence =
  | "OWNER_CONSENT_EVIDENCE"
  | "ADMIN_MANUAL_EVIDENCE"
  | "UNBOUND_CONSENT_GRANT"
  | "NO_EVIDENCE";

export type LegacyIdentityLink = {
  mappingId: string;
  userId: string;
  organizationId: string;
  provider: string;
  linkSource: string | null;
  evidence: LegacyLinkEvidence;
};

export type LegacyIdentityLinkReport = {
  dryRun: boolean;
  scanned: number;
  affected: LegacyIdentityLink[];
  consentRecorded: number;
  unlinked: number;
  skipped: number;
};

type LinkRow = {
  id: string;
  userId: string;
  organizationId: string;
  provider: string;
  externalSubjectId: string;
  linkSource: string | null;
};

async function classify(client: PrismaClient, row: LinkRow): Promise<LegacyLinkEvidence> {
  if (row.linkSource === "ADMIN_MANUAL") return "ADMIN_MANUAL_EVIDENCE";
  // The manual route's tenant audit row lands in the hash-chained platform
  // audit log (emitTenantAudit -> appendPlatformAuditLog). It names the
  // mapping, so it is asked FIRST: an administrator-made link is never
  // recorded as the owner's consent, whatever grants the person holds.
  const audited = await client.adminAuditLog.findFirst({
    where: { action: "identity.external_mapping.link", resourceId: row.id },
    select: { id: true },
  });
  if (audited) return "ADMIN_MANUAL_EVIDENCE";
  // The same subject-bound evidence the sign-in rule reads.
  const consent = await findOwnerConsentEvidence(
    {
      userId: row.userId,
      organizationId: row.organizationId,
      provider: row.provider,
      externalSubjectId: row.externalSubjectId,
    },
    client,
  );
  if (consent.bound) return "OWNER_CONSENT_EVIDENCE";
  return consent.unbound ? "UNBOUND_CONSENT_GRANT" : "NO_EVIDENCE";
}

/** READ-ONLY: every live legacy / admin-made link on a self-serve account. */
export async function findLegacyIdentityLinks(
  client: PrismaClient,
): Promise<{ scanned: number; affected: LegacyIdentityLink[] }> {
  const affected: LegacyIdentityLink[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: LinkRow[] =
      (await client.externalIdentityMapping.findMany({
        where: {
          unlinkedAtUtc: null,
          OR: [{ linkSource: null }, { linkSource: "ADMIN_MANUAL" }],
        },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, userId: true, organizationId: true, provider: true, externalSubjectId: true, linkSource: true },
      })) as never;
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    for (const row of page) {
      scanned += 1;
      if (!(await isSelfServeAccountForOrganization({ userId: row.userId, organizationId: row.organizationId }, client))) {
        continue; // the Organization created the account: the link is its own
      }
      affected.push({
        mappingId: row.id,
        userId: row.userId,
        organizationId: row.organizationId,
        provider: String(row.provider),
        linkSource: row.linkSource,
        evidence: await classify(client, { ...row, provider: String(row.provider) }),
      });
    }
    if (page.length < PAGE) break;
  }
  return { scanned, affected };
}

export async function remediateAdminManualIdentityLinks(
  client: PrismaClient,
  options: { apply?: boolean } = {},
): Promise<LegacyIdentityLinkReport> {
  const { scanned, affected } = await findLegacyIdentityLinks(client);
  const report: LegacyIdentityLinkReport = {
    dryRun: options.apply !== true,
    scanned,
    affected,
    consentRecorded: 0,
    unlinked: 0,
    skipped: 0,
  };
  if (options.apply !== true) return report;
  for (const row of affected) {
    if (row.evidence === "OWNER_CONSENT_EVIDENCE") {
      const r = await client.externalIdentityMapping.updateMany({
        where: { id: row.mappingId, unlinkedAtUtc: null, linkSource: null },
        data: { linkSource: OWNER_CONSENT_LINK_SOURCE },
      });
      if (r.count === 1) report.consentRecorded += 1;
      else report.skipped += 1;
      continue;
    }
    if (row.evidence === "ADMIN_MANUAL_EVIDENCE") {
      const r = await client.externalIdentityMapping.updateMany({
        where: { id: row.mappingId, unlinkedAtUtc: null },
        data: { unlinkedAtUtc: new Date() },
      });
      if (r.count !== 1) {
        report.skipped += 1;
        continue;
      }
      report.unlinked += 1;
      await revokeAllSessionsForUser({ userId: row.userId, reason: "RECONCILIATION_SWEEP" }, client).catch(() => null);
      await emitPlatformAudit({
        action: "identity.admin_manual_link_remediated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: null,
        serviceActor: "pro_a2_02_remediation",
        resourceType: "external_identity_mapping",
        resourceId: row.mappingId,
        metadata: { finding: "PRO-A2-02", organizationId: row.organizationId, subjectUserId: row.userId },
      }, client).catch(() => null);
      continue;
    }
    report.skipped += 1;
  }
  return report;
}

/** Operator-safe summary: ids, classes and counts only. */
export function formatLegacyIdentityLinkReport(report: LegacyIdentityLinkReport): string[] {
  return [
    `PRO-A2-02 LEGACY IDENTITY LINK REMEDIATION (${report.dryRun ? "DRY RUN — nothing changed" : "APPLIED"})`,
    `  scanned live legacy/admin links=${report.scanned}`,
    `  on self-serve accounts=${report.affected.length}`,
    ...report.affected.map(
      (a) => `    mapping=${a.mappingId} user=${a.userId} org=${a.organizationId} provider=${a.provider} source=${a.linkSource ?? "NULL"} evidence=${a.evidence}`,
    ),
    `  consentRecorded=${report.consentRecorded} unlinked=${report.unlinked} skipped=${report.skipped}`,
    "  UNBOUND_CONSENT_GRANT and NO_EVIDENCE links are never changed: they no longer sign anyone in, and the owner approves the link again.",
  ];
}
