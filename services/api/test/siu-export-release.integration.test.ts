/**
 * SIU EXPORT — WHAT LEAVES IN THE BUNDLE (2026-09-29, audits H1 + M2) — live
 * PostgreSQL 16, real HTTP, a recording object store.
 *
 * The bundle carries each case record's latest report and the package paired
 * with it. Pinned here, on the real route and the real ZIP bytes:
 *   * an artifact that exists and is released by THE per-record download gate
 *     is IN the ZIP at its documented path, and counted as included;
 *   * an artifact that does not exist is NOT in the ZIP, is listed with its
 *     missing reason, and is counted as missing — the persisted
 *     artifact_inclusion_json record says exactly what the bundle carried;
 *   * a record whose package the workspace policy refuses, or which is under
 *     a case-scope legal hold (invisible to the preflight), withholds the
 *     WHOLE export: 403, no bundle bytes, no "generated" history row;
 *   * a stored bundle cannot be downloaded again once a hold applies.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./point5/_zip-entries.js";

const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const body = store.objects.get(`${p.bucket}/${p.key}`);
      if (!body) {
        const err = new Error(`NoSuchKey: ${p.key}`) as Error & { $metadata: unknown };
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      const { Readable } = await import("node:stream");
      return Readable.from([body]);
    },
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      store.objects.set(`${p.bucket}/${p.key}`, p.body);
      return { versionId: null };
    },
  };
});

describe("SIU export — released artifacts only (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let totpSecret: Buffer;
  const bucket = "siu-fixture-bucket";
  const REASON = "operator reviewed the warnings";

  beforeAll(async () => {
    process.env.S3_BUCKET = bucket;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    // The export is a step-up action: the owner gets a real authenticator.
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    totpSecret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(totpSecret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId: h.fixtures.teamA.ownerUserId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "Authenticator",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
  }, 180_000);

  /** One real step-up round trip for the SIU export of this case. */
  async function stepUp(caseId: string): Promise<string> {
    const { teamA } = h.fixtures;
    const auth = { authorization: `Bearer ${teamA.ownerToken}` };
    const started = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      headers: auth,
      payload: { teamId: teamA.teamId, purpose: "SIU_EXPORT_GENERATE", resourceKind: "case", resourceId: caseId },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    // Each authenticator time step is accepted once; return the factor to
    // "last accepted in an earlier window" (the replay guard is untouched).
    await prisma.mfaFactor.updateMany({ where: { userId: teamA.ownerUserId, kind: "TOTP" }, data: { lastUsedAt: null } });
    const code = totp.computeTotpCode(totpSecret, totp.timeStep(Math.floor(Date.now() / 1000)));
    const checked = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      headers: auth,
      payload: { teamId: teamA.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  afterAll(async () => {
    await h?.cleanup();
  });

  async function siuCase() {
    const { teamA } = h.fixtures;
    const c = await prisma.case.create({
      data: { name: `siu-rel-${randomUUID().slice(0, 8)}`, teamId: teamA.teamId, ownerUserId: teamA.ownerUserId } as never,
      select: { id: true },
    });
    await prisma.caseSiuProfile.create({
      data: { caseId: c.id, teamId: teamA.teamId, claimType: "auto", investigationStatus: "open" } as never,
    });
    return c.id;
  }

  /** A record on the case with report v1 and (optionally) its package v1, stored. */
  async function caseRecord(caseId: string, withPackage: boolean) {
    const { teamA } = h.fixtures;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: "siu record",
        type: "DOCUMENT",
        status: "REPORTED",
        teamId: teamA.teamId,
        organizationId: team.organizationId,
        ownerUserId: teamA.ownerUserId,
        latestReportVersion: 1,
        reportGeneratedAtUtc: new Date(),
        ...(withPackage ? { verificationPackageGeneratedAtUtc: new Date() } : {}),
      } as never,
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: ev.id } as never });
    const reportKey = `reports/${ev.id}/v1.pdf`;
    await prisma.report.create({
      data: { evidenceId: ev.id, version: 1, storageBucket: bucket, storageKey: reportKey, generatedAtUtc: new Date() },
    });
    store.objects.set(`${bucket}/${reportKey}`, Buffer.from(`%PDF report ${ev.id}`));
    if (withPackage) {
      const pkgKey = `verification/${ev.id}/v1.zip`;
      await prisma.verificationPackage.create({
        data: { evidenceId: ev.id, version: 1, storageBucket: bucket, storageKey: pkgKey, generatedAtUtc: new Date() } as never,
      });
      store.objects.set(`${bucket}/${pkgKey}`, Buffer.from(`PK package ${ev.id}`));
    }
    return ev.id;
  }

  const exportBundle = async (caseId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/siu-export`,
      headers: {
        authorization: `Bearer ${h.fixtures.teamA.ownerToken}`,
        "x-proovra-step-up-challenge-id": await stepUp(caseId),
      },
      payload: { warningExportReason: REASON },
    });

  it("released artifacts are in the ZIP; a missing package is listed and counted, never invented", async () => {
    const caseId = await siuCase();
    const full = await caseRecord(caseId, true);
    const reportOnly = await caseRecord(caseId, false);

    const res = await exportBundle(caseId);
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const entries = readZipEntries(res.rawPayload);

    expect(entries.get(`reports/${full}/report.pdf`)?.toString()).toBe(`%PDF report ${full}`);
    expect(entries.get(`verification/${full}/verification-package.zip`)?.toString()).toBe(`PK package ${full}`);
    expect(entries.get(`reports/${reportOnly}/report.pdf`)?.toString()).toBe(`%PDF report ${reportOnly}`);
    expect(entries.has(`verification/${reportOnly}/verification-package.zip`)).toBe(false);
    // No original bytes are ever bundled.
    expect([...entries.keys()].some((k) => k.startsWith("evidence/"))).toBe(false);

    const index = JSON.parse(entries.get("integrity-provenance-summary.json")!.toString()) as {
      inventory: Array<{ evidenceId: string; verificationPackage: { includedInBundle: boolean; missingReason: string | null } }>;
    };
    const missing = index.inventory.find((r) => r.evidenceId === reportOnly)!;
    expect(missing.verificationPackage).toMatchObject({
      includedInBundle: false,
      missingReason: "no_verification_package_available",
    });

    const row = await prisma.caseSiuExport.findFirstOrThrow({ where: { caseId }, orderBy: { generatedAtUtc: "desc" } });
    expect(row.artifactInclusionJson).toEqual({
      reportsIncluded: 2,
      reportsMissing: 0,
      verificationPackagesIncluded: 1,
      verificationPackagesMissing: 1,
    });
  });

  it("a record whose package the workspace policy refuses withholds the whole export", async () => {
    const { teamA } = h.fixtures;
    const caseId = await siuCase();
    await caseRecord(caseId, true);
    const existing = await prisma.workspaceGovernancePolicy.findFirst({ where: { teamId: teamA.teamId }, select: { id: true } });
    if (existing) {
      await prisma.workspaceGovernancePolicy.update({ where: { id: existing.id }, data: { allowPackageDownload: false } });
    } else {
      await prisma.workspaceGovernancePolicy.create({ data: { teamId: teamA.teamId, allowPackageDownload: false } as never });
    }
    try {
      const res = await exportBundle(caseId);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(403);
      expect(res.json().error).toMatchObject({ code: "siu_export_blocked_by_policy", withheldRecords: 1 });
      expect(res.headers["content-type"]).not.toContain("application/zip");
      expect(await prisma.caseSiuExport.count({ where: { caseId } })).toBe(0);
    } finally {
      await prisma.workspaceGovernancePolicy.updateMany({ where: { teamId: teamA.teamId }, data: { allowPackageDownload: true } });
    }
  });

  it("a case-scope legal hold withholds the export and a stored bundle's download", async () => {
    const { teamA } = h.fixtures;
    const caseId = await siuCase();
    await caseRecord(caseId, true);

    // Generated before the hold …
    const first = await exportBundle(caseId);
    expect(first.statusCode, first.body.slice(0, 300)).toBe(200);
    const exportId = first.headers["x-proovra-siu-export-id"] as string;

    const held = await prisma.evidenceLegalHold.create({
      data: { teamId: teamA.teamId, scope: "CASE", caseId, title: "siu hold", placedByUserId: teamA.ownerUserId } as never,
      select: { id: true },
    });
    try {
      const again = await exportBundle(caseId);
      expect(again.statusCode, again.body.slice(0, 300)).toBe(403);
      expect(again.json().error.code).toBe("siu_export_blocked_by_policy");

      const download = await h.app.inject({
        method: "GET",
        url: `/v1/cases/${caseId}/siu-exports/${exportId}/download`,
        headers: { authorization: `Bearer ${teamA.ownerToken}` },
      });
      expect(download.statusCode, download.body.slice(0, 300)).toBe(403);
      expect(download.json().error.code).toBe("siu_export_blocked_by_policy");
      expect(await prisma.caseSiuExport.count({ where: { caseId } })).toBe(1);
    } finally {
      await prisma.evidenceLegalHold.update({ where: { id: held.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
    }
  });
});
