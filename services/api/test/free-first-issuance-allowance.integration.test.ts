/**
 * AUDIT D-03 (product decision 2026-11-15) — FREE: three complete records
 * within a combined 250 MiB of UPLOADED material.
 *
 * The originals count once; the standard first-issued report and package
 * variants of an entitled Free record (stored FREE_ALLOWANCE fact) are left out
 * of the customer-facing allowance on every reader — API admission (part
 * presign, completion under the capacity lock), the worker's artifact gates,
 * the Billing meter and the overview the web/mobile meters read. Later
 * versions and paid outputs count as before. The actual stored bytes stay
 * observable (`actualStorageBytes`).
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), the API over HTTP (create,
 * part presign, complete, billing overview, billing account projection), the
 * capacity lock and settlement, the stored earned fact, both hosts' usage
 * measures and the worker's own report/package gates (imported from the worker
 * and run against the same database, in the order the processor runs them).
 * DOUBLED: the object store (in-process, real byte lengths and digests), the
 * evidence signer, the RFC 3161 authority. SIMULATED: the worker's COMMIT of
 * report/package rows after its gate admits them (fixture rows with the sizes
 * the worker would record) — the real processor run is
 * test/forward/forward-output-pipeline.integration.test.ts "D-03".
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  setAccountPlan,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `https://d03-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "text/plain",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
    // AUD-011 — the recorded-version probe reads the same in-process store: a
    // key that is not there is proven missing.
    probeStoredObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      return b ? { state: "PRESENT" as const, sizeBytes: b.length } : { state: "NOT_FOUND" as const };
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`d03-test-signature:${hex}`).toString("base64"),
        keyId: "d03-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

process.env.S3_BUCKET = "d03-free-allowance-test-bucket";
const BUCKET = process.env.S3_BUCKET;
const MIB = 1024 * 1024;
const MiB = (n: number) => BigInt(n) * BigInt(MIB);

describe("D-03 — Free first issuance is not customer storage (Postgres, real HTTP, both hosts)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let apiScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let countHeld: (typeof import("../src/services/billing-enforcement.service.js"))["countPersonalEvidenceRecords"];
  let worker: typeof import("../../worker/src/workspace-billing.js");
  let clearStoredObjectProbeCache: () => void;
  /** Random bytes; every original is a distinct view of it (distinct digests, shared memory). */
  let pool: Buffer;
  let poolOffset = 0;
  const savedTsa = process.env.TSA_ENABLED;

  beforeAll(async () => {
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ getWorkspaceUsage: apiUsage } = await import("../src/services/workspace-usage.service.js"));
    ({ resolveEnforcementScopeForRequester: apiScope, countPersonalEvidenceRecords: countHeld } = await import(
      "../src/services/billing-enforcement.service.js"
    ));
    worker = await import("../../worker/src/workspace-billing.js");
    ({ clearStoredObjectProbeCache } = await import("../src/services/reports/output-recovery.service.js"));
    pool = randomBytes(128 * MIB);
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `d03-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    if (savedTsa === undefined) delete process.env.TSA_ENABLED;
    else process.env.TSA_ENABLED = savedTsa;
    objects.clear();
    await h?.cleanup();
  }, 120_000);

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown, teamId?: string) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(teamId ? { "x-proovra-workspace-id": teamId } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** A distinct original of exactly `mib` MiB (a view of the random pool). */
  function original(mib: number): Buffer {
    poolOffset = (poolOffset + 4099) % (8 * MIB);
    return pool.subarray(poolOffset, poolOffset + mib * MIB);
  }

  /** Create a record and declare its part (the presign); the bytes land in the store. */
  async function draft(token: string, body: Buffer, teamId?: string) {
    const created = await call("POST", "/v1/evidence", token, { type: "DOCUMENT", mimeType: "text/plain", ...(teamId ? { teamId } : {}) }, teamId);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
      partIndex: 0,
      mimeType: "text/plain",
      originalFileName: "d03.bin",
      sizeBytes: body.length,
    }, teamId);
    return { id, part };
  }

  async function capture(token: string, body: Buffer, teamId?: string): Promise<string> {
    const { id, part } = await draft(token, body, teamId);
    expect(part.statusCode, part.body).toBe(201);
    const u = part.json().upload;
    objects.set(`${u.bucket}/${u.key}`, body);
    const done = await call("POST", `/v1/evidence/${id}/complete`, token, {}, teamId);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe("SIGNED");
    return id;
  }

  /**
   * A record's report + package pair, admitted by the WORKER's own gates in the
   * processor's order (report gate with its package following → commit report
   * → package gate on the ZIP sizes → commit packages). The commit is the
   * fixture: the rows the worker writes, with its sizes.
   */
  async function issuePair(
    evidenceId: string,
    sizes: { report: bigint; full: bigint; ext: bigint },
    version = 1,
  ) {
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { ownerUserId: true, teamId: true } });
    await worker.assertWorkspaceAllowsReportArtifact({
      ownerUserId: ev.ownerUserId,
      teamId: ev.teamId,
      evidenceId,
      incomingBytes: sizes.report,
      issuanceVersion: version,
      packagePairFollows: true,
    });
    const report = await prisma.report.create({
      data: {
        evidenceId,
        version,
        storageBucket: BUCKET,
        storageKey: `reports/${evidenceId}/v${version}-${randomUUID()}.pdf`,
        generatedAtUtc: new Date(),
        sizeBytes: sizes.report,
        issueKind: version === 1 ? "FIRST_ISSUE" : "UPDATED_REPORT",
        ...(version > 1 ? { previousReportVersion: version - 1, issueReason: "d03 later version" } : {}),
      } as never,
      select: { id: true },
    });
    await worker.assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: ev.ownerUserId,
      teamId: ev.teamId,
      evidenceId,
      incomingBytes: sizes.full + sizes.ext,
      issuanceVersion: version,
    });
    const issuanceId = randomUUID();
    for (const [disclosureProfile, sizeBytes] of [["FULL_FORENSIC", sizes.full], ["EXTERNAL_DISCLOSURE", sizes.ext]] as const) {
      await prisma.verificationPackage.create({
        data: {
          evidenceId,
          version,
          reportVersion: version,
          reportId: report.id,
          storageBucket: BUCKET,
          storageKey: `verification/${evidenceId}/v${version}-${disclosureProfile}-${randomUUID()}.zip`,
          generatedAtUtc: new Date(),
          sizeBytes,
          disclosureProfile,
          state: "PUBLISHED",
          issuanceId,
        } as never,
      });
    }
    // The run that issued the pair settles its request (the completion's
    // first-issuance request would otherwise read as still in progress).
    await prisma.reportGenerationRequest.updateMany({
      where: { evidenceId, state: { in: ["QUEUED", "PROCESSING"] } },
      data: { state: "SUCCEEDED", completedAtUtc: new Date(), reportVersion: version, stage: "PACKAGE_PUBLISHED", resultReportId: report.id } as never,
    });
  }

  /** The customer-facing figure on every reader, which must agree. */
  async function everyReader(t: PersonalTenant) {
    const api = await apiUsage(await apiScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await worker.getWorkspaceUsage(
      await worker.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    const overview = await call("GET", "/v1/billing/overview", t.owner.token);
    expect(overview.statusCode, overview.body).toBe(200);
    const projection = await call("GET", `/v1/billing/accounts/PERSONAL/${t.owner.userId}`, t.owner.token);
    expect(projection.statusCode, projection.body).toBe(200);
    // API admission, worker gate, the overview (web sidebar + mobile rail
    // meters) and the Billing projection (Billing meter + web capture preflight)
    // read ONE figure.
    expect(wk.storageBytesUsed, "worker = API").toBe(api.storageBytesUsed);
    expect(wk.actualStorageBytes, "worker actual = API actual").toBe(api.actualStorageBytes);
    expect(overview.json().workspaces.personal.storage.usedBytes, "overview = API").toBe(api.storageBytesUsed.toString());
    expect(projection.json().usage.storage.usedBytes, "Billing meter = API").toBe(api.storageBytesUsed.toString());
    return api;
  }

  it("three records within 250 MiB of uploads, incl. one large original, each get their first pair; the 4th is refused by count, an upload beyond the allowance by bytes", async () => {
    const t = await seedPersonalTenant(deps, "FREE");

    // Record 1: a 100 MiB original. Its FULL_FORENSIC package embeds it.
    const r1 = await capture(t.owner.token, original(100));
    await issuePair(r1, { report: MiB(1), full: MiB(101), ext: MiB(1) });
    let u = await everyReader(t);
    expect(u.storageBytesUsed, "originals once").toBe(MiB(100));
    expect(u.actualStorageBytes, "every stored byte stays visible").toBe(MiB(203));
    expect(u.firstIssuanceExcludedBytes).toBe(MiB(103));

    // Record 2: 60 MiB. Counted the old way (203 MiB) it was refused at the
    // presign and at completion (263 > 250). Now it fits beside 100 MiB.
    const r2 = await capture(t.owner.token, original(60));
    await issuePair(r2, { report: MiB(1), full: MiB(61), ext: MiB(1) });
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(160));
    expect(u.actualStorageBytes).toBe(MiB(160 + 103 + 63));

    // Record 3: an upload beyond the ACTUAL byte allowance is refused at the
    // presign (160 + 91 > 250), writing no part.
    const tooBig = await draft(t.owner.token, original(91));
    expect(tooBig.part.statusCode, tooBig.part.body).toBe(409);
    expect(tooBig.part.json().code).toBe("STORAGE_LIMIT_REACHED");
    expect(await prisma.evidencePart.count({ where: { evidenceId: tooBig.id } })).toBe(0);
    // ...and an 85 MiB original (245 MiB of uploads in all) is admitted and sealed
    // in the same slot.
    const part = await call("POST", `/v1/evidence/${tooBig.id}/parts`, t.owner.token, {
      partIndex: 0,
      mimeType: "text/plain",
      originalFileName: "d03.bin",
      sizeBytes: 85 * MIB,
    });
    expect(part.statusCode, part.body).toBe(201);
    objects.set(`${part.json().upload.bucket}/${part.json().upload.key}`, original(85));
    const done = await call("POST", `/v1/evidence/${tooBig.id}/complete`, t.owner.token, {});
    expect(done.statusCode, done.body).toBe(200);
    const r3 = tooBig.id;
    // Its first pair (FULL_FORENSIC 86 MiB) is admitted although the actual
    // stored bytes are far beyond 250 MiB.
    await issuePair(r3, { report: MiB(1), full: MiB(86), ext: MiB(1) });
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(245));
    expect(u.actualStorageBytes).toBe(MiB(245 + 103 + 63 + 88));
    expect(u.isStorageLimitReached).toBe(false);

    for (const id of [r1, r2, r3]) {
      expect(
        await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { outputEarnedPlan: true, outputEarnedBasis: true } }),
      ).toEqual({ outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE" });
      expect(await prisma.report.count({ where: { evidenceId: id, version: 1 } })).toBe(1);
      expect(await prisma.verificationPackage.count({ where: { evidenceId: id, version: 1, state: "PUBLISHED" } })).toBe(2);
    }
    expect(await countHeld(t.owner.userId)).toBe(3);

    // The fourth is refused by the existing count gate, before any bytes.
    const fourth = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("FREE_LIMIT_REACHED");
  }, 300_000);

  it("the final slot under concurrency: two records that each fit alone but not together — exactly one seals; the count never passes three", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const r1 = await capture(t.owner.token, original(60));
    await issuePair(r1, { report: MiB(1), full: MiB(61), ext: MiB(1) });
    // Slots 2 and 3, both drafted; 60 + 100 fits, 60 + 100 + 100 does not.
    const a = await draft(t.owner.token, original(100));
    const b = await draft(t.owner.token, original(100));
    for (const d of [a, b]) {
      expect(d.part.statusCode, d.part.body).toBe(201);
      objects.set(`${d.part.json().upload.bucket}/${d.part.json().upload.key}`, original(100));
    }
    // A third concurrent create at 3/3 held slots is refused by count.
    const extra = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(extra.statusCode).toBe(409);

    const [ra, rb] = await Promise.all([
      call("POST", `/v1/evidence/${a.id}/complete`, t.owner.token, {}),
      call("POST", `/v1/evidence/${b.id}/complete`, t.owner.token, {}),
    ]);
    expect([ra.statusCode, rb.statusCode].sort(), `${ra.body} | ${rb.body}`).toEqual([200, 409]);
    expect((ra.statusCode === 409 ? ra : rb).body).toContain("STORAGE_LIMIT_REACHED");
    const u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(160));
    expect(u.storageBytesUsed <= u.storageBytesLimit).toBe(true);
    expect(await prisma.evidence.count({ where: { id: { in: [r1, a.id, b.id] }, outputEarnedBasis: "FREE_ALLOWANCE" } })).toBe(2);
  }, 300_000);

  it("first issuance retry and recovery: a failed package attempt counts nowhere; the recovered row is excluded exactly once; legacy rows are never rewritten", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const r1 = await capture(t.owner.token, original(40));
    const report = await prisma.report.create({
      data: { evidenceId: r1, version: 1, storageBucket: BUCKET, storageKey: `reports/${r1}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: MiB(1), issueKind: "FIRST_ISSUE" } as never,
      select: { id: true },
    });
    // The first package attempt failed (a refused or broken build): the row
    // exists, stores nothing, and counts in neither figure.
    const failed = await prisma.verificationPackage.create({
      data: { evidenceId: r1, version: 1, reportVersion: 1, reportId: report.id, disclosureProfile: "FULL_FORENSIC", state: "FAILED", failedAtUtc: new Date(), terminalReason: "STORAGE_LIMIT" } as never,
      select: { id: true },
    });
    let u = await everyReader(t);
    expect(u.actualStorageBytes).toBe(MiB(41));
    expect(u.firstIssuanceExcludedBytes).toBe(MiB(1));
    expect(u.storageBytesUsed).toBe(MiB(40));

    // The recovery (a PACKAGE_FOR_VERSION run, another job and request)
    // re-reserves the SAME row and publishes it: counted once in the actual
    // bytes, excluded once from the customer figure.
    await worker.assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: t.owner.userId,
      teamId: t.personalTeamId,
      evidenceId: r1,
      incomingBytes: MiB(41),
      issuanceVersion: 1,
    });
    await prisma.verificationPackage.update({
      where: { id: failed.id },
      data: { state: "PUBLISHED", storageBucket: BUCKET, storageKey: `verification/${r1}/v1-recovered.zip`, generatedAtUtc: new Date(), sizeBytes: MiB(41), issuanceId: randomUUID(), failedAtUtc: null, terminalReason: null } as never,
    });
    u = await everyReader(t);
    expect(u.actualStorageBytes).toBe(MiB(82));
    expect(u.firstIssuanceExcludedBytes).toBe(MiB(42));
    expect(u.storageBytesUsed).toBe(MiB(40));

    // A record that already had its first-issued outputs (legacy, backfilled
    // FREE_ALLOWANCE fact) is excluded by the same rule; reading it rewrites
    // no row.
    const snapshot = async () => ({
      reports: await prisma.report.findMany({ where: { evidenceId: r1 }, orderBy: { version: "asc" } }),
      packages: await prisma.verificationPackage.findMany({ where: { evidenceId: r1 }, orderBy: { id: "asc" } }),
      evidence: await prisma.evidence.findUniqueOrThrow({ where: { id: r1 }, select: { sizeBytes: true, outputEarnedPlan: true, outputEarnedBasis: true, outputEarnedAtUtc: true, updatedAt: true } }),
    });
    const before = await snapshot();
    await everyReader(t);
    expect(await snapshot()).toEqual(before);
  }, 300_000);

  it("a later version and a paid output still count and are gated; upgrade and downgrade keep each record's rule", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
    const r1 = await capture(t.owner.token, original(100));
    await issuePair(r1, { report: MiB(1), full: MiB(101), ext: MiB(1) });
    expect((await everyReader(t)).storageBytesUsed).toBe(MiB(100));

    // Report v2 (an updated report / anchored version) COUNTS: admitted while
    // it fits (pair estimate = the v1 packages), then counted.
    await issuePair(r1, { report: MiB(2), full: MiB(30), ext: MiB(1) }, 2);
    let u = await everyReader(t);
    expect(u.storageBytesUsed, "v2 pair counted").toBe(MiB(133));
    expect(u.firstIssuanceExcludedBytes, "only v1 excluded").toBe(MiB(103));
    // A v3 whose pair would not fit is refused before anything commits.
    await expect(
      worker.assertWorkspaceAllowsReportArtifact({
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
        evidenceId: r1,
        incomingBytes: MiB(90),
        issuanceVersion: 3,
        packagePairFollows: true,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });

    // Upgrade: the record's fact is unchanged, so is its exclusion.
    await setAccountPlan(deps, t.owner.userId, "PRO");
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(133));
    expect(u.storageBytesLimit > MiB(250)).toBe(true);
    // A record finalized on PRO earns PAID_SUBSCRIPTION outputs: they COUNT.
    const pro = await capture(t.owner.token, original(10));
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: pro }, select: { outputEarnedPlan: true } })).outputEarnedPlan).toBe("PRO");
    await issuePair(pro, { report: MiB(1), full: MiB(11), ext: MiB(1) });
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(133 + 10 + 13));

    // Downgrade to FREE: the same figure under the 250 MiB allowance — the
    // FREE record keeps its exclusion, the PRO record's outputs keep counting.
    await setAccountPlan(deps, t.owner.userId, "FREE", { credits: 1 });
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(156));
    expect(u.storageBytesLimit).toBe(MiB(250));
  }, 300_000);

  it("an invited member's capture counts against the payer (owner), never the member", async () => {
    const owner = await seedPersonalTenant(deps, "PRO", { legacyRecordCapOverride: 5 });
    const member = await seedPersonalTenant(deps, "FREE");
    await prisma.teamMember.create({ data: { teamId: owner.personalTeamId, userId: member.owner.userId, role: "MEMBER", status: "ACTIVE" } });

    const before = await everyReader(owner);
    const rec = await capture(member.owner.token, original(20), owner.personalTeamId);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: rec }, select: { ownerUserId: true, teamId: true, outputEarnedPlan: true } });
    expect(row).toMatchObject({ ownerUserId: member.owner.userId, teamId: owner.personalTeamId, outputEarnedPlan: "PRO" });
    await issuePair(rec, { report: MiB(1), full: MiB(21), ext: MiB(1) });

    const after = await everyReader(owner);
    // Original + its PRO-earned pair, all on the owner's allowance.
    expect(after.storageBytesUsed - before.storageBytesUsed).toBe(MiB(43));
    expect(after.firstIssuanceExcludedBytes).toBe(before.firstIssuanceExcludedBytes);
    // The member's own Personal usage is untouched.
    expect((await everyReader(member)).actualStorageBytes).toBe(0n);
  }, 300_000);

  it("a server-verified recovery of a proven-missing first-issued file is that first issuance: offered and admitted on a full allowance, excluded once; a customer's updated report never is, whatever its reason or key", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const r1 = await capture(t.owner.token, original(120));
    await issuePair(r1, { report: MiB(1), full: MiB(121), ext: MiB(1) });
    const r2 = await capture(t.owner.token, original(100));
    await issuePair(r2, { report: MiB(1), full: MiB(101), ext: MiB(1) });
    expect((await everyReader(t)).storageBytesUsed).toBe(MiB(220));
    // r1's v1 report file is not in the store (the fixture never wrote it):
    // a live HEAD of the recorded version proves it missing.
    clearStoredObjectProbeCache();
    const status = await call("GET", `/v1/evidence/${r1}/artifacts/status`, t.owner.token);
    expect(status.statusCode, status.body).toBe(200);
    // A new pair (1 + 122 MiB) would not fit beside 220 MiB, yet the recovery
    // of the first issuance is offered: it adds nothing to the customer figure.
    expect(status.json().outputs.report, JSON.stringify(status.json().outputs.report)).toMatchObject({ availability: "MISSING", action: "RECOVER", operation: "NEW_VERSION" });

    // A customer key cannot occupy the recovery's identity.
    const squat = await call("POST", `/v1/evidence/${r1}/reports/regenerate`, t.owner.token, {
      intent: "NEW_VERSION",
      reason: "Document the later anchor facts",
      clientRequestKey: `recover-missing:${r1}:v1`,
    });
    expect(squat.statusCode, squat.body).toBe(400);
    expect(squat.json().code).toBe("IDEMPOTENCY_KEY_INVALID");

    clearStoredObjectProbeCache();
    const recover = await call("POST", `/v1/evidence/${r1}/reports/regenerate`, t.owner.token, { intent: "RECOVER" });
    expect(recover.statusCode, recover.body).toBe(202);
    expect(recover.json()).toMatchObject({ operation: "NEW_VERSION" });
    const requestId = recover.json().requestId as string;
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { purpose: true, clientRequestKey: true, forceRegenerate: true },
    });
    expect(row).toEqual({ purpose: "missing_output_recovery", clientRequestKey: `recover-missing:${r1}:v1`, forceRegenerate: true });

    // The worker run: the request reserves v2; its gates admit the pair on the
    // full allowance (not customer storage); the commit records v2.
    await prisma.reportGenerationRequest.update({
      where: { id: requestId },
      data: { state: "PROCESSING", claimedAtUtc: new Date(), reportVersion: 2, stage: "REPORT_RESERVED" } as never,
    });
    await worker.assertWorkspaceAllowsReportArtifact({
      ownerUserId: t.owner.userId, teamId: t.personalTeamId, evidenceId: r1, incomingBytes: MiB(1), issuanceVersion: 2, packagePairFollows: true,
    });
    const v2 = await prisma.report.create({
      data: { evidenceId: r1, version: 2, storageBucket: BUCKET, storageKey: `reports/${r1}/v2.pdf`, generatedAtUtc: new Date(), sizeBytes: MiB(1), issueKind: "UPDATED_REPORT", issueReason: "recover_missing_report_v1", previousReportVersion: 1 } as never,
      select: { id: true },
    });
    await prisma.reportGenerationRequest.update({ where: { id: requestId }, data: { stage: "REPORT_COMMITTED" } as never });
    await worker.assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: t.owner.userId, teamId: t.personalTeamId, evidenceId: r1, incomingBytes: MiB(122), issuanceVersion: 2,
    });
    for (const [disclosureProfile, size] of [["FULL_FORENSIC", 121], ["EXTERNAL_DISCLOSURE", 1]] as const) {
      await prisma.verificationPackage.create({
        data: { evidenceId: r1, version: 2, reportVersion: 2, reportId: v2.id, storageBucket: BUCKET, storageKey: `verification/${r1}/v2-${disclosureProfile}.zip`, generatedAtUtc: new Date(), sizeBytes: MiB(size), disclosureProfile, state: "PUBLISHED", issuanceId: requestId } as never,
      });
    }
    let u = await everyReader(t);
    expect(u.storageBytesUsed, "the recovered pair is not customer storage").toBe(MiB(220));
    expect(u.firstIssuanceExcludedBytes, "v1 and its recovery v2, each once").toBe(MiB(123 + 103 + 123));

    // A customer's updated report on r2 — even one whose stored reason and key
    // read like a recovery (a historical row; the route now refuses the key) —
    // is an additional version: counted and gated.
    const spoof = await prisma.reportGenerationRequest.create({
      data: {
        teamId: t.personalTeamId, evidenceId: r2, artifactType: "REPORT", purpose: "updated_report", forceRegenerate: true,
        regenerateReason: "recover_missing_report_v1", requestedByUserId: t.owner.userId, expectedPolicyVersion: 0,
        idempotencyKey: `D03-SPOOF:${randomUUID()}`, clientRequestKey: `recover-missing:${r2}:v1`, intent: "NEW_VERSION",
        state: "SUCCEEDED", reportVersion: 2, stage: "REPORT_COMMITTED",
      } as never,
      select: { id: true },
    });
    expect(spoof.id).toBeTruthy();
    await prisma.report.create({
      data: { evidenceId: r2, version: 2, storageBucket: BUCKET, storageKey: `reports/${r2}/v2.pdf`, generatedAtUtc: new Date(), sizeBytes: MiB(5), issueKind: "UPDATED_REPORT", issueReason: "recover_missing_report_v1", previousReportVersion: 1 } as never,
    });
    u = await everyReader(t);
    expect(u.storageBytesUsed).toBe(MiB(225));
    expect(u.firstIssuanceExcludedBytes).toBe(MiB(349));
    await expect(
      worker.assertWorkspaceAllowsReportArtifact({
        ownerUserId: t.owner.userId, teamId: t.personalTeamId, evidenceId: r2, incomingBytes: MiB(30), issuanceVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
  }, 300_000);
});
