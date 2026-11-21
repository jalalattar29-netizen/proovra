/**
 * PRO-G2-01 — GROUND-TRUTH SAMPLE INSPECTION of issued packages. READ-ONLY.
 * RESTRICTED OUTPUT.
 *
 *   node dist/scripts/trust-manifest-sample-inspection.js --packages=<uuid>,<uuid>,...   (at most 50)
 *
 * For each given verification package it reads the EXACT stored version
 * (storage_bucket / storage_key / s3_version_id) through RANGE reads of the ZIP
 * (tail, central directory, and only the four `intelligence/*.json` trust
 * manifests), in memory. Nothing is written: no file is saved, no row, no
 * custody event, no link. The ZIP is never read whole and no other entry is
 * decompressed.
 *
 * It prints, per package, which Trust Center / methodology / AI-disclosure
 * articles and which subprocessor rows the stored manifests carry, and for
 * each whether it belongs to the package's own workspace (OWN), only to other
 * workspaces (FOREIGN: article ids, owning workspace ids and the trust-article
 * TITLE as stored), or to no row that exists now (UNMATCHED: deleted since).
 * Subprocessors are printed by row id and owning workspace only (no name).
 * `observedClass` is FOREIGN_PRESENT when anything FOREIGN is carried, so the
 * replay inventory's prediction can be checked (handoff WS-OUT 7.2: record the
 * false-negative rate).
 *
 * The output names other tenants' article titles: RESTRICTED. Keep it with the
 * incident record; never in a delivery bundle or a customer message.
 */
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

import { readPackageTrustManifests, type RangeReader } from "../services/trust/package-manifest-inspection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED = ["apply", "write", "fix", "execute", "notify", "revoke", "reissue", "save", "download", "out"];
export const MAX_SAMPLE_PACKAGES = 50;

export type SampleStorage = {
  head: (p: { bucket: string; key: string; versionId: string | null }) => Promise<{ sizeBytes: number | null }>;
  range: (p: { bucket: string; key: string; versionId: string | null; range: string }) => Promise<Buffer>;
};

export type SampleCliIo = {
  argv: string[];
  client: PrismaClient;
  storage: SampleStorage;
  out: (s: string) => void;
  err: (s: string) => void;
};

type PkgRow = {
  id: string;
  evidence_id: string;
  team_id: string | null;
  version: number;
  disclosure_profile: string | null;
  storage_bucket: string;
  storage_key: string;
  s3_version_id: string | null;
  generated_at: Date;
};
type ArticleRow = { id: string; team_id: string; kind: string; section: string; slug: string; title: string; state: string };
type SubRow = { id: string; team_id: string; state: string };

async function readOnly<T>(client: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return fn(tx as unknown as PrismaClient);
  });
}

export async function runTrustManifestSampleInspectionCli(io: SampleCliIo): Promise<number> {
  let ids: string[] = [];
  for (const a of io.argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m && REFUSED.includes(m[1]!)) {
      io.err(`refused: --${m[1]} is not supported: this inspection is read-only and saves nothing.\n`);
      return 2;
    }
    if (m?.[1] === "packages" && m[2] !== undefined) ids.push(...m[2].split(",").map((s) => s.trim()).filter(Boolean));
    else if (m?.[1] === "package" && m[2] !== undefined) ids.push(m[2].trim());
    else {
      io.err(`refused: unknown argument ${a.split("=")[0]}\n`);
      return 2;
    }
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) {
    io.err("usage: trust-manifest-sample-inspection --packages=<uuid>,<uuid>,...\n");
    return 2;
  }
  if (ids.length > MAX_SAMPLE_PACKAGES) {
    io.err(`refused: at most ${MAX_SAMPLE_PACKAGES} packages per run\n`);
    return 2;
  }
  const bad = ids.filter((i) => !UUID.test(i));
  if (bad.length) {
    io.err(`refused: not package ids: ${bad.length} value(s)\n`);
    return 2;
  }

  const { rows, articles, subs } = await readOnly(io.client, async (tx) => {
    const rows = await tx.$queryRaw<PkgRow[]>`
      SELECT vp.id::text AS id, vp.evidence_id::text AS evidence_id, e.team_id::text AS team_id, vp.version,
             vp.disclosure_profile, vp.storage_bucket, vp.storage_key, vp.s3_version_id,
             COALESCE(vp.generated_at_utc, vp.created_at) AS generated_at
        FROM verification_packages vp JOIN evidence e ON e.id = vp.evidence_id
       WHERE vp.id = ANY(${ids}::uuid[])`;
    const articles = await tx.$queryRaw<ArticleRow[]>`
      SELECT id::text AS id, team_id::text AS team_id, kind::text AS kind, section, slug, title, state::text AS state
        FROM trust_center_articles WHERE kind::text IN ('TRUST_CENTER', 'METHODOLOGY', 'AI_DISCLOSURE')`;
    const subs = await tx.$queryRaw<SubRow[]>`SELECT id::text AS id, team_id::text AS team_id, state::text AS state FROM subprocessors`;
    return { rows, articles, subs };
  });

  const articleIndex = new Map<string, ArticleRow[]>();
  const keyOf = (kind: string, section: string, slug: string, title: string | null) =>
    kind === "TRUST_CENTER" ? JSON.stringify([kind, section, slug, title]) : JSON.stringify([kind, section, slug]);
  for (const a of articles) {
    const k = keyOf(a.kind, a.section, a.slug, a.title);
    articleIndex.set(k, [...(articleIndex.get(k) ?? []), a]);
  }
  const subIndex = new Map(subs.map((s) => [s.id, s]));

  const results: unknown[] = [];
  let failures = 0;
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) {
      results.push({ packageId: id, outcome: "NOT_FOUND_IN_DATABASE" });
      failures++;
      continue;
    }
    try {
      const where = { bucket: row.storage_bucket, key: row.storage_key, versionId: row.s3_version_id };
      const head = await io.storage.head(where);
      if (!head.sizeBytes || head.sizeBytes <= 0) throw new Error("empty or missing object");
      const reader: RangeReader = {
        size: head.sizeBytes,
        read: (a, b) => io.storage.range({ ...where, range: `bytes=${a}-${b}` }),
      };
      const m = await readPackageTrustManifests(reader);
      const articleFindings = m.articles.map((a) => {
        const matches = articleIndex.get(keyOf(a.kind, a.section, a.slug, a.title)) ?? [];
        const own = matches.some((x) => x.team_id === row.team_id);
        const attribution = own ? "OWN" : matches.length > 0 ? "FOREIGN" : "UNMATCHED";
        return {
          kind: a.kind,
          section: a.section,
          slug: a.slug,
          attribution,
          ...(attribution === "FOREIGN"
            ? { title: a.title, foreignArticleIds: matches.map((x) => x.id), foreignTeamIds: [...new Set(matches.map((x) => x.team_id))] }
            : {}),
        };
      });
      const subFindings = m.subprocessors.map((s) => {
        const hit = subIndex.get(s.rowId);
        const attribution = !hit ? "UNMATCHED" : hit.team_id === row.team_id ? "OWN" : "FOREIGN";
        return { rowId: s.rowId, attribution, ...(hit && attribution === "FOREIGN" ? { owningTeamId: hit.team_id } : {}) };
      });
      const foreign = articleFindings.filter((a) => a.attribution === "FOREIGN").length + subFindings.filter((s) => s.attribution === "FOREIGN").length;
      results.push({
        packageId: row.id,
        evidenceId: row.evidence_id,
        packageTeamId: row.team_id,
        version: row.version,
        disclosureProfile: row.disclosure_profile ?? "LEGACY_PRIMARY",
        generatedAtUtc: row.generated_at.toISOString(),
        outcome: "READ",
        manifestsPresent: m.present,
        observedClass: m.present.length === 0 ? "NO_TRUST_MANIFESTS" : foreign > 0 ? "FOREIGN_PRESENT" : "NO_FOREIGN_ROWS",
        counts: {
          articles: articleFindings.length,
          foreignArticles: articleFindings.filter((a) => a.attribution === "FOREIGN").length,
          unmatchedArticles: articleFindings.filter((a) => a.attribution === "UNMATCHED").length,
          subprocessors: subFindings.length,
          foreignSubprocessors: subFindings.filter((s) => s.attribution === "FOREIGN").length,
          unmatchedSubprocessors: subFindings.filter((s) => s.attribution === "UNMATCHED").length,
          activeSubprocessorCountStated: m.activeSubprocessorCount,
        },
        articles: articleFindings.filter((a) => a.attribution !== "OWN"),
        subprocessors: subFindings.filter((s) => s.attribution !== "OWN"),
      });
    } catch (e) {
      failures++;
      results.push({ packageId: row.id, outcome: "UNREADABLE", reason: e instanceof Error ? e.name : "error" });
    }
  }
  io.out(
    `${JSON.stringify(
      {
        script: "trust-manifest-sample-inspection",
        classification: "RESTRICTED",
        readOnly: true,
        evidenceBasis: "STORED_ARTIFACT_CONTENTS",
        packages: results,
        note: "OWN rows are counted, not listed. UNMATCHED = no row with that content exists now (deleted since).",
      },
      null,
      2,
    )}\n`,
  );
  return failures > 0 ? 3 : 0;
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  // Loaded on first use: the storage client needs the S3 configuration, and a refused argument should not.
  const storage = () => import("../storage.js");
  try {
    process.exitCode = await runTrustManifestSampleInspectionCli({
      argv: process.argv.slice(2),
      client: prisma,
      storage: {
        head: async (p) => ({ sizeBytes: (await (await storage()).headObject(p)).sizeBytes ?? null }),
        range: async (p) => (await storage()).getObjectRange(p),
      },
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`trust-manifest-sample-inspection failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
