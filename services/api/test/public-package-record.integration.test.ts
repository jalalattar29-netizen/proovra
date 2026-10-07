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

  it("a recorded seal fingerprint that disagrees with the registered key is not a binding", async () => {
    const f = await fixture();
    await prisma.verificationPackage.update({ where: { id: f.full2.id }, data: { sealSigningKeySha256: "f".repeat(64) } as never });
    expect((await get(`/public/verification-packages/${f.full2.id}`)).json().keyBinding).toBe("KEY_NOT_PUBLISHED");
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
});
