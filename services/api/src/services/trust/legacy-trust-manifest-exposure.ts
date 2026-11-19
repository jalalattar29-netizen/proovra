/**
 * PRO-G2-01 — HISTORICAL EXPOSURE, REPLAYED (pure; no I/O).
 *
 * Until the fix (0db8a7c9e) the Worker built a team-stamped verification
 * package's `intelligence/*.json` manifests with FOUR UNSCOPED reads
 * (services/worker/src/verification-package-trust-and-governance.ts at
 * cdcb8aef8):
 *
 *   trustCenterArticle.findMany({ kind: "TRUST_CENTER",  state: "PUBLISHED" })  -> section, slug, title
 *   trustCenterArticle.findMany({ kind: "METHODOLOGY",   state: "PUBLISHED" })  -> section, slug
 *   trustCenterArticle.findMany({ kind: "AI_DISCLOSURE", state: "PUBLISHED" })  -> section, slug
 *   subprocessor.findMany({ state: "ACTIVE" })                                  -> id, name, category, country
 *   subprocessor.count({ state: "ACTIVE" })
 *
 * No `teamId`, no `take`: every tenant's rows that were PUBLISHED / ACTIVE at
 * the moment of generation went into the package of whichever team's record
 * was being packaged. Issued packages are never rewritten, so the exposure is
 * whatever those reads returned then.
 *
 * This module replays that rule for a package generated at a known time, from
 * the rows that exist NOW. It cannot see the past exactly:
 *
 *   - a row counts as CURRENT when it is PUBLISHED / ACTIVE now and existed
 *     (was published / created) at or before the package's generation time;
 *   - a row counts as WITHDRAWN_SINCE when it is no longer PUBLISHED / ACTIVE
 *     but history says it was at some time at or before generation (its end
 *     time is not recorded, so it is a POSSIBLE inclusion, reported apart);
 *   - a row deleted outright since then is invisible here. The only complete
 *     answer for one package is the package's own `intelligence/*.json`.
 *
 * So the result is an inventory of packages the old rule WOULD have filled
 * with other teams' rows, not a proof of containment for the rest.
 */

export const LEGACY_MANIFEST_ARTICLE_KINDS = ["TRUST_CENTER", "METHODOLOGY", "AI_DISCLOSURE"] as const;
export type LegacyManifestArticleKind = (typeof LEGACY_MANIFEST_ARTICLE_KINDS)[number];

export type LegacyArticleFact = {
  teamId: string;
  kind: string;
  section: string;
  slug: string;
  title: string;
  /** PUBLISHED now. */
  publishedNow: boolean;
  /** When it became visible to the unscoped read (published, else created). Null = never published. */
  visibleFromUtc: Date | null;
};

export type LegacySubprocessorFact = {
  teamId: string;
  name: string;
  category: string;
  country: string | null;
  /** ACTIVE now. */
  activeNow: boolean;
  createdAtUtc: Date;
};

export type LegacyPackageFact = {
  teamId: string;
  generatedAtUtc: Date;
};

export type LegacyExposureClass =
  /** The old rule returned only this team's rows: nothing foreign embedded. */
  | "NONE"
  /** Foreign rows were embedded, but each repeats content this team also holds (e.g. the canonical seed every workspace carries). */
  | "FOREIGN_DUPLICATE_ONLY"
  /** At least one embedded foreign row carries content this team does not hold: another tenant's own article title / subprocessor. */
  | "FOREIGN_DISTINCT"
  /** Nothing CURRENT is foreign, but rows withdrawn since may have been embedded. */
  | "POSSIBLE_WITHDRAWN_ONLY";

export type LegacyPackageExposure = {
  exposure: LegacyExposureClass;
  /** Rows of other teams the old reads returned (still PUBLISHED / ACTIVE now). */
  foreignArticleRows: number;
  foreignSubprocessorRows: number;
  /** Of those, distinct pieces of content the package's team does not itself hold. */
  distinctForeignArticles: number;
  distinctForeignSubprocessors: number;
  /** Other teams' rows withdrawn since (possible inclusions; end time unknown). */
  possibleWithdrawnForeignRows: number;
  /** Teams whose DISTINCT content (current or withdrawn) reached this package. Sorted. */
  sourceTeamIds: string[];
};

type Timed = { teamId: string; at: number; current: boolean };

export type LegacyExposureIndex = {
  /** content key -> the rows carrying it, any team. */
  articles: Map<string, Timed[]>;
  subprocessors: Map<string, Timed[]>;
};

function isLegacyKind(kind: string): kind is LegacyManifestArticleKind {
  return (LEGACY_MANIFEST_ARTICLE_KINDS as readonly string[]).includes(kind);
}

/**
 * What the old manifest disclosed about an article: trust-manifest.json
 * carried section, slug AND title; the methodology and AI-disclosure
 * manifests carried section and slug only.
 */
export function legacyArticleContentKey(row: Pick<LegacyArticleFact, "kind" | "section" | "slug" | "title">): string {
  return row.kind === "TRUST_CENTER"
    ? JSON.stringify([row.kind, row.section, row.slug, row.title])
    : JSON.stringify([row.kind, row.section, row.slug]);
}

/**
 * What subprocessor-manifest.json disclosed besides the row's own id (which
 * is always the foreign row's id): name, category ("vendor") and country.
 */
export function legacySubprocessorContentKey(row: Pick<LegacySubprocessorFact, "name" | "category" | "country">): string {
  return JSON.stringify([row.name, row.category, row.country ?? null]);
}

export function buildLegacyExposureIndex(input: {
  articles: readonly LegacyArticleFact[];
  subprocessors: readonly LegacySubprocessorFact[];
}): LegacyExposureIndex {
  const articles = new Map<string, Timed[]>();
  for (const a of input.articles) {
    if (!isLegacyKind(a.kind) || !a.visibleFromUtc) continue;
    const key = legacyArticleContentKey(a);
    const list = articles.get(key) ?? [];
    list.push({ teamId: a.teamId, at: a.visibleFromUtc.getTime(), current: a.publishedNow });
    articles.set(key, list);
  }
  const subprocessors = new Map<string, Timed[]>();
  for (const s of input.subprocessors) {
    const key = legacySubprocessorContentKey(s);
    const list = subprocessors.get(key) ?? [];
    list.push({ teamId: s.teamId, at: s.createdAtUtc.getTime(), current: s.activeNow });
    subprocessors.set(key, list);
  }
  return { articles, subprocessors };
}

function tally(index: Map<string, Timed[]>, teamId: string, at: number) {
  let foreignRows = 0;
  let distinct = 0;
  let withdrawn = 0;
  const sources = new Set<string>();
  for (const rows of index.values()) {
    let ownHolds = false;
    let foreignCurrent = 0;
    const foreignTeams: string[] = [];
    let foreignWithdrawn = 0;
    for (const r of rows) {
      if (r.at > at) continue;
      if (r.teamId === teamId) {
        // The team's own copy at that time (current or since withdrawn) means
        // the foreign copy told the package's reader nothing new.
        ownHolds = true;
        continue;
      }
      if (r.current) foreignCurrent += 1;
      else foreignWithdrawn += 1;
      foreignTeams.push(r.teamId);
    }
    foreignRows += foreignCurrent;
    withdrawn += foreignWithdrawn;
    if (!ownHolds && foreignTeams.length > 0) {
      if (foreignCurrent > 0) distinct += 1;
      for (const t of foreignTeams) sources.add(t);
    }
  }
  return { foreignRows, distinct, withdrawn, sources };
}

/** Replay the old unscoped reads for one package. */
export function replayLegacyManifestExposure(index: LegacyExposureIndex, pkg: LegacyPackageFact): LegacyPackageExposure {
  const at = pkg.generatedAtUtc.getTime();
  const a = tally(index.articles, pkg.teamId, at);
  const s = tally(index.subprocessors, pkg.teamId, at);
  const sourceTeamIds = [...new Set([...a.sources, ...s.sources])].sort();
  const possibleWithdrawnForeignRows = a.withdrawn + s.withdrawn;
  let exposure: LegacyExposureClass = "NONE";
  if (a.distinct + s.distinct > 0) exposure = "FOREIGN_DISTINCT";
  else if (a.foreignRows + s.foreignRows > 0) exposure = "FOREIGN_DUPLICATE_ONLY";
  else if (possibleWithdrawnForeignRows > 0) exposure = "POSSIBLE_WITHDRAWN_ONLY";
  return {
    exposure,
    foreignArticleRows: a.foreignRows,
    foreignSubprocessorRows: s.foreignRows,
    distinctForeignArticles: a.distinct,
    distinctForeignSubprocessors: s.distinct,
    possibleWithdrawnForeignRows,
    sourceTeamIds,
  };
}
