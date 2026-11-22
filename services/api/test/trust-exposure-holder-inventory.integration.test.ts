/**
 * PRO-G2-01 — the RESTRICTED holder/source/access inventory and the
 * ground-truth sample inspection, on live PostgreSQL 16 and local MinIO.
 *
 * Proves, against the real schema:
 *   - an affected package is listed with its HOLDING workspace, its SOURCE
 *     workspace and their relation (independent by default; a test-domain
 *     relation when the owner's domain is declared a test domain);
 *   - downloads are counted per package (attributed / record-level) with the
 *     last time and who (holder member / not); access paths are listed by
 *     purpose and status (active / expired / revoked);
 *   - the output never carries a full email address (domain + local-part HMAC
 *     only), and `--summary` carries no ids at all;
 *   - write-like flags are refused, and the inventory writes nothing;
 *   - the sample inspection reads ONLY the trust manifests of the stored ZIP by
 *     range (never the whole object), attributes each row OWN / FOREIGN /
 *     UNMATCHED, prints foreign article ids + titles and subprocessor row ids,
 *     and never prints an OWN title or a subprocessor name.
 *
 * Other suites may share the database: every assertion is scoped to rows this
 * file created.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import archiver from "archiver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifySourceRelation,
  maskEmail,
  packageScope,
  type TeamFact,
} from "../src/services/trust/trust-exposure-classification.js";
import { bufferRangeReader, extractZipEntries } from "../src/services/trust/package-manifest-inspection.js";
import { runTrustManifestSampleInspectionCli } from "../src/scripts/trust-manifest-sample-inspection.js";
import type { IntegrationHarness } from "./integration-harness.js";

async function zipOf(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    sink.on("end", () => resolve());
    archive.on("error", reject);
  });
  archive.pipe(sink);
  for (const e of entries) archive.append(e.data, { name: e.name, store: e.store === true });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("PRO-G2-01 holder inventory + sample inspection (live PostgreSQL 16, read-only)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let holderCli: typeof import("../src/scripts/trust-exposure-holder-inventory.js");
  let storage: typeof import("../src/storage.js");

  const tag = randomUUID().slice(0, 8);
  const T0 = new Date("2026-06-10T00:00:00.000Z");
  const DURING = new Date("2026-07-01T00:00:00.000Z");
  const ids = { evidence: "", pkg: "", bArticle: "", aArticle: "", bSub: "", aSub: "" };
  const ownTitle = `Team A own programme ${tag}`;
  const foreignTitle = `Team B private programme ${tag}`;
  const A = () => harness.fixtures.teamA;
  const B = () => harness.fixtures.teamB;
  let ownerEmails: string[] = [];

  async function holderRun(argv: string[]) {
    let out = "";
    let err = "";
    const code = await holderCli.runTrustExposureHolderInventoryCli({
      argv,
      env: { EXPOSURE_INVENTORY_HASH_SALT: "test-salt-0123456789abcdef" },
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    for (const e of ownerEmails) expect(out.includes(e), "a full email reached the output").toBe(false);
    return { code, out, err, json: code === 0 ? JSON.parse(out) : null };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    holderCli = await import("../src/scripts/trust-exposure-holder-inventory.js");
    storage = await import("../src/storage.js");

    ownerEmails = (
      await prisma.user.findMany({ where: { id: { in: [A().ownerUserId, B().ownerUserId] } }, select: { email: true } })
    ).map((u) => u.email!).filter(Boolean);

    const b = await prisma.trustCenterArticle.create({
      data: { teamId: B().teamId, kind: "TRUST_CENTER", section: "custom", slug: `b-own-${tag}`, state: "PUBLISHED", title: foreignTitle, summary: "s", body: "b", publishedAtUtc: T0, createdAt: T0 },
      select: { id: true },
    });
    ids.bArticle = b.id;
    const a = await prisma.trustCenterArticle.create({
      data: { teamId: A().teamId, kind: "TRUST_CENTER", section: "custom", slug: `a-own-${tag}`, state: "PUBLISHED", title: ownTitle, summary: "s", body: "b", publishedAtUtc: T0, createdAt: T0 },
      select: { id: true },
    });
    ids.aArticle = a.id;
    const bs = await prisma.subprocessor.create({
      data: { teamId: B().teamId, name: `Team B vendor ${tag}`, slug: `b-vendor-${tag}`, vendor: "v", purpose: "p", region: "EU", dataCategories: [], changeHistorySummary: "c", state: "ACTIVE", createdAt: T0 },
      select: { id: true },
    });
    ids.bSub = bs.id;
    const as = await prisma.subprocessor.create({
      data: { teamId: A().teamId, name: `Team A vendor ${tag}`, slug: `a-vendor-${tag}`, vendor: "v", purpose: "p", region: "EU", dataCategories: [], changeHistorySummary: "c", state: "ACTIVE", createdAt: T0 },
      select: { id: true },
    });
    ids.aSub = as.id;

    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true, ownerUserId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `g2-01 holder ${tag}`, type: "PHOTO", status: "REPORTED" as never, lifecycleState: "ACTIVE" as never, teamId: A().teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId, sizeBytes: 5_000n },
      select: { id: true },
    });
    ids.evidence = ev.id;

    // The stored package: the four manifests as the OLD builder wrote them, plus a large unrelated entry.
    const manifests = {
      "intelligence/trust-manifest.json": {
        schemaVersion: "PROOVRA_TRUST_MANIFEST_V1",
        trustArticles: [
          { section: "custom", slug: `a-own-${tag}`, title: ownTitle },
          { section: "custom", slug: `b-own-${tag}`, title: foreignTitle },
          { section: "custom", slug: `gone-${tag}`, title: `Deleted since ${tag}` },
        ],
        activeSubprocessorCount: 2,
      },
      "intelligence/methodology-manifest.json": { schemaVersion: "PROOVRA_METHODOLOGY_MANIFEST_V1", sections: [] },
      "intelligence/ai-disclosure-manifest.json": { schemaVersion: "PROOVRA_AI_DISCLOSURE_MANIFEST_V1", sections: [] },
      "intelligence/subprocessor-manifest.json": {
        schemaVersion: "PROOVRA_SUBPROCESSOR_MANIFEST_V1",
        subprocessors: [
          { slug: ids.aSub, name: `Team A vendor ${tag}`, vendor: "v", region: "EU" },
          { slug: ids.bSub, name: `Team B vendor ${tag}`, vendor: "v", region: "EU" },
        ],
      },
    };
    const zip = await zipOf([
      { name: "evidence/original.bin", data: randomBytes(600_000), store: true },
      ...Object.entries(manifests).map(([name, json]) => ({ name, data: Buffer.from(JSON.stringify(json)) })),
      { name: "report/report.pdf", data: randomBytes(50_000), store: true },
    ]);
    const bucket = process.env.S3_BUCKET!;
    const key = `verification/${ev.id}/v1-g2-${tag}.zip`;
    await storage.putObjectBuffer({ bucket, key, body: zip, contentType: "application/zip" });
    const pkg = await prisma.verificationPackage.create({
      data: { evidenceId: ev.id, version: 1, storageBucket: bucket, storageKey: key, generatedAtUtc: DURING, sizeBytes: BigInt(zip.length), reportVersion: null, disclosureProfile: "EXTERNAL_DISCLOSURE" },
      select: { id: true },
    });
    ids.pkg = pkg.id;

    // Access paths: an active package link, a revoked owner share, an expired link.
    const hash = () => randomBytes(32).toString("hex");
    await prisma.verificationShareToken.createMany({
      data: [
        { evidenceId: ev.id, teamId: A().teamId, tokenHash: hash(), purpose: "PACKAGE", reportVersion: 1 },
        { evidenceId: ev.id, teamId: A().teamId, tokenHash: hash(), purpose: "OWNER_SHARE", revokedAtUtc: new Date("2026-08-01T00:00:00Z") },
        { evidenceId: ev.id, teamId: A().teamId, tokenHash: hash(), purpose: "OWNER_SHARE", expiresAtUtc: new Date("2026-08-01T00:00:00Z") },
      ],
    });
    // Downloads: one by a holder member, one by a non-member, one record-level legacy event.
    const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
    await appendCustodyEvent({ evidenceId: ev.id, eventType: "DOWNLOAD_AUTHORIZED" as never, atUtc: new Date("2026-07-02T00:00:00Z"), payload: { artifact: "verification_package", packageId: pkg.id, accessedByUserId: A().ownerUserId } });
    await appendCustodyEvent({ evidenceId: ev.id, eventType: "DOWNLOAD_AUTHORIZED" as never, atUtc: new Date("2026-07-03T00:00:00Z"), payload: { artifact: "verification_package", packageId: pkg.id, accessedByUserId: B().ownerUserId } });
    await appendCustodyEvent({ evidenceId: ev.id, eventType: "VERIFICATION_PACKAGE_DOWNLOADED" as never, atUtc: new Date("2026-07-04T00:00:00Z"), payload: { version: 1 } });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("classifies relations and masks accounts (pure rules)", () => {
    const base = (over: Omit<Partial<TeamFact>, "owner"> & { owner?: Partial<TeamFact["owner"]> } = {}): TeamFact => ({
      teamId: randomUUID(),
      organizationId: randomUUID(),
      workspaceKind: "TEAM",
      isPersonal: false,
      closed: false,
      activeMemberUserIds: [randomUUID()],
      ...over,
      owner: { userId: randomUUID(), domain: "client.example.de", localPartHmac: "x", class: "EXTERNAL", ...(over.owner ?? {}) },
    });
    const h = base({});
    expect(classifySourceRelation(h, base({ owner: { userId: h.owner.userId } }))).toBe("SAME_OWNER_USER");
    expect(classifySourceRelation(h, base({ organizationId: h.organizationId }))).toBe("SAME_ORGANIZATION");
    expect(classifySourceRelation(h, base({ activeMemberUserIds: [h.activeMemberUserIds[0]!] }))).toBe("SHARED_MEMBER");
    const op = base({ owner: { class: "OPERATOR", domain: "proovra.com" } });
    expect(classifySourceRelation(op, base({ owner: { class: "OPERATOR", domain: "proovra.com" } }))).toBe("BOTH_OPERATOR");
    expect(classifySourceRelation(h, base({ owner: { class: "TEST_DOMAIN" } }))).toBe("TEST_DOMAIN");
    expect(classifySourceRelation(h, base({}))).toBe("INDEPENDENT");
    expect(packageScope([])).toBe("NO_DISTINCT_SOURCE");
    expect(packageScope(["SAME_OWNER_USER", "SHARED_MEMBER"])).toBe("SAME_OWNER_ONLY");
    expect(packageScope(["SAME_OWNER_USER", "BOTH_OPERATOR"])).toBe("OPERATOR_OR_TEST_ONLY");
    expect(packageScope(["SAME_OWNER_USER", "INDEPENDENT"])).toBe("CROSS_PARTY");
    const m = maskEmail("u", "Jane.Doe@Sub.Example.com", { hashSalt: "s".repeat(16), operatorDomains: ["proovra.com"], testDomains: ["example.com"] });
    expect(m).toMatchObject({ domain: "sub.example.com", class: "TEST_DOMAIN" });
    expect(m.localPartHmac).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(m)).not.toContain("jane");
  });

  it("lists the affected package with holder, source, relation, downloads and access paths — domains and HMACs only", async () => {
    const r = await holderRun([]);
    expect(r.code).toBe(0);
    expect(r.json.classification).toBe("RESTRICTED");
    expect(r.json.evidenceBasis).toBe("DATABASE_INFERRED_REPLAY");
    expect(r.json.artifactContents).toBe("NOT_READ");
    const p = r.json.packages.find((x: { packageId: string }) => x.packageId === ids.pkg);
    expect(p).toBeTruthy();
    expect(p.replayClass).toBe("FOREIGN_DISTINCT");
    expect(p.holder.teamId).toBe(A().teamId);
    expect(p.holder.owner.userId).toBe(A().ownerUserId);
    expect(p.holder.owner.domain).toBe("test.proovra.local");
    expect(p.holder.owner.localPartHmac).toMatch(/^[0-9a-f]{16}$/);
    const src = p.sources.find((s: { team: { teamId: string } }) => s.team.teamId === B().teamId);
    expect(src.relation).toBe("INDEPENDENT");
    expect(p.scope).toBe("CROSS_PARTY");
    expect(p.downloads).toMatchObject({
      attributedToPackage: 2,
      lastAttributedAtUtc: "2026-07-03T00:00:00.000Z",
      recordLevelUnattributed: 1,
      lastRecordLevelAtUtc: "2026-07-04T00:00:00.000Z",
      byHolderMembers: 1,
      byNonMembers: 1,
      byUnknown: 1,
    });
    const links = Object.fromEntries(p.access.shareLinks.map((l: { purpose: string; status: string; count: number }) => [`${l.purpose}:${l.status}`, l.count]));
    expect(links).toEqual({ "PACKAGE:ACTIVE": 1, "OWNER_SHARE:REVOKED": 1, "OWNER_SHARE:EXPIRED": 1 });
    expect(p.access.liveShareLinks).toBe(1);
    // A declared test domain changes the relation, never the facts.
    const t = await holderRun(["--test-domains=proovra.local"]);
    const p2 = t.json.packages.find((x: { packageId: string }) => x.packageId === ids.pkg);
    expect(p2.sources.find((s: { team: { teamId: string } }) => s.team.teamId === B().teamId).relation).toBe("TEST_DOMAIN");
    expect(p2.scope).toBe("OPERATOR_OR_TEST_ONLY");
    expect(p2.holder.owner.class).toBe("TEST_DOMAIN");
  });

  it("--summary carries counts only; write-like and unknown flags are refused; nothing is written", async () => {
    const before = await prisma.verificationShareToken.count({ where: { evidenceId: ids.evidence } });
    const s = await holderRun(["--summary"]);
    expect(s.code).toBe(0);
    expect(s.json.packages).toBeUndefined();
    expect(s.out).not.toContain(ids.pkg);
    expect(s.out).not.toContain(A().teamId);
    expect(s.json.affectedPackages).toBeGreaterThanOrEqual(1);
    for (const f of ["--apply", "--revoke", "--notify", "--reissue"]) {
      const r = await holderRun([f]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("read-only");
    }
    expect((await holderRun(["--bogus"])).code).toBe(2);
    expect((await holderRun(["--since=2026-12-01T00:00:00Z", "--until=2026-06-01T00:00:00Z"])).code).toBe(2);
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: ids.evidence } })).toBe(before);
  });

  it("sample inspection reads only the trust manifests by range and attributes OWN / FOREIGN / UNMATCHED", async () => {
    let bytesRead = 0;
    let totalSize = 0;
    let out = "";
    let err = "";
    const code = await runTrustManifestSampleInspectionCli({
      argv: [`--packages=${ids.pkg}`],
      client: prisma,
      storage: {
        head: async (p) => {
          const h = await storage.headObject(p);
          totalSize = Number(h.sizeBytes);
          return { sizeBytes: h.sizeBytes ?? null };
        },
        range: async (p) => {
          const b = await storage.getObjectRange(p);
          bytesRead += b.length;
          return b;
        },
      },
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    expect(code, err).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.classification).toBe("RESTRICTED");
    expect(doc.evidenceBasis).toBe("STORED_ARTIFACT_CONTENTS");
    const p = doc.packages[0];
    expect(p.outcome).toBe("READ");
    expect(p.packageTeamId).toBe(A().teamId);
    expect(p.observedClass).toBe("FOREIGN_PRESENT");
    expect(p.manifestsPresent).toHaveLength(4);
    expect(p.counts).toMatchObject({ articles: 3, foreignArticles: 1, unmatchedArticles: 1, subprocessors: 2, foreignSubprocessors: 1, activeSubprocessorCountStated: 2 });
    const foreign = p.articles.find((a: { attribution: string }) => a.attribution === "FOREIGN");
    expect(foreign).toMatchObject({ title: foreignTitle, foreignArticleIds: [ids.bArticle], foreignTeamIds: [B().teamId] });
    expect(p.subprocessors).toEqual([{ rowId: ids.bSub, attribution: "FOREIGN", owningTeamId: B().teamId }]);
    // OWN content is counted, never listed; no subprocessor name is printed.
    expect(out).not.toContain(ownTitle);
    expect(out).not.toContain(`Team B vendor ${tag}`);
    // Range reads only: the large evidence entry was never fetched.
    expect(bytesRead).toBeLessThan(totalSize / 2);
  });

  it("sample inspection --compare-corrected-builder diffs the stored manifests with the corrected tenant-scoped builder in memory, issuing nothing", async () => {
    const pkgsBefore = await prisma.verificationPackage.count({ where: { evidenceId: ids.evidence } });
    let out = "";
    let err = "";
    const code = await runTrustManifestSampleInspectionCli({
      argv: [`--packages=${ids.pkg}`, "--compare-corrected-builder"],
      client: prisma,
      storage: {
        head: async (p) => ({ sizeBytes: (await storage.headObject(p)).sizeBytes ?? null }),
        range: async (p) => storage.getObjectRange(p),
      },
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    expect(code, err).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.evidenceBasis).toBe("STORED_ARTIFACT_CONTENTS");
    const c = doc.packages[0].comparison;
    expect(c.basis).toBe("CORRECTED_BUILDER_IN_MEMORY_NOW");
    expect(c.issued).toBe(false);
    // The own article and the own vendor are in both; the foreign rows only in the stored ZIP; the deleted row is UNMATCHED.
    expect(c.articles.inBoth).toBe(1);
    expect(c.articles.storedOnly).toEqual({ FOREIGN: 1, OWN: 0, UNMATCHED: 1 });
    expect(c.subprocessors.inBoth).toBe(1);
    expect(c.subprocessors.storedOnly).toEqual({ FOREIGN: 1, OWN: 0, UNMATCHED: 0 });
    expect(c.activeSubprocessorCount.stored).toBe(2);
    expect(c.activeSubprocessorCount.corrected).toBeGreaterThanOrEqual(1);
    expect(c.conclusion).toBe("STORED_CARRIES_FOREIGN_ROWS_THE_CORRECTED_BUILDER_EXCLUDES");
    expect(out).not.toContain(ownTitle);
    expect(out).not.toContain(`Team A vendor ${tag}`);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: ids.evidence } })).toBe(pkgsBefore);
  });

  it("sample inspection refuses write-like flags, too many or malformed ids", async () => {
    const run = async (argv: string[]) => {
      let err = "";
      const code = await runTrustManifestSampleInspectionCli({
        argv,
        client: prisma,
        storage: { head: async () => ({ sizeBytes: 0 }), range: async () => Buffer.alloc(0) },
        out: () => undefined,
        err: (s) => (err += s),
      });
      return { code, err };
    };
    expect((await run(["--save"])).code).toBe(2);
    expect((await run(["--issue"])).code).toBe(2);
    expect((await run([`--packages=${randomUUID()}`, "--compare-corrected-builder=yes"])).code).toBe(2);
    expect((await run(["--packages=not-a-uuid"])).code).toBe(2);
    expect((await run([`--packages=${Array.from({ length: 51 }, () => randomUUID()).join(",")}`])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it("the zip reader extracts only the named entries", async () => {
    const zip = await zipOf([
      { name: "a.txt", data: Buffer.from("alpha") },
      { name: "b.txt", data: Buffer.from("beta"), store: true },
    ]);
    const got = await extractZipEntries(bufferRangeReader(zip), ["b.txt", "missing.txt"]);
    expect([...got.keys()]).toEqual(["b.txt"]);
    expect(got.get("b.txt")!.toString()).toBe("beta");
    await expect(extractZipEntries(bufferRangeReader(Buffer.from("not a zip at all, definitely not")), ["a"])).rejects.toThrow(/not a zip/);
  });
});
