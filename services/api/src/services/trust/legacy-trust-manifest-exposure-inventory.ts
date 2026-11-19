/**
 * PRO-G2-01 — the READ-ONLY database side of the trust-manifest exposure
 * inventory (the rule itself is replayed in legacy-trust-manifest-exposure.ts;
 * the operator entry point is scripts/trust-manifest-exposure-inventory.ts).
 *
 * Every statement runs inside a `SET TRANSACTION READ ONLY` transaction: the
 * database refuses a write even if one were added here by mistake. Nothing in
 * this module opens a package, queues a job or sends anything.
 */
import { prisma } from "../../db.js";
import {
  LEGACY_MANIFEST_ARTICLE_KINDS,
  buildLegacyExposureIndex,
  replayLegacyManifestExposure,
  type LegacyArticleFact,
  type LegacyExposureClass,
  type LegacySubprocessorFact,
} from "./legacy-trust-manifest-exposure.js";

type ReadTx = Pick<typeof prisma, "$queryRaw" | "$executeRawUnsafe">;

/** Every read goes through here: the database itself refuses a write. */
export async function readOnlyInventoryRead<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx as unknown as ReadTx);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

type ArticleRow = {
  team_id: string;
  kind: string;
  section: string;
  slug: string;
  title: string;
  state: string;
  published_at_utc: Date | null;
  created_at: Date;
  first_published_version_at: Date | null;
};
type SubprocessorRow = {
  team_id: string;
  name: string;
  category: string;
  country: string | null;
  state: string;
  created_at: Date;
};
type PackageRow = {
  id: string;
  evidence_id: string;
  team_id: string;
  version: number;
  disclosure_profile: string | null;
  generated_at: Date;
  generated_at_recorded: boolean;
};
type AccessRow = { evidence_id: string; downloads: bigint; live_package_links: bigint; package_links: bigint };

async function loadArticles(): Promise<LegacyArticleFact[]> {
  const rows = await readOnlyInventoryRead((tx) =>
    tx.$queryRaw<ArticleRow[]>`
      SELECT a.team_id, a.kind, a.section, a.slug, a.title, a.state, a.published_at_utc, a.created_at,
             (SELECT min(COALESCE(v.published_at_utc, v.published_at, v.created_at))
                FROM trust_center_article_versions v
               WHERE v.article_id = a.id AND v.state = 'PUBLISHED') AS first_published_version_at
        FROM trust_center_articles a
       WHERE a.kind = ANY(${[...LEGACY_MANIFEST_ARTICLE_KINDS]})`,
  );
  return rows.map((r) => {
    const publishedNow = r.state === "PUBLISHED";
    // Published now: visible since its first publication (version history when
    // it is earlier, else the row's own stamp, else its creation). Not
    // published now: only version history can say it ever was.
    const stamps = [r.first_published_version_at, publishedNow ? (r.published_at_utc ?? r.created_at) : null].filter(
      (d): d is Date => d instanceof Date,
    );
    const visibleFromUtc = stamps.length > 0 ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : null;
    return { teamId: r.team_id, kind: r.kind, section: r.section, slug: r.slug, title: r.title, publishedNow, visibleFromUtc };
  });
}

async function loadSubprocessors(): Promise<LegacySubprocessorFact[]> {
  const rows = await readOnlyInventoryRead((tx) =>
    tx.$queryRaw<SubprocessorRow[]>`
      SELECT team_id, name, category, country, state, created_at FROM subprocessors`,
  );
  return rows.map((r) => ({
    teamId: r.team_id,
    name: r.name,
    category: r.category,
    country: r.country,
    activeNow: r.state === "ACTIVE",
    createdAtUtc: r.created_at,
  }));
}

async function packagePage(cursor: string | null, take: number, since: Date | null, until: Date): Promise<PackageRow[]> {
  return readOnlyInventoryRead((tx) =>
    tx.$queryRaw<PackageRow[]>`
      SELECT vp.id, vp.evidence_id, e.team_id, vp.version, vp.disclosure_profile,
             COALESCE(vp.generated_at_utc, vp.created_at) AS generated_at,
             (vp.generated_at_utc IS NOT NULL) AS generated_at_recorded
        FROM verification_packages vp
        JOIN evidence e ON e.id = vp.evidence_id
       WHERE vp.state = 'PUBLISHED'
         AND e.team_id IS NOT NULL
         AND COALESCE(vp.generated_at_utc, vp.created_at) <= ${until}
         AND (${since}::timestamptz IS NULL OR COALESCE(vp.generated_at_utc, vp.created_at) >= ${since}::timestamptz)
         AND (${cursor}::uuid IS NULL OR vp.id > ${cursor}::uuid)
       ORDER BY vp.id ASC
       LIMIT ${take}`,
  );
}

/** How far each record's packages travelled: recorded downloads and package links. Counts only. */
async function accessFacts(evidenceIds: string[]): Promise<Map<string, AccessRow>> {
  if (evidenceIds.length === 0) return new Map();
  const rows = await readOnlyInventoryRead((tx) =>
    tx.$queryRaw<AccessRow[]>`
      SELECT e.id AS evidence_id,
             (SELECT count(*) FROM custody_events c
               WHERE c.evidence_id = e.id AND c.event_type::text = 'VERIFICATION_PACKAGE_DOWNLOADED') AS downloads,
             (SELECT count(*) FROM verification_share_tokens t
               WHERE t.evidence_id = e.id AND t.purpose = 'PACKAGE' AND t.revoked_at_utc IS NULL
                 AND (t.expires_at_utc IS NULL OR t.expires_at_utc > now())) AS live_package_links,
             (SELECT count(*) FROM verification_share_tokens t
               WHERE t.evidence_id = e.id AND t.purpose = 'PACKAGE') AS package_links
        FROM evidence e
       WHERE e.id = ANY(${evidenceIds}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.evidence_id, r]));
}

export type LegacyManifestExposureFinding = {
  packageId: string;
  evidenceId: string;
  teamId: string;
  version: number;
  disclosureProfile: string;
  generatedAtUtc: string;
  generatedAtRecorded: boolean;
  exposure: LegacyExposureClass;
  foreignArticleRows: number;
  foreignSubprocessorRows: number;
  distinctForeignArticles: number;
  distinctForeignSubprocessors: number;
  possibleWithdrawnForeignRows: number;
  sourceTeamIds: string[];
  recordedPackageDownloads: number;
  livePackageLinks: number;
  packageLinksEver: number;
};


export type LegacyManifestExposureInventory = {
  packagesScanned: number;
  truncatedAtLimit: boolean;
  byExposure: Record<LegacyExposureClass, number>;
  findings: LegacyManifestExposureFinding[];
  rowsReplayed: { articles: number; subprocessors: number };
};

/** Collect the inventory. Reads only. */
export async function collectLegacyManifestExposureInventory(options: {
  since: Date | null;
  until: Date;
  batch?: number;
  limit?: number;
}): Promise<LegacyManifestExposureInventory> {
  const batch = Math.max(1, Math.min(options.batch ?? 500, 2000));
  const limit = Math.max(1, options.limit ?? 1_000_000);
  const articles = await loadArticles();
  const subprocessors = await loadSubprocessors();
  const index = buildLegacyExposureIndex({ articles, subprocessors });

  const findings: LegacyManifestExposureFinding[] = [];
  const byExposure: Record<LegacyExposureClass, number> = {
    FOREIGN_DISTINCT: 0,
    FOREIGN_DUPLICATE_ONLY: 0,
    POSSIBLE_WITHDRAWN_ONLY: 0,
    NONE: 0,
  };
  let scanned = 0;
  let cursor: string | null = null;
  while (scanned < limit) {
    const rows = await packagePage(cursor, Math.min(batch, limit - scanned), options.since, options.until);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    scanned += rows.length;
    const replayed = rows.map((row) => ({
      row,
      result: replayLegacyManifestExposure(index, { teamId: row.team_id, generatedAtUtc: row.generated_at }),
    }));
    for (const r of replayed) byExposure[r.result.exposure] += 1;
    const affected = replayed.filter((r) => r.result.exposure !== "NONE");
    const access = await accessFacts([...new Set(affected.map((r) => r.row.evidence_id))]);
    for (const { row, result } of affected) {
      const a = access.get(row.evidence_id);
      findings.push({
        packageId: row.id,
        evidenceId: row.evidence_id,
        teamId: row.team_id,
        version: row.version,
        disclosureProfile: row.disclosure_profile ?? "LEGACY_PRIMARY",
        generatedAtUtc: row.generated_at.toISOString(),
        generatedAtRecorded: row.generated_at_recorded,
        ...result,
        recordedPackageDownloads: Number(a?.downloads ?? 0),
        livePackageLinks: Number(a?.live_package_links ?? 0),
        packageLinksEver: Number(a?.package_links ?? 0),
      });
    }
    if (rows.length < batch) break;
  }
  return {
    packagesScanned: scanned,
    truncatedAtLimit: scanned >= limit,
    byExposure,
    findings,
    rowsReplayed: { articles: articles.length, subprocessors: subprocessors.length },
  };
}
