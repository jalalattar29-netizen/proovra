/**
 * PRO-G2-01 — EXACT ACCESS PATHS of the CROSS_PARTY packages, and THE
 * CONTAINMENT SET derived from them. READ-ONLY here; the one write path is the
 * containment script, which revokes through the canonical service.
 *
 * Starts from the holder inventory (trust-exposure-holder-inventory.ts: which
 * packages the old unscoped builder filled with foreign rows, who holds them,
 * how the sources relate) and keeps the CROSS_PARTY packages. For each it lists
 * every distinct access record — never a token, token hash, view-session hash,
 * reviewer address or owner's audience label:
 *
 *   SHARE LINKS (verification_share_tokens). A link row belongs to a RECORD
 *   (evidence_id), not to a package version: every package of that record is
 *   "attached through the evidence record". What a link opens is the public
 *   verify page of the record (GET /public/verify/:token). That page carries
 *   the package's integrity metadata but NEVER the package ZIP or its
 *   intelligence/*.json trust manifests: the ZIP is released only to an
 *   authenticated member (GET /v1/evidence/:id/verification-package…) or to an
 *   external-review grant (GET /v1/external-review/access/:token/verification-package).
 *   So no share link is a path to the foreign Trust Center rows; each is a
 *   record-level public capability on an affected record.
 *
 *   EXTERNAL-REVIEW GRANTS (external_review_grants). The grant releases the
 *   EXTERNAL_DISCLOSURE package of the record's latest report version. A grant
 *   covers a record by EVIDENCE scope (evidence_id), PACKAGE scope (a package of
 *   the record) or CASE scope (the record is linked to the case). The holder
 *   inventory matched only evidence_id / the affected package id, so a CASE
 *   grant or a PACKAGE grant on another version of the record was not counted;
 *   this module matches all three (CASE: every case link, a superset of the
 *   restricted-case refinement the portal applies at access time).
 *
 * CONTAINMENT ELIGIBILITY (the exact set the owner authorised: currently
 * active, revocable share links conclusively attached to an affected
 * CROSS_PARTY package):
 *   - purpose OWNER_SHARE (a reviewer share). REPORT / PACKAGE links are the
 *     link an issued artifact printed; by contract (PRO-O1-04 / RG-18, DEC-09)
 *     they are not revoked through share controls — only the step-up-gated
 *     withdraw route takes that page down — so they are listed and REFUSED;
 *   - state ACTIVE by the share authority (not revoked, not expired, not
 *     exhausted: verificationShareStateOf);
 *   - its evidence_id is the record of a CROSS_PARTY package, AND it was created
 *     in the holding workspace (team_id = the holder) or before links carried a
 *     workspace (team_id NULL). A link created while the record sat in another
 *     workspace is not conclusively the holder's: listed and REFUSED.
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { verificationShareStateOf, type VerificationShareState } from "@proovra/shared-runtime";

import {
  DEFAULT_OPERATOR_DOMAINS,
  DEFAULT_TEST_DOMAINS,
  G2_01_DEFECT_INTRODUCED_UTC,
  G2_01_FIX_EFFECTIVE_UTC,
  collectTrustExposureHolderInventory,
  maskEmail,
  type DownloadFacts,
  type HolderInventory,
  type HolderInventoryPackage,
} from "./trust-exposure-holder-inventory.js";

export const CONTAINMENT_SET_SCOPE_LABEL = "verification_share_tokens:OWNER_SHARE:ACTIVE:g2-01-cross-party:v1";
export const CONTAINMENT_REASON_CODE = "SECURITY_CONTAINMENT_PRO_G2_01";
export const CONTAINMENT_INCIDENT_REF = "PRO-G2-01";

export const DOWNLOAD_MEANING = {
  attributedToPackage:
    "custody events DOWNLOAD_AUTHORIZED (payload.artifact = verification_package) naming THIS package id: a download URL was issued for this exact package (member route or external-review grant); a URL issued is not proof the bytes moved",
  recordLevelUnattributed:
    "custody events VERIFICATION_PACKAGE_DOWNLOADED / DOWNLOAD_AUTHORIZED on the RECORD without a package id (older events): some package version of the record was downloaded; counted for every affected package of that record",
  perPackageOrPerLink: "per package (attributed) and per record (unattributed); never per share link: a share link cannot download a package",
} as const;

type Tx = Pick<PrismaClient, "$queryRaw" | "$executeRawUnsafe">;

type LinkRow = {
  id: string;
  evidence_id: string;
  team_id: string | null;
  token_hash: string;
  last_use_session_hash: string | null;
  purpose: string;
  projection: string;
  audience_present: boolean;
  report_version: number | null;
  created_by_user_id: string | null;
  created_at_utc: Date;
  expires_at_utc: Date | null;
  revoked_at_utc: Date | null;
  revocation_reason: string | null;
  max_uses: number | null;
  use_count: number;
  last_used_at_utc: Date | null;
  allow_original_download: boolean;
};

type GrantRow = {
  id: string;
  team_id: string;
  scope_kind: string;
  case_id: string | null;
  package_id: string | null;
  covered_evidence_id: string;
  matched_by: "EVIDENCE_ID" | "PACKAGE_OF_RECORD" | "CASE_LINK";
  state: string;
  live: boolean;
  allow_package_download: boolean;
  created_at_utc: Date;
  expires_at_utc: Date;
  revoked_at_utc: Date | null;
  reviewer_email: string;
  token_hash: string;
};

export type LinkFamily = "REVIEWER_SHARE" | "ARTIFACT_LINK";

export type CrossPartyLink = {
  linkId: string;
  evidenceId: string;
  purpose: string;
  family: LinkFamily;
  projection: string;
  allowOriginalDownload: boolean;
  state: VerificationShareState;
  createdAtUtc: string;
  createdAfterFix: boolean;
  expiresAtUtc: string | null;
  useCount: number;
  maxUses: number | null;
  lastUsedAtUtc: string | null;
  revokedAtUtc: string | null;
  revocationReason: string | null;
  linkTeamId: string | null;
  holderTeamId: string;
  linkTeamIsHolder: boolean | null;
  createdByUserId: string | null;
  audienceLabelPresent: boolean;
  reportVersion: number | null;
  attachedVia: "EVIDENCE_RECORD";
  packageIds: string[];
  opensPublicVerifyPage: true;
  reachesPackageBytes: false;
  revocable: boolean;
  revocableWhy: string;
  containmentEligible: boolean;
  containmentWhy: string;
};

export type CrossPartyGrant = {
  grantId: string;
  teamId: string;
  scopeKind: string;
  matchedBy: GrantRow["matched_by"];
  caseId: string | null;
  packageId: string | null;
  state: string;
  live: boolean;
  allowPackageDownload: boolean;
  createdAtUtc: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  reviewer: { domain: string | null; localPartHmac: string | null; class: string };
  reviewerSameDomainAsHolderOwner: boolean;
  releases: "EXTERNAL_DISCLOSURE package of the record's latest report version (when allowPackageDownload)";
};

export type CrossPartyPackageAccess = {
  packageId: string;
  evidenceId: string;
  version: number;
  disclosureProfile: string;
  generatedAtUtc: string;
  scope: "CROSS_PARTY";
  recipientOwnership: {
    holderTeamId: string;
    holderClass: string;
    holderDomain: string | null;
    sources: Array<{ teamId: string; relation: string; ownerClass: string; ownerDomain: string | null }>;
    reading: string;
  };
  downloads: DownloadFacts;
  liveShareLinkIds: string[];
  nonLiveShareLinks: Record<Exclude<VerificationShareState, "ACTIVE">, number>;
  liveExternalReviewGrantIds: string[];
  nonLiveExternalReviewGrants: number;
  externalReviewGrantCouldReleaseThisPackage: boolean;
};

export type CrossPartyAccessInventory = {
  readOnly: true;
  evidenceBasis: "DATABASE_INFERRED_REPLAY + CURRENT_ACCESS_ROWS";
  artifactContents: "NOT_READ";
  window: { sinceUtc: string; untilUtc: string };
  observedAtUtc: string;
  holderInventoryWithLiveShareLink: number;
  summary: {
    affectedCrossPartyPackages: number;
    affectedCrossPartyRecords: number;
    packagesWithLiveShareLink: number;
    distinctLiveShareLinks: number;
    distinctLiveShareLinksByPurpose: Record<string, number>;
    liveLinksRevocable: number;
    liveLinksContainmentEligible: number;
    liveLinksRefused: Record<string, number>;
    liveLinksPerPackage: Record<string, number>;
    packagesPerLiveLink: Record<string, number>;
    liveLinksCreatedAfterFix: number;
    distinctLiveExternalReviewGrants: number;
    liveGrantsByScope: Record<string, number>;
    packagesWithLiveExternalReviewGrant: number;
    shareLinksReachPackageBytes: false;
  };
  links: CrossPartyLink[];
  grants: CrossPartyGrant[];
  packages: CrossPartyPackageAccess[];
  /** Held in memory for the output guard only; never serialised. */
  secrets: string[];
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function readOnly<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx as unknown as Tx);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/** The CROSS_PARTY packages of the defect window, from the holder inventory (read-only). */
export async function collectCrossPartyPackages(options: { hashSalt: string }): Promise<{
  inventory: HolderInventory;
  packages: HolderInventoryPackage[];
  window: { since: Date; until: Date };
}> {
  const since = new Date(G2_01_DEFECT_INTRODUCED_UTC);
  const until = new Date(G2_01_FIX_EFFECTIVE_UTC);
  const inventory = await collectTrustExposureHolderInventory({
    since,
    until,
    hashSalt: options.hashSalt,
    operatorDomains: DEFAULT_OPERATOR_DOMAINS,
    testDomains: DEFAULT_TEST_DOMAINS,
  });
  return { inventory, packages: inventory.packages.filter((p) => p.scope === "CROSS_PARTY"), window: { since, until } };
}

/** Every share-link row of the given records (all states). `lock` = FOR UPDATE. */
export async function loadShareLinkRows(tx: Tx, evidenceIds: string[], lock: boolean): Promise<LinkRow[]> {
  if (evidenceIds.length === 0) return [];
  return lock
    ? tx.$queryRaw<LinkRow[]>`
        SELECT id::text AS id, evidence_id::text AS evidence_id, team_id::text AS team_id, token_hash, last_use_session_hash,
               purpose, projection, (audience IS NOT NULL AND audience <> '') AS audience_present, report_version,
               created_by_user_id::text AS created_by_user_id, created_at_utc, expires_at_utc, revoked_at_utc, revocation_reason,
               max_uses, use_count, last_used_at_utc, allow_original_download
          FROM verification_share_tokens
         WHERE evidence_id = ANY(${evidenceIds}::uuid[])
         ORDER BY id
           FOR UPDATE`
    : tx.$queryRaw<LinkRow[]>`
        SELECT id::text AS id, evidence_id::text AS evidence_id, team_id::text AS team_id, token_hash, last_use_session_hash,
               purpose, projection, (audience IS NOT NULL AND audience <> '') AS audience_present, report_version,
               created_by_user_id::text AS created_by_user_id, created_at_utc, expires_at_utc, revoked_at_utc, revocation_reason,
               max_uses, use_count, last_used_at_utc, allow_original_download
          FROM verification_share_tokens
         WHERE evidence_id = ANY(${evidenceIds}::uuid[])
         ORDER BY id`;
}

async function loadGrantRows(tx: Tx, evidenceIds: string[]): Promise<GrantRow[]> {
  if (evidenceIds.length === 0) return [];
  return tx.$queryRaw<GrantRow[]>`
    WITH ev AS (SELECT unnest(${evidenceIds}::uuid[]) AS evidence_id),
    hits AS (
      SELECT g.id, ev.evidence_id, 'EVIDENCE_ID'::text AS matched_by
        FROM external_review_grants g JOIN ev ON g.evidence_id = ev.evidence_id
      UNION
      SELECT g.id, ev.evidence_id, 'PACKAGE_OF_RECORD'::text
        FROM external_review_grants g
        JOIN verification_packages p ON p.id = g.package_id
        JOIN ev ON p.evidence_id = ev.evidence_id
      UNION
      SELECT g.id, ev.evidence_id, 'CASE_LINK'::text
        FROM external_review_grants g
        JOIN case_evidence_links l ON l.case_id = g.case_id
        JOIN ev ON l.evidence_id = ev.evidence_id
       WHERE g.scope_kind = 'CASE'
    )
    SELECT DISTINCT ON (g.id, h.evidence_id)
           g.id::text AS id, g.team_id::text AS team_id, g.scope_kind, g.case_id::text AS case_id, g.package_id::text AS package_id,
           h.evidence_id::text AS covered_evidence_id, h.matched_by, g.state,
           (g.revoked_at_utc IS NULL AND g.expires_at_utc > now() AND g.state IN ('INVITED', 'ACTIVE')) AS live,
           g.allow_package_download, g.created_at_utc, g.expires_at_utc, g.revoked_at_utc, g.reviewer_email, g.token_hash
      FROM hits h JOIN external_review_grants g ON g.id = h.id
     ORDER BY g.id, h.evidence_id, h.matched_by`;
}

type HolderOf = Map<string, { holderTeamId: string; packageIds: string[] }>;

function holdersByRecord(packages: readonly HolderInventoryPackage[]): HolderOf {
  const m: HolderOf = new Map();
  for (const p of packages) {
    const cur = m.get(p.evidenceId) ?? { holderTeamId: p.holder.teamId, packageIds: [] };
    cur.packageIds.push(p.packageId);
    m.set(p.evidenceId, cur);
  }
  for (const v of m.values()) v.packageIds.sort();
  return m;
}

/** The pure rule: one link row, its record's holder → the classified link. */
export function classifyLink(row: LinkRow, holder: { holderTeamId: string; packageIds: string[] }, now: Date): CrossPartyLink {
  const state = verificationShareStateOf(
    { revokedAtUtc: row.revoked_at_utc, expiresAtUtc: row.expires_at_utc, maxUses: row.max_uses, useCount: row.use_count },
    now,
  );
  const family: LinkFamily = row.purpose === "OWNER_SHARE" ? "REVIEWER_SHARE" : "ARTIFACT_LINK";
  const linkTeamIsHolder = row.team_id === null ? null : row.team_id === holder.holderTeamId;
  let revocable = false;
  let revocableWhy: string;
  if (family === "ARTIFACT_LINK") {
    revocableWhy =
      "NOT_REVOCABLE_BY_CONTRACT: a REPORT/PACKAGE link is the link an issued artifact printed (PRO-O1-04 / RG-18, DEC-09); share controls refuse it, only the step-up-gated withdraw route takes the page down";
  } else if (state !== "ACTIVE") {
    revocableWhy = `NOT_ACTIVE: ${state}`;
  } else {
    revocable = true;
    revocableWhy = "OWNER_SHARE and ACTIVE: revocable through the canonical reviewer-share revocation (revokeVerificationLink rule)";
  }
  let containmentEligible = false;
  let containmentWhy: string;
  if (!revocable) containmentWhy = `REFUSED_${revocableWhy.split(":")[0]}`;
  else if (linkTeamIsHolder === false) {
    containmentWhy = "REFUSED_NOT_CONCLUSIVE: created in another workspace than the record's current holder";
  } else {
    containmentEligible = true;
    containmentWhy = "ELIGIBLE: active reviewer share on the record of a CROSS_PARTY package, created in the holding workspace";
  }
  return {
    linkId: row.id,
    evidenceId: row.evidence_id,
    purpose: row.purpose,
    family,
    projection: row.projection,
    allowOriginalDownload: row.allow_original_download,
    state,
    createdAtUtc: row.created_at_utc.toISOString(),
    createdAfterFix: row.created_at_utc.getTime() >= new Date(G2_01_FIX_EFFECTIVE_UTC).getTime(),
    expiresAtUtc: iso(row.expires_at_utc),
    useCount: row.use_count,
    maxUses: row.max_uses,
    lastUsedAtUtc: iso(row.last_used_at_utc),
    revokedAtUtc: iso(row.revoked_at_utc),
    revocationReason: row.revocation_reason,
    linkTeamId: row.team_id,
    holderTeamId: holder.holderTeamId,
    linkTeamIsHolder,
    createdByUserId: row.created_by_user_id,
    audienceLabelPresent: row.audience_present,
    reportVersion: row.report_version,
    attachedVia: "EVIDENCE_RECORD",
    packageIds: holder.packageIds,
    opensPublicVerifyPage: true,
    reachesPackageBytes: false,
    revocable,
    revocableWhy,
    containmentEligible,
    containmentWhy: containmentEligible ? containmentWhy : containmentWhy.split(":")[0]!,
  };
}

export function containmentSetHash(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(`${CONTAINMENT_SET_SCOPE_LABEL}\n${sorted.join("\n")}`).digest("hex");
}

export type ContainmentSet = {
  /** Every live link on a CROSS_PARTY record, classified. */
  liveLinks: CrossPartyLink[];
  eligible: CrossPartyLink[];
  refused: CrossPartyLink[];
  ids: string[];
  setHash: string;
  secrets: string[];
};

/** Derive the containment set from link rows (already read, locked or not). */
export function containmentSetOf(rows: readonly LinkRow[], holders: HolderOf, now: Date): ContainmentSet {
  const liveLinks = rows
    .filter((r) => holders.has(r.evidence_id))
    .map((r) => classifyLink(r, holders.get(r.evidence_id)!, now))
    .filter((l) => l.state === "ACTIVE");
  const eligible = liveLinks.filter((l) => l.containmentEligible);
  const ids = eligible.map((l) => l.linkId).sort();
  return {
    liveLinks,
    eligible,
    refused: liveLinks.filter((l) => !l.containmentEligible),
    ids,
    setHash: containmentSetHash(ids),
    secrets: rows.flatMap((r) => [r.token_hash, r.last_use_session_hash ?? ""]).filter((s) => s.length > 0),
  };
}

export function recordHolders(packages: readonly HolderInventoryPackage[]): HolderOf {
  return holdersByRecord(packages);
}

/** The containment set, read-only (the dry run). */
export async function planContainmentSet(client: PrismaClient, packages: readonly HolderInventoryPackage[], now: Date): Promise<ContainmentSet> {
  const holders = holdersByRecord(packages);
  const rows = await readOnly(client, (tx) => loadShareLinkRows(tx, [...holders.keys()], false));
  return containmentSetOf(rows, holders, now);
}

function dist(values: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** THE EXACT INVENTORY (read-only). */
export async function collectCrossPartyAccessInventory(
  client: PrismaClient,
  options: { hashSalt: string; now?: Date },
): Promise<CrossPartyAccessInventory> {
  const now = options.now ?? new Date();
  const { inventory, packages, window } = await collectCrossPartyPackages({ hashSalt: options.hashSalt });
  const holders = holdersByRecord(packages);
  const evidenceIds = [...holders.keys()];
  const { linkRows, grantRows } = await readOnly(client, async (tx) => ({
    linkRows: await loadShareLinkRows(tx, evidenceIds, false),
    grantRows: await loadGrantRows(tx, evidenceIds),
  }));
  const set = containmentSetOf(linkRows, holders, now);
  const allLinks = linkRows.filter((r) => holders.has(r.evidence_id)).map((r) => classifyLink(r, holders.get(r.evidence_id)!, now));

  const maskOpts = { hashSalt: options.hashSalt, operatorDomains: DEFAULT_OPERATOR_DOMAINS, testDomains: DEFAULT_TEST_DOMAINS };
  const holderDomainByRecord = new Map(packages.map((p) => [p.evidenceId, p.holder.owner.domain]));
  const grantsById = new Map<string, CrossPartyGrant & { coveredEvidenceIds: Set<string> }>();
  for (const g of grantRows) {
    const masked = maskEmail("-", g.reviewer_email, maskOpts);
    const existing = grantsById.get(g.id);
    if (existing) {
      existing.coveredEvidenceIds.add(g.covered_evidence_id);
      continue;
    }
    const holderDomain = holderDomainByRecord.get(g.covered_evidence_id) ?? null;
    grantsById.set(g.id, {
      grantId: g.id,
      teamId: g.team_id,
      scopeKind: g.scope_kind,
      matchedBy: g.matched_by,
      caseId: g.case_id,
      packageId: g.package_id,
      state: g.state,
      live: g.live,
      allowPackageDownload: g.allow_package_download,
      createdAtUtc: g.created_at_utc.toISOString(),
      expiresAtUtc: g.expires_at_utc.toISOString(),
      revokedAtUtc: iso(g.revoked_at_utc),
      reviewer: { domain: masked.domain, localPartHmac: masked.localPartHmac, class: masked.class },
      reviewerSameDomainAsHolderOwner: masked.domain !== null && masked.domain === holderDomain,
      releases: "EXTERNAL_DISCLOSURE package of the record's latest report version (when allowPackageDownload)",
      coveredEvidenceIds: new Set([g.covered_evidence_id]),
    });
  }
  const grantList = [...grantsById.values()];

  const pkgOut: CrossPartyPackageAccess[] = packages.map((p) => {
    const recLinks = allLinks.filter((l) => l.evidenceId === p.evidenceId);
    const recGrants = grantList.filter((g) => g.coveredEvidenceIds.has(p.evidenceId));
    const nonLive = { REVOKED: 0, EXPIRED: 0, EXHAUSTED: 0 };
    for (const l of recLinks) if (l.state !== "ACTIVE") nonLive[l.state] += 1;
    return {
      packageId: p.packageId,
      evidenceId: p.evidenceId,
      version: p.version,
      disclosureProfile: p.disclosureProfile,
      generatedAtUtc: p.generatedAtUtc,
      scope: "CROSS_PARTY",
      recipientOwnership: {
        holderTeamId: p.holder.teamId,
        holderClass: p.holder.owner.class,
        holderDomain: p.holder.owner.domain,
        sources: p.sources.map((s) => ({ teamId: s.team.teamId, relation: s.relation, ownerClass: s.team.owner.class, ownerDomain: s.team.owner.domain })),
        reading:
          "the HOLDER is the recipient of the foreign rows; each INDEPENDENT source is a party whose rows it received; a share link's bearer is unknown (audience labels are not printed)",
      },
      downloads: p.downloads,
      liveShareLinkIds: recLinks.filter((l) => l.state === "ACTIVE").map((l) => l.linkId).sort(),
      nonLiveShareLinks: nonLive,
      liveExternalReviewGrantIds: recGrants.filter((g) => g.live).map((g) => g.grantId).sort(),
      nonLiveExternalReviewGrants: recGrants.filter((g) => !g.live).length,
      externalReviewGrantCouldReleaseThisPackage:
        p.disclosureProfile === "EXTERNAL_DISCLOSURE" && recGrants.some((g) => g.live && g.allowPackageDownload),
    };
  });

  const byPurpose: Record<string, number> = {};
  for (const l of set.liveLinks) byPurpose[l.purpose] = (byPurpose[l.purpose] ?? 0) + 1;
  const refusedBy: Record<string, number> = {};
  for (const l of set.refused) refusedBy[l.containmentWhy] = (refusedBy[l.containmentWhy] ?? 0) + 1;
  const liveGrants = grantList.filter((g) => g.live);
  const liveGrantsByScope: Record<string, number> = {};
  for (const g of liveGrants) liveGrantsByScope[g.scopeKind] = (liveGrantsByScope[g.scopeKind] ?? 0) + 1;

  return {
    readOnly: true,
    evidenceBasis: "DATABASE_INFERRED_REPLAY + CURRENT_ACCESS_ROWS",
    artifactContents: "NOT_READ",
    window: { sinceUtc: window.since.toISOString(), untilUtc: window.until.toISOString() },
    observedAtUtc: now.toISOString(),
    holderInventoryWithLiveShareLink: inventory.withLiveShareLink,
    summary: {
      affectedCrossPartyPackages: packages.length,
      affectedCrossPartyRecords: evidenceIds.length,
      packagesWithLiveShareLink: pkgOut.filter((p) => p.liveShareLinkIds.length > 0).length,
      distinctLiveShareLinks: set.liveLinks.length,
      distinctLiveShareLinksByPurpose: byPurpose,
      liveLinksRevocable: set.liveLinks.filter((l) => l.revocable).length,
      liveLinksContainmentEligible: set.eligible.length,
      liveLinksRefused: refusedBy,
      liveLinksPerPackage: dist(pkgOut.map((p) => p.liveShareLinkIds.length)),
      packagesPerLiveLink: dist(set.liveLinks.map((l) => l.packageIds.length)),
      liveLinksCreatedAfterFix: set.liveLinks.filter((l) => l.createdAfterFix).length,
      distinctLiveExternalReviewGrants: liveGrants.length,
      liveGrantsByScope,
      packagesWithLiveExternalReviewGrant: pkgOut.filter((p) => p.liveExternalReviewGrantIds.length > 0).length,
      shareLinksReachPackageBytes: false,
    },
    links: allLinks.filter((l) => l.state === "ACTIVE"),
    grants: grantList.map(({ coveredEvidenceIds, ...g }) => ({ ...g, coveredEvidenceIds: [...coveredEvidenceIds].sort() })) as CrossPartyGrant[],
    packages: pkgOut,
    secrets: [
      ...set.secrets,
      ...grantRows.flatMap((g) => [g.token_hash, g.reviewer_email]),
    ].filter((s) => s.length > 0),
  };
}

/**
 * THE OUTPUT GUARD (as redact-stored-bearer-previews): the serialised report
 * is checked against every secret value read — token hashes, view-session
 * hashes, grant token hashes, reviewer addresses — and against bearer shapes
 * (a pvs_ token, a /verify/ or /external-review/access/ URL). A hit returns
 * null: the caller prints nothing and exits 1.
 */
export function guardedJson(payload: unknown, secrets: readonly string[]): string | null {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (secrets.some((s) => s.length >= 8 && text.includes(s))) return null;
  if (/pvs_[A-Za-z0-9_-]{20,}|pvr_[A-Za-z0-9_-]{20,}|\/verify\/[A-Za-z0-9_-]{8,}|external-review\/access\/[A-Za-z0-9_-]{8,}|https?:\/\//.test(text)) return null;
  return text;
}
