/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — a Public Verify read, against live
 * PostgreSQL 16 and the real route (2026-10-07).
 *
 *   * each published profile is its own record, linked to the packages issued
 *     with it and to the adjacent package of the SAME profile;
 *   * a RESERVED or FAILED package row is never served;
 *   * unknown and malformed ids answer one identical 404;
 *   * the seal key binds only through its exact registry identity with purpose
 *     PACKAGE_SEAL — an evidence-signing key of the same id/version never does;
 *   * there is no key-inventory endpoint;
 *   * the read shares the Public Verify per-client budget.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("public package record (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const sealKeyId = `pkgrec-seal-${randomUUID().slice(0, 8)}`;
  const seal = generateKeyPairSync("ed25519");
  const sealPem = seal.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const sealFp = createHash("sha256").update(seal.publicKey.export({ type: "spki", format: "der" })).digest("hex");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const registry = await import("../src/signing/key-registry.js");
    await registry.registerSigningKey(prisma, { keyId: sealKeyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: sealPem });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

  /** A record with report v1/v2 and its package rows, as the worker writes them. */
  async function fixture() {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const ev = await prisma.evidence.create({
      data: { title: "package record fixture", type: "PHOTO", status: "REPORTED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    created.push(ev.id);
    const now = new Date();
    const reports: Array<{ id: string }> = [];
    for (const version of [1, 2]) {
      reports.push(
        await prisma.report.create({
          data: { evidenceId: ev.id, version, storageBucket: "b", storageKey: `r/${ev.id}/${version}.pdf`, generatedAtUtc: now, pdfSha256: hex(`r${version}${ev.id}`) } as never,
          select: { id: true },
        }),
      );
    }
    const issuance1 = randomUUID();
    const pkg = async (version: number, profile: string, extra: Record<string, unknown> = {}) =>
      prisma.verificationPackage.create({
        data: {
          id: randomUUID(),
          evidenceId: ev.id,
          version,
          reportVersion: version,
          reportId: reports[version - 1]!.id,
          disclosureProfile: profile,
          state: "PUBLISHED",
          issuanceId: version === 1 ? issuance1 : randomUUID(),
          storageBucket: "b",
          storageKey: `p/${ev.id}/${version}-${profile}.zip`,
          generatedAtUtc: now,
          completedAtUtc: now,
          packageSha256: hex(`p${version}${profile}${ev.id}`),
          packageFormatVersion: 5,
          sealSha256: hex(`s${version}${profile}${ev.id}`),
          sealSigningKeySha256: sealFp,
          sealSigningKeyId: sealKeyId,
          sealSigningKeyVersion: 1,
          ...extra,
        } as never,
        select: { id: true, packageSha256: true },
      });
    const full1 = await pkg(1, "FULL_FORENSIC");
    const ext1 = await pkg(1, "EXTERNAL_DISCLOSURE");
    const full2 = await pkg(2, "FULL_FORENSIC", { supersedesPackageId: full1.id });
    // v2's external profile is still being issued; another record's row failed.
    const reserved = await pkg(2, "EXTERNAL_DISCLOSURE", {
      state: "RESERVED",
      storageBucket: null,
      storageKey: null,
      generatedAtUtc: null,
      completedAtUtc: null,
      packageSha256: null,
    });
    return { evidenceId: ev.id, full1, ext1, full2, reserved, issuance1 };
  }

  const get = (url: string) => harness.app.inject({ method: "GET", url, headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });

  it("each profile is its own record: issued together, superseded per profile, bound to its PACKAGE_SEAL key", async () => {
    const f = await fixture();
    const full = await get(`/public/verification-packages/${f.full1.id}`);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.headers["cache-control"]).toBe("no-store");
    const body = full.json();
    expect(body).toMatchObject({
      schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
      version: 2,
      packageId: f.full1.id,
      disclosureProfile: "FULL_FORENSIC",
      issuanceId: f.issuance1,
      reportVersion: 1,
      packageSha256: f.full1.packageSha256,
      keyBinding: "BOUND",
      supersedes: null,
      supersededBy: { packageId: f.full2.id, reportVersion: 2 },
    });
    expect(body.issuedWith).toEqual([{ packageId: f.ext1.id, disclosureProfile: "EXTERNAL_DISCLOSURE" }]);
    expect(body.sealKey).toMatchObject({ purpose: "PACKAGE_SEAL", algorithm: "Ed25519", keyId: sealKeyId, version: 1, fingerprintSha256: sealFp, status: "ACTIVE" });
    // No evidence content, no record identifier.
    expect(JSON.stringify(body)).not.toContain(f.evidenceId);

    const ext = (await get(`/public/verification-packages/${f.ext1.id}`)).json();
    expect(ext).toMatchObject({ packageId: f.ext1.id, disclosureProfile: "EXTERNAL_DISCLOSURE", supersededBy: null });
    expect(ext.issuedWith).toEqual([{ packageId: f.full1.id, disclosureProfile: "FULL_FORENSIC" }]);

    const v2 = (await get(`/public/verification-packages/${f.full2.id}`)).json();
    expect(v2.supersedes).toEqual({ packageId: f.full1.id, reportVersion: 1 });

    const bySha = await get(`/public/verification-packages/by-sha256/${f.ext1.packageSha256}`);
    expect(bySha.statusCode).toBe(200);
    expect(bySha.json().packageId).toBe(f.ext1.id);
  });

  it("a RESERVED or FAILED row, an unknown id and a malformed id all answer the same 404", async () => {
    const f = await fixture();
    await prisma.verificationPackage.update({
      where: { id: f.reserved.id },
      data: { state: "FAILED", failedAtUtc: new Date(), terminalReason: "TEST" } as never,
    });
    const answers = await Promise.all([
      get(`/public/verification-packages/${f.reserved.id}`),
      get(`/public/verification-packages/${randomUUID()}`),
      get(`/public/verification-packages/not-a-uuid`),
      get(`/public/verification-packages/by-sha256/${"0".repeat(64)}`),
      get(`/public/verification-packages/by-sha256/xyz`),
    ]);
    for (const a of answers) {
      expect(a.statusCode).toBe(404);
      expect(a.json()).toEqual({ code: "PACKAGE_NOT_FOUND", message: "No PROOVRA package record matches." });
    }
  });

  // F-19 (independent forward audit) — one access decision for every public
  // surface of a record: its packages' records follow the canonical page.
  it("F-19: a withdrawn, suspended or retained record's package record answers that state, never the package facts", async () => {
    const f = await fixture();
    const byId = () => get(`/public/verification-packages/${f.full1.id}`);
    const bySha = () => get(`/public/verification-packages/by-sha256/${f.full1.packageSha256}`);
    expect((await byId()).statusCode).toBe(200);

    const expectState = async (status: number, code: string) => {
      for (const res of [await byId(), await bySha()]) {
        expect(res.statusCode, res.body).toBe(status);
        const body = res.json() as Record<string, unknown>;
        expect(body.code).toBe(code);
        // No package facts: no id, digest, issuance or key binding.
        for (const key of ["packageId", "packageSha256", "issuedAtUtc", "keyBinding", "evidenceId"]) expect(body).not.toHaveProperty(key);
        expect(res.body).not.toContain(f.full1.id);
      }
    };
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { verificationAccessState: "WITHDRAWN" } as never });
    await expectState(410, "VERIFICATION_RECORD_WITHDRAWN");
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { verificationAccessState: "SUSPENDED" } as never });
    await expectState(503, "VERIFICATION_RECORD_TEMPORARILY_UNAVAILABLE");
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { verificationAccessState: "AVAILABLE", lifecycleState: "TRASHED", deletedAt: new Date() } as never });
    await expectState(200, "VERIFICATION_RECORD_RETAINED");
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { lifecycleState: "ACTIVE", deletedAt: null } as never });
    expect((await byId()).statusCode).toBe(200);
  });

  // F-19 (closure audit) — Public Verify answers 404 (anti-enumeration) for an
  // integrity-rejected record and for a legacy soft-deleted one; the package
  // record answered 200 with seal facts and keyBinding BOUND for the same record.
  it("F-19: an integrity-rejected or legacy soft-deleted record's package record is a 404, like Public Verify", async () => {
    const f = await fixture();
    const byId = () => get(`/public/verification-packages/${f.full1.id}`);
    const bySha = () => get(`/public/verification-packages/by-sha256/${f.full1.packageSha256}`);
    expect((await byId()).statusCode).toBe(200);
    const expect404 = async () => {
      for (const res of [await byId(), await bySha()]) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toEqual({ code: "PACKAGE_NOT_FOUND", message: "No PROOVRA package record matches." });
      }
    };
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { status: "FAILED_HASH_MISMATCH" } as never });
    await expect404();
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { status: "REPORTED", deletedAt: new Date() } as never });
    await expect404();
    await prisma.evidence.update({ where: { id: f.evidenceId }, data: { deletedAt: null } as never });
    expect((await byId()).statusCode).toBe(200);
  });

  it("a key registered for the EVIDENCE signature never binds a package, even under the same id and version", async () => {
    const f = await fixture();
    const keyId = `pkgrec-evidence-${randomUUID().slice(0, 8)}`;
    const k = generateKeyPairSync("ed25519");
    const registry = await import("../src/signing/key-registry.js");
    await registry.registerSigningKey(prisma, {
      keyId,
      version: 1,
      purpose: "EVIDENCE_SIGNATURE",
      publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    await prisma.verificationPackage.update({
      where: { id: f.full1.id },
      data: {
        sealSigningKeyId: keyId,
        sealSigningKeyVersion: 1,
        sealSigningKeySha256: createHash("sha256").update(k.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
      } as never,
    });
    const body = (await get(`/public/verification-packages/${f.full1.id}`)).json();
    expect(body.keyBinding).toBe("KEY_NOT_PUBLISHED");
    expect(body.sealKey).toBeNull();
  });

  it("F-30: a recorded seal fingerprint that disagrees with the registered key is a KEY_MISMATCH, and the seal check says FAILED", async () => {
    const f = await fixture();
    await prisma.verificationPackage.update({ where: { id: f.full2.id }, data: { sealSigningKeySha256: "f".repeat(64) } as never });
    expect((await get(`/public/verification-packages/${f.full2.id}`)).json().keyBinding).toBe("KEY_MISMATCH");
    // THE same decision on the Public Verify seal check: a contradiction, never "not published".
    const { resolvePackageSealCheck } = await import("../src/services/public-verify/package-seal-check.service.js");
    const row = await prisma.verificationPackage.findUniqueOrThrow({ where: { id: f.full2.id } });
    expect((await resolvePackageSealCheck(row as never)).fact.kind).toBe("FAILED");
  });

  it("F-30: a seal naming a key absent from the registry is KEY_NOT_PUBLISHED on both surfaces, never 'legacy'", async () => {
    const f = await fixture();
    await prisma.verificationPackage.update({ where: { id: f.full2.id }, data: { sealSigningKeyId: "no-such-key", sealSigningKeyVersion: 9 } as never });
    expect((await get(`/public/verification-packages/${f.full2.id}`)).json().keyBinding).toBe("KEY_NOT_PUBLISHED");
    const { resolvePackageSealCheck } = await import("../src/services/public-verify/package-seal-check.service.js");
    const row = await prisma.verificationPackage.findUniqueOrThrow({ where: { id: f.full2.id } });
    expect((await resolvePackageSealCheck(row as never)).fact.kind).toBe("KEY_NOT_PUBLISHED");
  });

  it("F-30: a bound modern seal is VERIFIED only from its stored bytes; an unreadable package is NOT_CHECKED_NOW, never VERIFIED", async () => {
    const f = await fixture();
    // The fixture's rows point at objects that do not exist in storage.
    const { resolvePackageSealCheck, clearPackageSealCheckMemo } = await import("../src/services/public-verify/package-seal-check.service.js");
    clearPackageSealCheckMemo();
    const row = await prisma.verificationPackage.findUniqueOrThrow({ where: { id: f.full2.id } });
    const check = await resolvePackageSealCheck(row as never);
    expect(check.fact.kind).toBe("NOT_CHECKED_NOW");
    expect(check.completenessVerified).toBeNull();
  });

  /*
   * AUD-05 / AUD-34 (2026-10-20) on the real registry: a key revoked after a
   * first check is stated at once by BOTH surfaces — the package record and
   * the record page's seal check (no restart, no memo) — in ONE sentence, and
   * "after issuance" only when the revocation is in fact later.
   */
  it("AUD-05/34: a revocation after a first check reads KEY_REVOKED on both surfaces, in one sentence", async () => {
    const f = await fixture();
    const keyId = `pkgrec-revoke-${randomUUID().slice(0, 8)}`;
    const k = generateKeyPairSync("ed25519");
    const fp = createHash("sha256").update(k.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const registry = await import("../src/signing/key-registry.js");
    await registry.registerSigningKey(prisma, {
      keyId,
      version: 1,
      purpose: "PACKAGE_SEAL",
      publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const issuedAt = new Date(Date.now() - 60_000);
    await prisma.verificationPackage.update({
      where: { id: f.full1.id },
      data: { sealSigningKeyId: keyId, sealSigningKeyVersion: 1, sealSigningKeySha256: fp, generatedAtUtc: issuedAt } as never,
    });
    const { resolvePackageSealCheck } = await import("../src/services/public-verify/package-seal-check.service.js");
    const { buildVerificationMatrix, PUBLIC_PACKAGE_KEY_BINDING_TEXT } = await import("@proovra/shared");
    const sealRow = () =>
      prisma.verificationPackage.findUniqueOrThrow({
        where: { id: f.full1.id },
        select: {
          id: true,
          packageFormatVersion: true,
          sealSha256: true,
          sealSigningKeySha256: true,
          sealSigningKeyId: true,
          sealSigningKeyVersion: true,
          storageBucket: true,
          storageKey: true,
          s3VersionId: true,
          generatedAtUtc: true,
        },
      });
    const signatureRow = (fact: Parameters<typeof buildVerificationMatrix>[0]["packageSeal"]) =>
      buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: null, packageSeal: fact, publication: { kind: "DOCUMENT" } }).rows.find(
        (r) => r.key === "package_signature",
      )!;

    // F-30 (independent forward audit): a bound seal is VERIFIED only from its
    // stored bytes; this fixture's package objects do not exist, so before the
    // revocation the check is NOT_CHECKED_NOW (it used to read PUBLISHED from
    // the row alone). The binding itself is BOUND.
    expect((await resolvePackageSealCheck(await sealRow())).fact.kind).toBe("NOT_CHECKED_NOW");
    expect((await get(`/public/verification-packages/${f.full1.id}`)).json().keyBinding).toBe("BOUND");

    await prisma.signingKey.updateMany({ where: { keyId, version: 1, purpose: "PACKAGE_SEAL" }, data: { revokedAt: new Date() } });

    const check = await resolvePackageSealCheck(await sealRow());
    expect(check.fact).toMatchObject({ kind: "KEY_REVOKED", revokedAfterIssuance: true });
    const pageBody = (await get(`/public/verification-packages/${f.full1.id}`)).json();
    expect(pageBody.keyBinding).toBe("BOUND_KEY_REVOKED");
    const recordRow = signatureRow(check.fact);
    expect(recordRow.status).toBe("FAILED");
    expect(recordRow.statement).toBe(PUBLIC_PACKAGE_KEY_BINDING_TEXT[pageBody.keyBinding as "BOUND_KEY_REVOKED"]);

    // A package issued AFTER the revocation is never "revoked after issuance".
    await prisma.verificationPackage.update({ where: { id: f.full1.id }, data: { generatedAtUtc: new Date(Date.now() + 60_000) } as never });
    const early = await resolvePackageSealCheck(await sealRow());
    expect(early.fact).toMatchObject({ kind: "KEY_REVOKED", revokedAfterIssuance: false });
    const earlyBody = (await get(`/public/verification-packages/${f.full1.id}`)).json();
    expect(earlyBody.keyBinding).toBe("KEY_REVOKED_BEFORE_ISSUE");
    expect(signatureRow(early.fact).statement).toBe(PUBLIC_PACKAGE_KEY_BINDING_TEXT.KEY_REVOKED_BEFORE_ISSUE);
    expect(signatureRow(early.fact).statement).not.toMatch(/after/);
  });

  it("there is no key-inventory endpoint", async () => {
    const res = await get("/public/signing-keys");
    expect(res.statusCode).toBe(404);
  });

  it("the package record shares the Public Verify per-client budget", async () => {
    const before = process.env.VERIFY_RATE_LIMIT_MAX;
    process.env.VERIFY_RATE_LIMIT_MAX = "2";
    // The harness answers every request as one client: start from an empty budget.
    const { clearAllRateLimitBuckets } = await import("../src/services/rate-limit.js");
    await clearAllRateLimitBuckets();
    try {
      const client = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
      const id = randomUUID();
      const statuses: number[] = [];
      for (const url of [`/public/verify/${id}`, `/public/verification-packages/${id}`, `/public/verification-packages/${id}`]) {
        statuses.push((await harness.app.inject({ method: "GET", url, headers: client })).statusCode);
      }
      // Two answers, then the SAME client's budget is spent across both reads.
      expect(statuses.slice(0, 2).every((s) => s === 404)).toBe(true);
      expect(statuses[2]).toBe(429);
    } finally {
      if (before === undefined) delete process.env.VERIFY_RATE_LIMIT_MAX;
      else process.env.VERIFY_RATE_LIMIT_MAX = before;
    }
  });
  it("AUD-49 — the record's report version is the REPORT's (null when not recorded), never the package row's number", async () => {
    const f = await fixture();
    const legacy = await prisma.verificationPackage.create({
      data: {
        id: randomUUID(),
        evidenceId: f.evidenceId,
        version: 7,
        reportVersion: null,
        state: "PUBLISHED",
        storageBucket: "b",
        storageKey: `p/${f.evidenceId}/7-legacy.zip`,
        generatedAtUtc: new Date(),
        completedAtUtc: new Date(),
        packageSha256: hex(`legacy7${f.evidenceId}`),
      } as never,
      select: { id: true },
    });
    const res = await get(`/public/verification-packages/${legacy.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.reportVersion).toBeNull();
    expect(body.packageVersion).toBe(7);
    const full = (await get(`/public/verification-packages/${f.full1.id}`)).json();
    expect(full).toMatchObject({ reportVersion: 1, packageVersion: 1 });
    expect(typeof full.issuedAtUtc).toBe("string");
    expect(full.issuedAtUtc).not.toBe(new Date(0).toISOString());
  });
});
