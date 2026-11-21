/**
 * PRO-G2-01 — RESTRICTED HOLDER / SOURCE / ACCESS INVENTORY of the issued
 * verification packages the old Worker builder filled with other workspaces'
 * Trust Center rows. READ-ONLY.
 *
 * It builds on the replay inventory (legacy-trust-manifest-exposure-inventory.ts:
 * which packages the OLD unscoped reads would have filled with foreign rows,
 * and from which SOURCE workspaces) and adds, per affected package:
 *
 *   - the HOLDING workspace and its owner account, classified;
 *   - each SOURCE workspace and how it relates to the holder: same owner user,
 *     same organization, a shared active member, both operator-domain owners,
 *     a known test domain, or independent;
 *   - recorded downloads (count, last time, who: holder member / not / unknown);
 *   - every access path still recorded for the record: verification share
 *     links by purpose (active / expired / revoked / exhausted) and external
 *     reviewer grants (by state, live or not).
 *
 * PRIVACY: identities are ids, email DOMAINS and an HMAC of the email local
 * part only. A full address is never returned. The HMAC key is the caller's
 * (`hashSalt`); without one the CLI draws a random key per run, so hashes are
 * comparable inside one report only.
 *
 * WHAT IT IS NOT: this is DATABASE-INFERRED exposure. It does not open any
 * package; what an issued ZIP really carries is answered by the separate
 * sample inspection (trust-manifest-sample-inspection.ts).
 *
 * Every statement runs inside `SET TRANSACTION READ ONLY` (readOnlyInventoryRead).
 */
import {
  collectLegacyManifestExposureInventory,
  readOnlyInventoryRead,
  type LegacyManifestExposureFinding,
} from "./legacy-trust-manifest-exposure-inventory.js";

/** Commit a386f9c62 introduced the unscoped builder (2026-05-31T08:22:50Z). */
export const G2_01_DEFECT_INTRODUCED_UTC = "2026-05-31T08:22:50.000Z";
/** The fixed Worker (0db8a7c9e, released at 954829fa5) first ran 2026-11-21T02:21:41Z. */
export const G2_01_FIX_EFFECTIVE_UTC = "2026-11-21T02:21:41.000Z";

import {
  DEFAULT_OPERATOR_DOMAINS,
  DEFAULT_TEST_DOMAINS,
  classifySourceRelation,
  maskEmail,
  packageScope,
  type AccountClass,
  type MaskedAccount,
  type PackageScope,
  type SourceRelation,
  type TeamFact,
} from "./trust-exposure-classification.js";

export {
  DEFAULT_OPERATOR_DOMAINS,
  DEFAULT_TEST_DOMAINS,
  classifySourceRelation,
  maskEmail,
  packageScope,
  type AccountClass,
  type MaskedAccount,
  type PackageScope,
  type SourceRelation,
  type TeamFact,
};

type TeamRow = {
  id: string;
  organization_id: string;
  workspace_kind: string;
  is_personal: boolean;
  closed: boolean;
  owner_user_id: string;
  owner_email: string | null;
};
type MemberRow = { team_id: string; user_id: string };
type DownloadRow = {
  evidence_id: string;
  at_utc: Date;
  event_type: string;
  package_id: string | null;
  accessed_by: string | null;
  access_mode: string | null;
};
type ShareRow = {
  evidence_id: string;
  purpose: string;
  status: string;
  n: bigint;
  last_used: Date | null;
  last_expiry: Date | null;
};
type GrantRow = {
  id: string;
  evidence_id: string | null;
  package_id: string | null;
  state: string;
  live: boolean;
  expires_at_utc: Date;
  revoked_at_utc: Date | null;
  reviewer_email: string;
};

export type DownloadFacts = {
  attributedToPackage: number;
  lastAttributedAtUtc: string | null;
  recordLevelUnattributed: number;
  lastRecordLevelAtUtc: string | null;
  byHolderMembers: number;
  byNonMembers: number;
  byUnknown: number;
  externalReviewerUrlsIssued: number;
};

export type AccessPathFacts = {
  shareLinks: Array<{ purpose: string; status: string; count: number; lastUsedAtUtc: string | null; latestExpiryUtc: string | null }>;
  liveShareLinks: number;
  externalReviewGrants: Array<{
    grantId: string;
    state: string;
    live: boolean;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    boundToThisPackage: boolean;
    reviewer: Omit<MaskedAccount, "userId">;
    reviewerSameDomainAsHolderOwner: boolean;
  }>;
  liveExternalReviewGrants: number;
};

export type HolderInventoryPackage = {
  packageId: string;
  evidenceId: string;
  version: number;
  disclosureProfile: string;
  generatedAtUtc: string;
  replayClass: LegacyManifestExposureFinding["exposure"];
  distinctForeignArticles: number;
  distinctForeignSubprocessors: number;
  possibleWithdrawnForeignRows: number;
  holder: TeamFact;
  sources: Array<{ team: TeamFact; relation: SourceRelation }>;
  scope: PackageScope;
  downloads: DownloadFacts;
  access: AccessPathFacts;
};

export type HolderInventory = {
  readOnly: true;
  evidenceBasis: "DATABASE_INFERRED_REPLAY";
  artifactContents: "NOT_READ";
  window: { sinceUtc: string | null; untilUtc: string };
  packagesScanned: number;
  truncatedAtLimit: boolean;
  affectedPackages: number;
  byScope: Record<PackageScope, number>;
  byHolderClass: Record<AccountClass, number>;
  byProfile: Record<string, number>;
  withRecordedDownload: number;
  withLiveShareLink: number;
  withLiveExternalReviewGrant: number;
  holdingTeams: number;
  sourceTeams: number;
  packages: HolderInventoryPackage[];
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function collectTrustExposureHolderInventory(options: {
  since: Date | null;
  until: Date;
  hashSalt: string;
  operatorDomains?: readonly string[];
  testDomains?: readonly string[];
  batch?: number;
  limit?: number;
}): Promise<HolderInventory> {
  const maskOpts = {
    hashSalt: options.hashSalt,
    operatorDomains: options.operatorDomains ?? DEFAULT_OPERATOR_DOMAINS,
    testDomains: options.testDomains ?? DEFAULT_TEST_DOMAINS,
  };
  const replay = await collectLegacyManifestExposureInventory({
    since: options.since,
    until: options.until,
    batch: options.batch,
    limit: options.limit,
  });
  const findings = replay.findings;
  const teamIds = [...new Set(findings.flatMap((f) => [f.teamId, ...f.sourceTeamIds]))];
  const evidenceIds = [...new Set(findings.map((f) => f.evidenceId))];
  const packageIds = findings.map((f) => f.packageId);

  const { teams, members, downloads, shares, grants } = await readOnlyInventoryRead(async (tx) => {
    const teams = teamIds.length
      ? await tx.$queryRaw<TeamRow[]>`
          SELECT t.id::text AS id, t.organization_id::text AS organization_id, t.workspace_kind::text AS workspace_kind,
                 t.is_personal, (t.closed_at_utc IS NOT NULL) AS closed, t.owner_user_id::text AS owner_user_id,
                 u.email AS owner_email
            FROM teams t JOIN users u ON u.id = t.owner_user_id
           WHERE t.id = ANY(${teamIds}::uuid[])`
      : [];
    const members = teamIds.length
      ? await tx.$queryRaw<MemberRow[]>`
          SELECT team_id::text AS team_id, user_id::text AS user_id FROM team_members
           WHERE team_id = ANY(${teamIds}::uuid[]) AND status::text = 'ACTIVE'`
      : [];
    const downloads = evidenceIds.length
      ? await tx.$queryRaw<DownloadRow[]>`
          SELECT c.evidence_id::text AS evidence_id, c.at_utc, c.event_type::text AS event_type,
                 c.payload->>'packageId' AS package_id,
                 COALESCE(c.payload->>'accessedByUserId', c.payload->>'actorUserId', c.payload->>'userId') AS accessed_by,
                 c.payload->>'accessMode' AS access_mode
            FROM custody_events c
           WHERE c.evidence_id = ANY(${evidenceIds}::uuid[])
             AND (c.event_type::text = 'VERIFICATION_PACKAGE_DOWNLOADED'
                  OR (c.event_type::text = 'DOWNLOAD_AUTHORIZED' AND c.payload->>'artifact' = 'verification_package'))`
      : [];
    const shares = evidenceIds.length
      ? await tx.$queryRaw<ShareRow[]>`
          SELECT evidence_id::text AS evidence_id, purpose,
                 CASE WHEN revoked_at_utc IS NOT NULL THEN 'REVOKED'
                      WHEN expires_at_utc IS NOT NULL AND expires_at_utc <= now() THEN 'EXPIRED'
                      WHEN max_uses IS NOT NULL AND use_count >= max_uses THEN 'EXHAUSTED'
                      ELSE 'ACTIVE' END AS status,
                 count(*) AS n, max(last_used_at_utc) AS last_used, max(expires_at_utc) AS last_expiry
            FROM verification_share_tokens
           WHERE evidence_id = ANY(${evidenceIds}::uuid[])
           GROUP BY 1, 2, 3`
      : [];
    const grants = evidenceIds.length
      ? await tx.$queryRaw<GrantRow[]>`
          SELECT g.id::text AS id, g.evidence_id::text AS evidence_id, g.package_id::text AS package_id, g.state,
                 (g.revoked_at_utc IS NULL AND g.expires_at_utc > now() AND g.state IN ('INVITED', 'ACTIVE')) AS live,
                 g.expires_at_utc, g.revoked_at_utc, g.reviewer_email
            FROM external_review_grants g
           WHERE g.evidence_id = ANY(${evidenceIds}::uuid[]) OR g.package_id = ANY(${packageIds}::uuid[])`
      : [];
    return { teams, members, downloads, shares, grants };
  });

  const membersByTeam = new Map<string, string[]>();
  for (const m of members) membersByTeam.set(m.team_id, [...(membersByTeam.get(m.team_id) ?? []), m.user_id]);
  const teamFacts = new Map<string, TeamFact>();
  for (const t of teams) {
    teamFacts.set(t.id, {
      teamId: t.id,
      organizationId: t.organization_id,
      workspaceKind: t.workspace_kind,
      isPersonal: t.is_personal,
      closed: t.closed,
      owner: maskEmail(t.owner_user_id, t.owner_email, maskOpts),
      activeMemberUserIds: (membersByTeam.get(t.id) ?? []).sort(),
    });
  }
  const missingTeam = (teamId: string): TeamFact => ({
    teamId,
    organizationId: "(missing)",
    workspaceKind: "(missing)",
    isPersonal: false,
    closed: true,
    owner: { userId: "(missing)", domain: null, localPartHmac: null, class: "NO_EMAIL" },
    activeMemberUserIds: [],
  });

  const byEvidence = <T extends { evidence_id: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.evidence_id) m.set(r.evidence_id, [...(m.get(r.evidence_id) ?? []), r]);
    return m;
  };
  const dlByEvidence = byEvidence(downloads);
  const sharesByEvidence = byEvidence(shares);

  const packages: HolderInventoryPackage[] = [];
  for (const f of findings) {
    const holder = teamFacts.get(f.teamId) ?? missingTeam(f.teamId);
    const sources = f.sourceTeamIds.map((s) => {
      const team = teamFacts.get(s) ?? missingTeam(s);
      return { team, relation: classifySourceRelation(holder, team) };
    });
    const holderMembers = new Set(holder.activeMemberUserIds);
    const evDownloads = dlByEvidence.get(f.evidenceId) ?? [];
    const mine = evDownloads.filter((d) => d.package_id === f.packageId);
    const unattributed = evDownloads.filter((d) => !d.package_id);
    const counted = [...mine, ...unattributed];
    const last = (rows: DownloadRow[]) =>
      rows.length ? iso(new Date(Math.max(...rows.map((r) => r.at_utc.getTime())))) : null;
    const downloadsFacts: DownloadFacts = {
      attributedToPackage: mine.length,
      lastAttributedAtUtc: last(mine),
      recordLevelUnattributed: unattributed.length,
      lastRecordLevelAtUtc: last(unattributed),
      byHolderMembers: counted.filter((d) => d.accessed_by && holderMembers.has(d.accessed_by)).length,
      byNonMembers: counted.filter((d) => d.accessed_by && !holderMembers.has(d.accessed_by)).length,
      byUnknown: counted.filter((d) => !d.accessed_by).length,
      externalReviewerUrlsIssued: mine.filter((d) => d.access_mode === "external_reviewer_download_url_issued").length,
    };
    const shareRows = sharesByEvidence.get(f.evidenceId) ?? [];
    const grantRows = grants.filter((g) => g.evidence_id === f.evidenceId || g.package_id === f.packageId);
    const access: AccessPathFacts = {
      shareLinks: shareRows
        .map((s) => ({ purpose: s.purpose, status: s.status, count: Number(s.n), lastUsedAtUtc: iso(s.last_used), latestExpiryUtc: iso(s.last_expiry) }))
        .sort((a, b) => (a.purpose + a.status).localeCompare(b.purpose + b.status)),
      liveShareLinks: shareRows.filter((s) => s.status === "ACTIVE").reduce((n, s) => n + Number(s.n), 0),
      externalReviewGrants: grantRows.map((g) => {
        const masked = maskEmail("-", g.reviewer_email, maskOpts);
        const reviewer = { domain: masked.domain, localPartHmac: masked.localPartHmac, class: masked.class };
        return {
          grantId: g.id,
          state: g.state,
          live: g.live,
          expiresAtUtc: g.expires_at_utc.toISOString(),
          revokedAtUtc: iso(g.revoked_at_utc),
          boundToThisPackage: g.package_id === f.packageId,
          reviewer,
          reviewerSameDomainAsHolderOwner: reviewer.domain !== null && reviewer.domain === holder.owner.domain,
        };
      }),
      liveExternalReviewGrants: grantRows.filter((g) => g.live).length,
    };
    packages.push({
      packageId: f.packageId,
      evidenceId: f.evidenceId,
      version: f.version,
      disclosureProfile: f.disclosureProfile,
      generatedAtUtc: f.generatedAtUtc,
      replayClass: f.exposure,
      distinctForeignArticles: f.distinctForeignArticles,
      distinctForeignSubprocessors: f.distinctForeignSubprocessors,
      possibleWithdrawnForeignRows: f.possibleWithdrawnForeignRows,
      holder,
      sources,
      scope: packageScope(sources.map((s) => s.relation)),
      downloads: downloadsFacts,
      access,
    });
  }

  const count = <K extends string>(keys: readonly K[], pick: (p: HolderInventoryPackage) => K) => {
    const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
    for (const p of packages) out[pick(p)] += 1;
    return out;
  };
  const byProfile: Record<string, number> = {};
  for (const p of packages) byProfile[p.disclosureProfile] = (byProfile[p.disclosureProfile] ?? 0) + 1;

  return {
    readOnly: true,
    evidenceBasis: "DATABASE_INFERRED_REPLAY",
    artifactContents: "NOT_READ",
    window: { sinceUtc: iso(options.since), untilUtc: options.until.toISOString() },
    packagesScanned: replay.packagesScanned,
    truncatedAtLimit: replay.truncatedAtLimit,
    affectedPackages: packages.length,
    byScope: count(["NO_DISTINCT_SOURCE", "SAME_OWNER_ONLY", "OPERATOR_OR_TEST_ONLY", "CROSS_PARTY"] as const, (p) => p.scope),
    byHolderClass: count(["OPERATOR", "TEST_DOMAIN", "NO_EMAIL", "EXTERNAL"] as const, (p) => p.holder.owner.class),
    byProfile,
    withRecordedDownload: packages.filter((p) => p.downloads.attributedToPackage + p.downloads.recordLevelUnattributed > 0).length,
    withLiveShareLink: packages.filter((p) => p.access.liveShareLinks > 0).length,
    withLiveExternalReviewGrant: packages.filter((p) => p.access.liveExternalReviewGrants > 0).length,
    holdingTeams: new Set(packages.map((p) => p.holder.teamId)).size,
    sourceTeams: new Set(packages.flatMap((p) => p.sources.map((s) => s.team.teamId))).size,
    packages,
  };
}
