/**
 * PRO-G2-01 closure 3 — the exact access-path inventory of the CROSS_PARTY
 * packages and the owner-approved containment of their reviewer share links,
 * on live PostgreSQL 16.
 *
 * Fixture (all generated inside the defect window, before any other suite's
 * Trust Center rows become visible):
 *   - team B publishes a Trust Center article (the foreign source);
 *   - record A (team A) has two packages → CROSS_PARTY (A's owner is external,
 *     B is independent). Its share links: two ACTIVE owner shares (eligible),
 *     an expired, a revoked and an exhausted owner share (not live), an ACTIVE
 *     REPORT link (non-revocable by contract) and an ACTIVE owner share created
 *     in another workspace (not conclusive). A CASE-scope external-review grant
 *     covers it through a case link;
 *   - record C (a team in B's organization) has a package → SAME_OWNER_ONLY,
 *     with an ACTIVE owner share (must never be touched);
 *   - record U (team A) has only a post-fix package, with an ACTIVE owner share
 *     (unrelated: must never be touched).
 *
 * Other suites may share the database: assertions are scoped to these rows,
 * and the apply uses the exact count and hash of the dry run it follows.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-G2-01 cross-party access paths + share-link containment (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let contain: typeof import("../src/scripts/contain-cross-party-share-links.js");
  let paths: typeof import("../src/scripts/trust-exposure-access-paths.js");
  let holderCli: typeof import("../src/scripts/trust-exposure-holder-inventory.js");
  let access: typeof import("../src/services/trust/g2-01-cross-party-access.js");
  let share: typeof import("../src/services/governance/verification-share.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let legacy: typeof import("../src/services/trust/legacy-trust-manifest-exposure-inventory.js");

  const tag = randomUUID().slice(0, 8);
  const ARTICLE_AT = new Date("2026-06-01T00:00:00.000Z");
  const GENERATED = new Date("2026-06-02T00:00:00.000Z");
  const AFTER_FIX = new Date("2026-11-21T12:00:00.000Z");
  const DB_URL = "postgresql://u:p@db.contain.test:5432/proovra_contain";
  const A = () => harness.fixtures.teamA;
  const B = () => harness.fixtures.teamB;
  const ids = {
    evA: "", evC: "", evU: "", teamC: "", pA1: "", pA2: "", pC: "", pU: "",
    L1: "", L2: "", L3: "", L4: "", L5: "", L6: "", L7: "", LC: "", LU: "", L8: "", grant: "",
  };
  const tokens: Record<string, string> = {};
  const reviewerEmail = `reviewer-${tag}@outside.example.org`;
  const allSecrets = () => [...Object.values(tokens), reviewerEmail];

  async function run<T extends { out: (s: string) => void; err: (s: string) => void }>(
    fn: (io: T) => Promise<number>,
    io: Omit<T, "out" | "err">,
  ) {
    let out = "";
    let err = "";
    const code = await fn({ ...io, out: (s: string) => void (out += s), err: (s: string) => void (err += s) } as unknown as T);
    for (const s of allSecrets()) expect(out.includes(s) || err.includes(s), "secret material reached the output").toBe(false);
    expect(out).not.toMatch(/pvs_[A-Za-z0-9_-]{20,}/);
    return { code, out, err, json: code === 0 || code === 3 ? JSON.parse(out) : null };
  }
  const dry = (env: Record<string, string> = {}) =>
    run(contain.runContainCrossPartyShareLinksCli, { argv: [], env: { DATABASE_URL: DB_URL, ...env }, client: prisma });
  const containCli = (argv: string[], env: Record<string, string> = {}) =>
    run(contain.runContainCrossPartyShareLinksCli, { argv, env: { DATABASE_URL: DB_URL, ...env }, client: prisma });
  const applyArgs = (j: { database: string; containmentCount: number; setHash: string }) => [
    "--apply",
    `--backup-id=proovra-20261122T120000Z-${tag}`,
    `--expect-database=${j.database}`,
    `--expect-count=${j.containmentCount}`,
    `--expect-set-hash=${j.setHash}`,
  ];
  const APPROVED = { CONTAIN_CROSS_PARTY_SHARE_LINKS_APPLY: "I_HAVE_OWNER_APPROVAL" };
  const linkRow = (id: string) => prisma.verificationShareToken.findUniqueOrThrow({ where: { id } });

  async function record(teamId: string, organizationId: string, ownerUserId: string, title: string) {
    return (
      await prisma.evidence.create({
        data: { title, type: "PHOTO", status: "REPORTED" as never, lifecycleState: "ACTIVE" as never, teamId, organizationId, ownerUserId, sizeBytes: 5_000n },
        select: { id: true },
      })
    ).id;
  }
  async function pkg(evidenceId: string, version: number, profile: string, at: Date) {
    return (
      await prisma.verificationPackage.create({
        data: { evidenceId, version, storageBucket: "contain-test", storageKey: `verification/${evidenceId}/v${version}-${tag}.zip`, generatedAtUtc: at, sizeBytes: 1000n, reportVersion: null, disclosureProfile: profile },
        select: { id: true },
      })
    ).id;
  }
  async function ownerShare(evidenceId: string, label: string, maxUses: number | null = null) {
    const rec = await share.loadRecordForShare(evidenceId, prisma);
    const created = await share.createVerificationLink(
      { record: rec!, actorUserId: A().ownerUserId, audience: `Counsel ${tag}`, expiresInDays: 30, projection: "STANDARD", maxUses },
      prisma,
    );
    tokens[label] = created.token;
    return created.link.id;
  }
  const hash = () => randomBytes(32).toString("hex");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    contain = await import("../src/scripts/contain-cross-party-share-links.js");
    paths = await import("../src/scripts/trust-exposure-access-paths.js");
    holderCli = await import("../src/scripts/trust-exposure-holder-inventory.js");
    access = await import("../src/services/trust/g2-01-cross-party-access.js");
    share = await import("../src/services/governance/verification-share.service.js");
    runtime = await import("@proovra/shared-runtime");
    legacy = await import("../src/services/trust/legacy-trust-manifest-exposure-inventory.js");

    await prisma.trustCenterArticle.create({
      data: { teamId: B().teamId, kind: "TRUST_CENTER", section: "custom", slug: `contain-b-${tag}`, state: "PUBLISHED", title: `B programme ${tag}`, summary: "s", body: "b", publishedAtUtc: ARTICLE_AT, createdAt: ARTICLE_AT },
    });
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId;
    const orgB = (await prisma.team.findUniqueOrThrow({ where: { id: B().teamId }, select: { organizationId: true } })).organizationId;
    ids.teamC = (
      await prisma.team.create({
        data: { name: `B sister ${tag}`, ownerUserId: B().adminUserId, isPersonal: false, organizationId: orgB, workspaceKind: "ORGANIZATION" },
        select: { id: true },
      })
    ).id;

    ids.evA = await record(A().teamId, orgA, A().ownerUserId, `contain A ${tag}`);
    ids.pA1 = await pkg(ids.evA, 1, "EXTERNAL_DISCLOSURE", GENERATED);
    ids.pA2 = await pkg(ids.evA, 2, "FULL_FORENSIC", GENERATED);
    ids.evC = await record(ids.teamC, orgB, B().adminUserId, `contain C ${tag}`);
    ids.pC = await pkg(ids.evC, 1, "FULL_FORENSIC", GENERATED);
    ids.evU = await record(A().teamId, orgA, A().ownerUserId, `contain U ${tag}`);
    ids.pU = await pkg(ids.evU, 1, "FULL_FORENSIC", AFTER_FIX);

    ids.L1 = await ownerShare(ids.evA, "L1");
    ids.L2 = await ownerShare(ids.evA, "L2", 5);
    const mk = async (data: Record<string, unknown>) =>
      (await prisma.verificationShareToken.create({ data: { tokenHash: hash(), ...data } as never, select: { id: true } })).id;
    ids.L3 = await mk({ evidenceId: ids.evA, teamId: A().teamId, purpose: "OWNER_SHARE", expiresAtUtc: new Date("2026-08-01T00:00:00Z") });
    ids.L4 = await mk({ evidenceId: ids.evA, teamId: A().teamId, purpose: "OWNER_SHARE", revokedAtUtc: new Date("2026-08-01T00:00:00Z"), revocationReason: "OWNER_REVOKED" });
    ids.L5 = await mk({ evidenceId: ids.evA, teamId: A().teamId, purpose: "REPORT", reportVersion: 1 });
    ids.L6 = await mk({ evidenceId: ids.evA, teamId: B().teamId, purpose: "OWNER_SHARE" });
    ids.L7 = await mk({ evidenceId: ids.evA, teamId: A().teamId, purpose: "OWNER_SHARE", maxUses: 1, useCount: 1 });
    ids.LC = await mk({ evidenceId: ids.evC, teamId: ids.teamC, purpose: "OWNER_SHARE" });
    ids.LU = await ownerShare(ids.evU, "LU");

    await prisma.caseEvidenceLink.create({ data: { teamId: A().teamId, caseId: A().caseId, evidenceId: ids.evA } });
    ids.grant = (
      await prisma.externalReviewGrant.create({
        data: {
          teamId: A().teamId,
          scopeKind: "CASE",
          caseId: A().caseId,
          tokenHash: hash(),
          reviewerEmail,
          invitedByUserId: A().ownerUserId,
          state: "ACTIVE",
          expiresAtUtc: new Date(Date.now() + 7 * 24 * 3600_000),
        },
        select: { id: true },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("explains 0 versus N: the replay counts only live PACKAGE links; the holder inventory counts every live link of the record, per package", async () => {
    let out = "";
    const code = await holderCli.runTrustExposureHolderInventoryCli({
      argv: [],
      env: { EXPOSURE_INVENTORY_HASH_SALT: "test-salt-0123456789abcdef" },
      out: (s) => (out += s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const inv = JSON.parse(out);
    const p1 = inv.packages.find((p: { packageId: string }) => p.packageId === ids.pA1);
    const p2 = inv.packages.find((p: { packageId: string }) => p.packageId === ids.pA2);
    expect(p1.scope).toBe("CROSS_PARTY");
    // L1, L2 (owner shares), L5 (REPORT) and L6 (other workspace): four live rows of ONE record, counted on BOTH packages.
    expect(p1.access.liveShareLinks).toBe(4);
    expect(p2.access.liveShareLinks).toBe(4);
    const replay = await legacy.collectLegacyManifestExposureInventory({ since: new Date("2026-05-31T08:22:50Z"), until: new Date("2026-11-21T02:21:41Z") });
    const r1 = replay.findings.find((f) => f.packageId === ids.pA1)!;
    expect(r1.livePackageLinks).toBe(0); // purpose = 'PACKAGE' only
    // The holder inventory never saw the CASE-scope grant (evidence_id / package_id only).
    expect(p1.access.liveExternalReviewGrants).toBe(0);
    expect(inv.packages.find((p: { packageId: string }) => p.packageId === ids.pC).scope).toBe("SAME_OWNER_ONLY");
    expect(inv.packages.some((p: { packageId: string }) => p.packageId === ids.pU)).toBe(false);
  });

  it("the exact inventory lists each distinct live link with family and revocability, the CASE grant, downloads meaning and distributions — no secret printed", async () => {
    const r = await run(paths.runTrustExposureAccessPathsCli, { argv: [], env: { EXPOSURE_INVENTORY_HASH_SALT: "test-salt-0123456789abcdef" }, client: prisma });
    expect(r.code, r.err).toBe(0);
    const j = r.json;
    expect(j.classification).toBe("RESTRICTED");
    const mine = j.links.filter((l: { evidenceId: string }) => l.evidenceId === ids.evA);
    expect(mine.map((l: { linkId: string }) => l.linkId).sort()).toEqual([ids.L1, ids.L2, ids.L5, ids.L6].sort());
    const byId = Object.fromEntries(mine.map((l: { linkId: string }) => [l.linkId, l]));
    expect(byId[ids.L1]).toMatchObject({ purpose: "OWNER_SHARE", family: "REVIEWER_SHARE", revocable: true, containmentEligible: true, attachedVia: "EVIDENCE_RECORD", reachesPackageBytes: false, linkTeamIsHolder: true, audienceLabelPresent: true });
    expect(byId[ids.L1].packageIds).toEqual([ids.pA1, ids.pA2].sort());
    expect(byId[ids.L2]).toMatchObject({ maxUses: 5, useCount: 0, containmentEligible: true });
    expect(byId[ids.L5]).toMatchObject({ purpose: "REPORT", family: "ARTIFACT_LINK", revocable: false, containmentEligible: false, containmentWhy: "REFUSED_NOT_REVOCABLE_BY_CONTRACT" });
    expect(byId[ids.L6]).toMatchObject({ revocable: true, containmentEligible: false, linkTeamIsHolder: false, containmentWhy: "REFUSED_NOT_CONCLUSIVE" });
    expect(j.links.some((l: { linkId: string }) => [ids.LC, ids.LU, ids.L3, ids.L4, ids.L7].includes(l.linkId))).toBe(false);
    const p1 = j.packages.find((p: { packageId: string }) => p.packageId === ids.pA1);
    expect(p1.liveShareLinkIds).toEqual([ids.L1, ids.L2, ids.L5, ids.L6].sort());
    expect(p1.nonLiveShareLinks).toEqual({ REVOKED: 1, EXPIRED: 1, EXHAUSTED: 1 });
    expect(p1.liveExternalReviewGrantIds).toEqual([ids.grant]);
    expect(p1.externalReviewGrantCouldReleaseThisPackage).toBe(true);
    expect(j.packages.find((p: { packageId: string }) => p.packageId === ids.pA2).externalReviewGrantCouldReleaseThisPackage).toBe(false);
    expect(p1.recipientOwnership.sources.find((s: { teamId: string }) => s.teamId === B().teamId).relation).toBe("INDEPENDENT");
    const g = j.grants.find((x: { grantId: string }) => x.grantId === ids.grant);
    expect(g).toMatchObject({ scopeKind: "CASE", matchedBy: "CASE_LINK", live: true, reviewer: { domain: "outside.example.org" } });
    expect(j.packages.some((p: { packageId: string }) => p.packageId === ids.pC || p.packageId === ids.pU)).toBe(false);
    expect(j.summary.shareLinksReachPackageBytes).toBe(false);
    expect(j.summary.packagesPerLiveLink["2"]).toBeGreaterThanOrEqual(4);
    expect(j.summary.distinctLiveExternalReviewGrants).toBeGreaterThanOrEqual(1);
    expect(j.downloadMeaning.perPackageOrPerLink).toContain("never per share link");
    // Summary mode: counts only.
    const s = await run(paths.runTrustExposureAccessPathsCli, { argv: ["--summary"], env: {}, client: prisma });
    expect(s.code).toBe(0);
    expect(s.json.links).toBeUndefined();
    expect(s.out).not.toContain(ids.evA);
    expect(s.out).not.toContain(ids.L1);
    for (const f of ["--revoke", "--apply", "--contain", "--bogus"]) expect((await run(paths.runTrustExposureAccessPathsCli, { argv: [f], env: {}, client: prisma })).code).toBe(2);
  });

  it("the output guard prints nothing when a secret or a bearer shape would be printed", async () => {
    const secret = hash();
    expect(access.guardedJson({ a: 1 }, [secret])).not.toBeNull();
    expect(access.guardedJson({ a: secret }, [secret])).toBeNull();
    expect(access.guardedJson({ a: tokens.L1 }, [])).toBeNull();
    expect(access.guardedJson({ a: "see https://app.example/verify/x" }, [])).toBeNull();
    // The CLI's own guard: a token hash planted where the report prints it (the audience flag is not printed,
    // so plant it in revocation_reason of a live link on the record) makes the dry run print nothing and exit 1.
    const planted = (await linkRow(ids.L1)).tokenHash;
    await prisma.verificationShareToken.update({ where: { id: ids.L6 }, data: { revocationReason: planted.slice(0, 64) } });
    const inv = await run(paths.runTrustExposureAccessPathsCli, { argv: [], env: {}, client: prisma });
    await prisma.verificationShareToken.update({ where: { id: ids.L6 }, data: { revocationReason: null } });
    expect(inv.code).toBe(1);
    expect(inv.out).toBe("");
    expect(inv.err).toContain("nothing was printed");
  });

  it("dry run: the exact set holds the two active owner shares and excludes SAME_OWNER, expired, revoked, exhausted, artifact, other-workspace and unrelated links; writes nothing", async () => {
    const before = await prisma.verificationShareToken.findMany({ where: { evidenceId: { in: [ids.evA, ids.evC, ids.evU] } }, orderBy: { id: "asc" } });
    expect((await runtime.resolveVerificationShareToken(prisma, tokens.L1)).outcome).toBe("ACTIVE");
    const d = await dry();
    expect(d.code, d.err).toBe(0);
    expect(d.json.mode).toBe("DRY_RUN");
    expect(d.json.readOnlyTransaction).toBe(true);
    expect(d.json.database).toBe(contain.databaseFingerprint(DB_URL));
    expect(d.json.ids).toEqual(expect.arrayContaining([ids.L1, ids.L2]));
    for (const x of [ids.L3, ids.L4, ids.L5, ids.L6, ids.L7, ids.LC, ids.LU]) expect(d.json.ids).not.toContain(x);
    expect(d.json.setHash).toBe(access.containmentSetHash(d.json.ids));
    expect(d.json.containmentCount).toBe(d.json.ids.length);
    const refused = Object.fromEntries(d.json.refusedLiveLinks.map((l: { linkId: string; why: string }) => [l.linkId, l.why]));
    expect(refused[ids.L5]).toBe("REFUSED_NOT_REVOCABLE_BY_CONTRACT");
    expect(refused[ids.L6]).toBe("REFUSED_NOT_CONCLUSIVE");
    const after = await prisma.verificationShareToken.findMany({ where: { evidenceId: { in: [ids.evA, ids.evC, ids.evU] } }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
  });

  it("apply refuses without approval, backup, count, hash, database, with a restore flag, or when the set changed — and writes nothing", async () => {
    const d = (await dry()).json;
    const args = applyArgs(d);
    const refusedRun = async (argv: string[], env: Record<string, string> = APPROVED) => {
      const r = await containCli(argv, env);
      expect(r.code, `${argv.join(" ")} → ${r.err}`).toBe(2);
      expect(r.err).toContain("Nothing was written");
      return r;
    };
    await refusedRun(args, {});
    await refusedRun(args.filter((a) => !a.startsWith("--backup-id")));
    await refusedRun(args.filter((a) => !a.startsWith("--expect-count")));
    await refusedRun(args.filter((a) => !a.startsWith("--expect-set-hash")));
    await refusedRun(args.filter((a) => !a.startsWith("--expect-database")));
    await refusedRun([...args.filter((a) => !a.startsWith("--expect-database")), "--expect-database=0123456789abcdef"]);
    await refusedRun([...args.filter((a) => !a.startsWith("--expect-count")), `--expect-count=${d.containmentCount + 1}`]);
    await refusedRun([...args.filter((a) => !a.startsWith("--expect-set-hash")), `--expect-set-hash=${"0".repeat(64)}`]);
    await refusedRun([...args, "--restore"]);
    await refusedRun(["--verify", "--backup-id=x123456"], {});
    await refusedRun(["--expect-count=1"], {});
    // The set changes between the validated dry run and the apply: a new active owner share appears.
    ids.L8 = await ownerShare(ids.evA, "L8");
    const changed = await refusedRun(args);
    expect(changed.err).toContain("SET_CHANGED");
    for (const id of [ids.L1, ids.L2, ids.L8]) expect((await linkRow(id)).revokedAtUtc).toBeNull();
    expect(await prisma.adminAuditLog.count({ where: { reasonCode: "SECURITY_CONTAINMENT_PRO_G2_01" } })).toBe(0);
  });

  it("apply revokes exactly the validated set through the canonical service, with audit rows; nothing else changes; access is denied afterwards", async () => {
    const d = (await dry()).json;
    expect(d.ids).toEqual(expect.arrayContaining([ids.L1, ids.L2, ids.L8]));
    const others = [ids.L3, ids.L4, ids.L5, ids.L6, ids.L7, ids.LC, ids.LU];
    const othersBefore = await prisma.verificationShareToken.findMany({ where: { id: { in: others } }, orderBy: { id: "asc" } });
    const pkgsBefore = await prisma.verificationPackage.findMany({ where: { id: { in: [ids.pA1, ids.pA2, ids.pC, ids.pU] } }, orderBy: { id: "asc" } });
    const evBefore = await prisma.evidence.findMany({ where: { id: { in: [ids.evA, ids.evC, ids.evU] } }, orderBy: { id: "asc" } });
    const custodyBefore = await prisma.custodyEvent.count({ where: { evidenceId: { in: [ids.evA, ids.evC, ids.evU] } } });

    const a = await containCli(applyArgs(d), APPROVED);
    expect(a.code, a.err).toBe(0);
    expect(a.json).toMatchObject({ mode: "APPLY", revoked: d.containmentCount, auditRowsWritten: d.containmentCount, setHash: d.setHash, remainingAfterInTransaction: 0 });

    for (const id of [ids.L1, ids.L2, ids.L8]) {
      const row = await linkRow(id);
      expect(row.revokedAtUtc).not.toBeNull();
      expect(row.revokedByUserId).toBeNull();
      expect(row.revocationReason).toBe("SECURITY_CONTAINMENT_PRO_G2_01");
      const audit = await prisma.adminAuditLog.findMany({ where: { action: "verification.link_revoked", resourceId: ids.evA, reasonCode: "SECURITY_CONTAINMENT_PRO_G2_01" } });
      const mineAudit = audit.find((x) => (x.metadata as { linkId?: string }).linkId === id)!;
      expect(mineAudit).toMatchObject({
        actorType: "SYSTEM",
        actorAuthority: "PLATFORM_SECURITY_CONTAINMENT",
        workspaceId: A().teamId,
        resourceType: "evidence_verification",
        previousState: "ACTIVE",
        resultingState: "REVOKED",
        outcome: "success",
        userId: null,
      });
      expect((mineAudit.metadata as { backupId?: string }).backupId).toBe(`proovra-20261122T120000Z-${tag}`);
    }
    // Nothing else: other links, packages, records and custody are as they were.
    expect(await prisma.verificationShareToken.findMany({ where: { id: { in: others } }, orderBy: { id: "asc" } })).toEqual(othersBefore);
    expect(await prisma.verificationPackage.findMany({ where: { id: { in: [ids.pA1, ids.pA2, ids.pC, ids.pU] } }, orderBy: { id: "asc" } })).toEqual(pkgsBefore);
    expect(await prisma.evidence.findMany({ where: { id: { in: [ids.evA, ids.evC, ids.evU] } }, orderBy: { id: "asc" } })).toEqual(evBefore);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: { in: [ids.evA, ids.evC, ids.evU] } } })).toBe(custodyBefore);

    // The real public access path: the resolver, and the route itself.
    for (const label of ["L1", "L2", "L8"]) {
      const resolved = await runtime.resolveVerificationShareToken(prisma, tokens[label]);
      expect(resolved).toMatchObject({ outcome: "GONE", state: "REVOKED" });
      const res = await harness.app.inject({ method: "GET", url: `/public/verify/${tokens[label]}`, remoteAddress: "198.51.100.77" });
      expect(res.statusCode).toBe(410);
    }
    // The unrelated and SAME_OWNER links still work.
    expect((await runtime.resolveVerificationShareToken(prisma, tokens.LU)).outcome).toBe("ACTIVE");
    expect((await linkRow(ids.LC)).revokedAtUtc).toBeNull();
  });

  it("second dry run reports 0; verify proves GONE through the resolver's row decision and the audit rows; a repeated apply is refused", async () => {
    const d2 = await dry();
    expect(d2.code).toBe(0);
    expect(d2.json.containmentCount).toBe(0);
    expect(d2.json.setHash).toBe(access.containmentSetHash([]));
    const v = await containCli(["--verify", `--expect-set-hash=${access.containmentSetHash([ids.L1, ids.L2, ids.L8])}`]);
    expect(v.code, v.err).toBe(0);
    expect(v.json).toMatchObject({ mode: "VERIFY", contained: 3, stillGrantingAccess: 0, missingAudit: 0, expectedSetHashMatches: true });
    for (const l of v.json.links) expect(l).toMatchObject({ publicResolverOutcome: "GONE", publicResolverOutcomeAnySession: "GONE", auditRowPresent: true, state: "REVOKED" });
    const again = await containCli(["--apply", "--backup-id=proovra-again-1", `--expect-database=${d2.json.database}`, "--expect-count=3", `--expect-set-hash=${access.containmentSetHash([ids.L1, ids.L2, ids.L8])}`], APPROVED);
    expect(again.code).toBe(2);
    expect(again.err).toContain("SET_CHANGED");
    // A wrong expected hash makes verify fail (exit 3), never pass.
    const vBad = await containCli(["--verify", `--expect-set-hash=${"1".repeat(64)}`]);
    expect(vBad.code).toBe(3);
  });

  it("the canonical revoke rule is unchanged for the owner route and refuses artifact links for containment", async () => {
    // Owner route: an artifact (REPORT) link is not revocable through share controls.
    const report = await harness.app.inject({
      method: "POST",
      url: `/v1/evidence/${ids.evA}/verify-links/${ids.L5}/revoke`,
      headers: { authorization: `Bearer ${A().ownerToken}` },
    });
    expect(report.statusCode).toBe(404);
    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/evidence/${ids.evU}/verify-links/${ids.LU}/revoke`,
      headers: { authorization: `Bearer ${A().ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const lu = await linkRow(ids.LU);
    expect(lu).toMatchObject({ revokedByUserId: A().ownerUserId, revocationReason: "OWNER_REVOKED" });
    // Containment path on an artifact link: refused by the same rule, inside the transaction.
    await expect(
      prisma.$transaction((tx) =>
        share.revokeVerificationLinkForSecurityContainmentTx(tx, {
          evidenceId: ids.evA,
          linkId: ids.L5,
          reasonCode: "SECURITY_CONTAINMENT_PRO_G2_01",
          incidentRef: "PRO-G2-01",
          backupId: "b-123456",
          correlationId: "c",
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(/link_not_found/);
    expect((await linkRow(ids.L5)).revokedAtUtc).toBeNull();
    await expect(
      prisma.$transaction((tx) =>
        share.revokeVerificationLinkForSecurityContainmentTx(tx, {
          evidenceId: ids.evC,
          linkId: ids.LC,
          reasonCode: "OWNER_REVOKED",
          incidentRef: "PRO-G2-01",
          backupId: "b-123456",
          correlationId: "c",
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(/SECURITY_CONTAINMENT/);
    expect((await linkRow(ids.LC)).revokedAtUtc).toBeNull();
  });
});
