/**
 * PRO-G2-01 — the old Worker builder's rule, replayed (pure).
 *
 * At cdcb8aef8 the package manifests were built from unscoped reads: every
 * tenant's PUBLISHED trust / methodology / AI-disclosure articles and every
 * ACTIVE subprocessor. `replayLegacyManifestExposure` answers, for a package
 * of team T generated at time t, which OTHER teams' rows those reads returned.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildLegacyExposureIndex,
  replayLegacyManifestExposure,
  type LegacyArticleFact,
  type LegacySubprocessorFact,
} from "../src/services/trust/legacy-trust-manifest-exposure.js";

const here = dirname(fileURLToPath(import.meta.url));
const T = (iso: string) => new Date(iso);
const A = "team-a";
const B = "team-b";
const C = "team-c";

const article = (over: Partial<LegacyArticleFact>): LegacyArticleFact => ({
  teamId: A,
  kind: "TRUST_CENTER",
  section: "security",
  slug: "encryption",
  title: "Encryption",
  publishedNow: true,
  visibleFromUtc: T("2026-06-01T00:00:00Z"),
  ...over,
});
const sub = (over: Partial<LegacySubprocessorFact>): LegacySubprocessorFact => ({
  teamId: A,
  name: "Cloud host",
  category: "PROVIDER",
  country: "DE",
  activeNow: true,
  createdAtUtc: T("2026-06-01T00:00:00Z"),
  ...over,
});
const at = T("2026-07-01T00:00:00Z");

describe("PRO-G2-01 — replay of the unscoped package manifest reads", () => {
  it("only the team's own rows: nothing foreign was embedded", () => {
    const index = buildLegacyExposureIndex({ articles: [article({})], subprocessors: [sub({})] });
    expect(replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at })).toEqual({
      exposure: "NONE",
      foreignArticleRows: 0,
      foreignSubprocessorRows: 0,
      distinctForeignArticles: 0,
      distinctForeignSubprocessors: 0,
      possibleWithdrawnForeignRows: 0,
      sourceTeamIds: [],
    });
  });

  it("another team's copy of content this team also holds is foreign but not distinct (the canonical seed)", () => {
    const index = buildLegacyExposureIndex({
      articles: [article({}), article({ teamId: B }), article({ teamId: C })],
      subprocessors: [sub({}), sub({ teamId: B })],
    });
    const out = replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at });
    expect(out.exposure).toBe("FOREIGN_DUPLICATE_ONLY");
    expect(out.foreignArticleRows).toBe(2);
    expect(out.foreignSubprocessorRows).toBe(1);
    expect(out.distinctForeignArticles).toBe(0);
    expect(out.sourceTeamIds).toEqual([]);
  });

  it("another tenant's own article title and subprocessor are distinct, and their team is the source", () => {
    const index = buildLegacyExposureIndex({
      articles: [article({}), article({ teamId: B, slug: "b-programme", title: "B's unannounced programme" })],
      subprocessors: [sub({}), sub({ teamId: C, name: "C's niche vendor" })],
    });
    const out = replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at });
    expect(out.exposure).toBe("FOREIGN_DISTINCT");
    expect(out.distinctForeignArticles).toBe(1);
    expect(out.distinctForeignSubprocessors).toBe(1);
    expect(out.sourceTeamIds).toEqual([B, C]);
    // The same rows are NOT foreign to their own team's package.
    expect(replayLegacyManifestExposure(index, { teamId: B, generatedAtUtc: at }).sourceTeamIds).not.toContain(B);
  });

  it("the trust manifest disclosed the title; methodology and AI-disclosure disclosed section and slug only", () => {
    const index = buildLegacyExposureIndex({
      articles: [
        // Same section+slug, different title: distinct for TRUST_CENTER...
        article({}),
        article({ teamId: B, title: "Encryption (B's wording)" }),
        // ...but not for METHODOLOGY, whose manifest carried no title.
        article({ kind: "METHODOLOGY", slug: "m" }),
        article({ teamId: B, kind: "METHODOLOGY", slug: "m", title: "anything" }),
      ],
      subprocessors: [],
    });
    const out = replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at });
    expect(out.foreignArticleRows).toBe(2);
    expect(out.distinctForeignArticles).toBe(1);
  });

  it("kinds the old builder never read are ignored (STATUS, drafts with no publication)", () => {
    const index = buildLegacyExposureIndex({
      articles: [
        article({ teamId: B, kind: "SECURITY", slug: "x", title: "x" }),
        article({ teamId: B, slug: "draft", title: "draft", publishedNow: false, visibleFromUtc: null }),
      ],
      subprocessors: [],
    });
    expect(replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at }).exposure).toBe("NONE");
  });

  it("a row published or created AFTER the package was generated was not in it", () => {
    const index = buildLegacyExposureIndex({
      articles: [article({ teamId: B, slug: "later", title: "later", visibleFromUtc: T("2026-08-01T00:00:00Z") })],
      subprocessors: [sub({ teamId: B, name: "later vendor", createdAtUtc: T("2026-08-01T00:00:00Z") })],
    });
    expect(replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at }).exposure).toBe("NONE");
    expect(replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: T("2026-09-01T00:00:00Z") }).exposure).toBe("FOREIGN_DISTINCT");
  });

  it("a row withdrawn since is a possible inclusion, reported apart and still naming its team", () => {
    const index = buildLegacyExposureIndex({
      articles: [article({ teamId: B, slug: "gone", title: "gone", publishedNow: false })],
      subprocessors: [sub({ teamId: C, name: "retired vendor", activeNow: false })],
    });
    const out = replayLegacyManifestExposure(index, { teamId: A, generatedAtUtc: at });
    expect(out.exposure).toBe("POSSIBLE_WITHDRAWN_ONLY");
    expect(out.foreignArticleRows).toBe(0);
    expect(out.possibleWithdrawnForeignRows).toBe(2);
    expect(out.sourceTeamIds).toEqual([B, C]);
  });
});

describe("PRO-G2-01 — the inventory has no write path", () => {
  const read = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");
  const reader = read("services/trust/legacy-trust-manifest-exposure-inventory.ts");
  const script = read("scripts/trust-manifest-exposure-inventory.ts");

  it("every database statement goes through the READ ONLY transaction, and none is a write", () => {
    expect(reader).toContain('"SET TRANSACTION READ ONLY"');
    // The only raw execute is the READ ONLY switch itself.
    expect(reader.match(/\$executeRaw(Unsafe)?\b/g)?.length).toBe(2); // the type and the one call
    // No model writes, no queue, no object store, no mail.
    for (const src of [reader, script]) {
      expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
      expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b\s/);
      expect(src).not.toMatch(/from "[^"]*(storage|bullmq|queue|resend|notifications|twilio|stripe)[^"]*"/i);
    }
    // Reads never bypass the guard.
    expect(reader.match(/prisma\.\$queryRaw/g) ?? []).toHaveLength(0);
  });

  it("the script refuses any flag that sounds like acting", () => {
    for (const flag of ["apply", "write", "fix", "execute", "notify", "revoke", "reissue"]) {
      expect(script).toContain(`"${flag}"`);
    }
    expect(script).toContain("has no write mode");
  });
});
