/**
 * PRO-G2-01 — the historical-exposure inventory, on live PostgreSQL 16.
 *
 * The inventory replays the OLD Worker builder's unscoped reads for issued
 * packages. This file proves, against the real schema:
 *   - a team package generated while another team had a published article and
 *     an active subprocessor of its own is listed, naming that team as source;
 *   - a package generated before those rows existed is not attributed to them;
 *   - the `until` bound (the fixed Worker's deploy time) excludes later packages;
 *   - a row withdrawn since is reported as a POSSIBLE inclusion, apart;
 *   - the reader CANNOT write: the database refuses it.
 *
 * Other suites share this database, so every assertion is scoped to the rows
 * this file created (global counts are lower bounds only).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-G2-01 trust-manifest exposure inventory (live PostgreSQL 16, read-only)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let inventory: typeof import("../src/services/trust/legacy-trust-manifest-exposure-inventory.js");

  const tag = randomUUID().slice(0, 8);
  const created = { evidence: [] as string[], articles: [] as string[], subprocessors: [] as string[], tokens: [] as string[] };
  const T0 = new Date("2026-06-10T00:00:00.000Z"); // team B's rows exist from here
  const BEFORE = new Date("2026-06-01T00:00:00.000Z");
  const DURING = new Date("2026-07-01T00:00:00.000Z");
  const AFTER_FIX = new Date("2026-12-01T00:00:00.000Z");
  const FIX_DEPLOYED = new Date("2026-11-20T00:00:00.000Z");
  let pkgBefore = "";
  let pkgDuring = "";
  let pkgAfterFix = "";
  let pkgOfB = "";

  const A = () => harness.fixtures.teamA;
  const B = () => harness.fixtures.teamB;

  async function evidence(teamId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: `g2-01 inventory ${tag}`,
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: "ACTIVE" as never,
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        sizeBytes: 5_000n,
      },
      select: { id: true },
    });
    created.evidence.push(row.id);
    return row.id;
  }
  async function pkg(evidenceId: string, version: number, generatedAtUtc: Date, disclosureProfile: string | null = null): Promise<string> {
    const row = await prisma.verificationPackage.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `verification/${evidenceId}/v${version}-${disclosureProfile ?? "primary"}.zip`,
        generatedAtUtc,
        sizeBytes: 9_000n,
        reportVersion: null,
        disclosureProfile,
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    inventory = await import("../src/services/trust/legacy-trust-manifest-exposure-inventory.js");

    // Team B's OWN content: a published trust article, a withdrawn one with a
    // published version in its history, and an active subprocessor.
    const article = await prisma.trustCenterArticle.create({
      data: {
        teamId: B().teamId, kind: "TRUST_CENTER", section: "custom", slug: `b-own-${tag}`, state: "PUBLISHED",
        title: `Team B private programme ${tag}`, summary: "s", body: "b", publishedAtUtc: T0, createdAt: T0,
      },
      select: { id: true },
    });
    const withdrawn = await prisma.trustCenterArticle.create({
      data: {
        teamId: B().teamId, kind: "METHODOLOGY", section: "custom", slug: `b-withdrawn-${tag}`, state: "DEPRECATED",
        title: `Team B withdrawn ${tag}`, summary: "s", body: "b", publishedAtUtc: null, createdAt: T0,
      },
      select: { id: true },
    });
    await prisma.trustCenterArticleVersion.create({
      data: {
        articleId: withdrawn.id, version: 1, body: "b", teamId: B().teamId, title: `Team B withdrawn ${tag}`, summary: "s",
        state: "PUBLISHED", authoredByUserId: B().ownerUserId, publishedAtUtc: T0, createdAt: T0,
      },
    });
    created.articles.push(article.id, withdrawn.id);
    const sub = await prisma.subprocessor.create({
      data: {
        teamId: B().teamId, name: `Team B vendor ${tag}`, slug: `b-vendor-${tag}`, vendor: "v", purpose: "p", region: "EU",
        dataCategories: [], changeHistorySummary: "c", state: "ACTIVE", createdAt: T0,
      },
      select: { id: true },
    });
    created.subprocessors.push(sub.id);

    const evA = await evidence(A().teamId);
    pkgBefore = await pkg(evA, 1, BEFORE);
    pkgDuring = await pkg(evA, 2, DURING);
    pkgAfterFix = await pkg(evA, 3, AFTER_FIX);
    // An EXTERNAL_DISCLOSURE companion of v2 is its own issued artifact.
    await pkg(evA, 2, DURING, "EXTERNAL_DISCLOSURE");
    const token = await prisma.verificationShareToken.create({
      data: { evidenceId: evA, teamId: A().teamId, tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"), purpose: "PACKAGE", reportVersion: 2 },
      select: { id: true },
    });
    created.tokens.push(token.id);
    const evB = await evidence(B().teamId);
    pkgOfB = await pkg(evB, 1, DURING);
  }, 180_000);

  afterAll(async () => {
    await prisma?.verificationShareToken.deleteMany({ where: { id: { in: created.tokens } } }).catch(() => undefined);
    await prisma?.verificationPackage.deleteMany({ where: { evidenceId: { in: created.evidence } } }).catch(() => undefined);
    await prisma?.subprocessor.deleteMany({ where: { id: { in: created.subprocessors } } }).catch(() => undefined);
    await prisma?.trustCenterArticle.deleteMany({ where: { id: { in: created.articles } } }).catch(() => undefined);
    await prisma?.evidence.updateMany({ where: { id: { in: created.evidence } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    await harness?.cleanup();
  });

  it("lists the package built while another team's own rows were published, and names that team as a source", async () => {
    const out = await inventory.collectLegacyManifestExposureInventory({ since: null, until: FIX_DEPLOYED, batch: 2 });
    const during = out.findings.find((f) => f.packageId === pkgDuring);
    expect(during, "the package generated in the window is listed").toBeTruthy();
    expect(during!.exposure).toBe("FOREIGN_DISTINCT");
    expect(during!.teamId).toBe(A().teamId);
    expect(during!.sourceTeamIds).toContain(B().teamId);
    expect(during!.sourceTeamIds).not.toContain(A().teamId);
    expect(during!.distinctForeignArticles).toBeGreaterThanOrEqual(1);
    expect(during!.distinctForeignSubprocessors).toBeGreaterThanOrEqual(1);
    // The withdrawn article is a possible inclusion, counted apart.
    expect(during!.possibleWithdrawnForeignRows).toBeGreaterThanOrEqual(1);
    // How far it travelled: the live package link on the record.
    expect(during!.livePackageLinks).toBe(1);
    expect(during!.disclosureProfile).toBe("LEGACY_PRIMARY");
    // The EXTERNAL_DISCLOSURE companion is its own row in the inventory.
    expect(out.findings.some((f) => f.evidenceId === during!.evidenceId && f.disclosureProfile === "EXTERNAL_DISCLOSURE" && f.version === 2)).toBe(true);
    // Paging (batch 2) reached every package of this file inside the window.
    expect(out.packagesScanned).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("does not attribute rows that did not exist yet, and team B's own package is not exposed to team B", async () => {
    const out = await inventory.collectLegacyManifestExposureInventory({ since: null, until: FIX_DEPLOYED });
    const before = out.findings.find((f) => f.packageId === pkgBefore);
    // Listed only if some OTHER suite's rows predate it; never because of team B's rows of this file.
    expect(before?.sourceTeamIds ?? []).not.toContain(B().teamId);
    const ofB = out.findings.find((f) => f.packageId === pkgOfB);
    expect(ofB?.sourceTeamIds ?? []).not.toContain(B().teamId);
  }, 120_000);

  it("honours the window: a package generated after the fixed Worker went live is outside it", async () => {
    const bounded = await inventory.collectLegacyManifestExposureInventory({ since: null, until: FIX_DEPLOYED });
    expect(bounded.findings.some((f) => f.packageId === pkgAfterFix)).toBe(false);
    const unbounded = await inventory.collectLegacyManifestExposureInventory({ since: null, until: new Date("2027-01-01T00:00:00.000Z") });
    expect(unbounded.findings.some((f) => f.packageId === pkgAfterFix)).toBe(true);
    const late = await inventory.collectLegacyManifestExposureInventory({ since: new Date("2026-06-15T00:00:00.000Z"), until: FIX_DEPLOYED });
    expect(late.findings.some((f) => f.packageId === pkgBefore)).toBe(false);
    expect(late.findings.some((f) => f.packageId === pkgDuring)).toBe(true);
  }, 120_000);

  it("cannot write: the database refuses any write inside the inventory's reader", async () => {
    const before = await prisma.verificationPackage.findUniqueOrThrow({ where: { id: pkgDuring }, select: { updatedAt: true, state: true } });
    await expect(
      inventory.readOnlyInventoryRead((tx) =>
        tx.$executeRawUnsafe(`UPDATE verification_packages SET state = 'FAILED' WHERE id = '${pkgDuring}'::uuid`),
      ),
    ).rejects.toThrow(/read-only/i);
    const after = await prisma.verificationPackage.findUniqueOrThrow({ where: { id: pkgDuring }, select: { updatedAt: true, state: true } });
    expect(after).toEqual(before);
  }, 120_000);

  it("leaves every row it read untouched", async () => {
    const snapshot = async () =>
      JSON.stringify({
        packages: await prisma.verificationPackage.findMany({ where: { evidenceId: { in: created.evidence } }, orderBy: { id: "asc" } }),
        articles: await prisma.trustCenterArticle.findMany({ where: { id: { in: created.articles } }, orderBy: { id: "asc" } }),
        subprocessors: await prisma.subprocessor.findMany({ where: { id: { in: created.subprocessors } }, orderBy: { id: "asc" } }),
        tokens: await prisma.verificationShareToken.findMany({ where: { id: { in: created.tokens } }, orderBy: { id: "asc" } }),
      }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const before = await snapshot();
    await inventory.collectLegacyManifestExposureInventory({ since: null, until: FIX_DEPLOYED });
    expect(await snapshot()).toBe(before);
  }, 120_000);
});
