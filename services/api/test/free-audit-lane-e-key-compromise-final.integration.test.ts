/**
 * FREE-USER AUDIT 0ea0 — B7A-F-006, FINAL PASS (live PostgreSQL).
 *
 * What the residual pass closes, end to end on a real database:
 *   * THE OWNER'S CLIENTS KNOW. The record's artifact status carries
 *     `keyCompromise` (additive, on the existing route), the same evaluation
 *     the replacement action applies: AVAILABLE only when the latest package
 *     was sealed by withdrawn material and an unaffected signer exists.
 *   * EVERY OUTPUT KIND IS COVERED. Custody-event attestations and destruction
 *     certificates signed by the material are found and their people told;
 *     neither is presented as replaceable.
 *   * IN-APP. Each notice also writes a caller-scoped HIGH security event that
 *     /v1/me/inbox lists, linking to the record (no migration).
 *   * HISTORY. Earlier report and package rows, their objects and the versions
 *     list stay byte-identical, and still verify as made by a revoked key.
 *   * NO CHARGE. A committed replacement of a PAID-plan record's LATER version
 *     consumes no storage allowance on EITHER host and no credit.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const ENV_KEYS = ["SIGNING_KEY_ID", "SIGNING_KEY_VERSION", "PACKAGE_SIGNING_KEY_ID", "PACKAGE_SIGNING_KEY_VERSION"] as const;
const IN_APP = "signing_key_compromise_notice";
const MIB = 1024n * 1024n;

describe("free-audit 0ea0 — B7A-F-006 final: client state, all output kinds, in-app, history, no charge (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let rotation: typeof import("../src/services/operations/signer-rotation.service.js");
  let registry: typeof import("../src/services/operations/signer-registry.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let shared: typeof import("@proovra/shared");
  let publicRecord: typeof import("../src/services/public-verify/public-package-record.service.js");
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let enforcement: typeof import("../src/services/billing-enforcement.service.js");
  let worker: typeof import("../../worker/src/workspace-billing.js");
  let clearRates: () => Promise<unknown>;
  const saved: Record<string, string | undefined> = {};
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    rotation = await import("../src/services/operations/signer-rotation.service.js");
    registry = await import("../src/services/operations/signer-registry.service.js");
    runtime = await import("@proovra/shared-runtime");
    shared = await import("@proovra/shared");
    publicRecord = await import("../src/services/public-verify/public-package-record.service.js");
    ({ getWorkspaceUsage: apiUsage } = await import("../src/services/workspace-usage.service.js"));
    enforcement = await import("../src/services/billing-enforcement.service.js");
    worker = await import("../../worker/src/workspace-billing.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    // A PAID workspace: neutrality must not depend on the Free / credit first-issuance rule.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
  }, 300_000);
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await h?.cleanup();
  });

  function keyPem(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  }
  async function register(keyId: string, pem: string, purpose: "EVIDENCE_SIGNATURE" | "PACKAGE_SEAL") {
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: pem, purpose, fingerprintSha256: runtime.publicKeySpkiSha256(pem) } as never,
    });
    return runtime.publicKeySpkiSha256(pem);
  }

  async function issuedRecord(o: { evidenceKey: string; evidenceSha: string; sealKey: string; sealSha: string }) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const e = await prisma.evidence.create({
      data: {
        title: "compromise final fixture",
        type: "PHOTO",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        sizeBytes: 5_000n,
        signingKeyId: o.evidenceKey,
        signingKeyVersion: 1,
        signingKeySha256: o.evidenceSha,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    await prisma.report.create({
      data: { evidenceId: e.id, version: 1, storageBucket: "b", storageKey: `reports/${e.id}/v1.pdf`, generatedAtUtc: new Date(Date.now() - 60_000), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: e.id,
        version: 1,
        reportVersion: 1,
        state: "PUBLISHED",
        packageFormatVersion: 5,
        storageBucket: "b",
        storageKey: `verification/${e.id}/v1.zip`,
        generatedAtUtc: new Date(Date.now() - 60_000),
        sizeBytes: 9_000n,
        sealSigningKeyId: o.sealKey,
        sealSigningKeyVersion: 1,
        sealSigningKeySha256: o.sealSha,
        sealSha256: createHash("sha256").update(e.id).digest("hex"),
      } as never,
    });
    return e.id;
  }

  const status = async (evidenceId: string, token = A().ownerToken) => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/artifacts/status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { keyCompromise: unknown; versions: unknown };
  };
  const replace = (evidenceId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${evidenceId}/reports/regenerate`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
      payload: { intent: "KEY_COMPROMISE_REPLACEMENT" },
    });
  const history = async (evidenceId: string) => ({
    reports: await prisma.report.findMany({ where: { evidenceId, version: 1 } }),
    packages: await prisma.verificationPackage.findMany({ where: { evidenceId, version: 1 } }),
  });
  async function bothHosts() {
    const api = await apiUsage(await enforcement.resolveEnforcementScopeForRequester({ ownerUserId: A().ownerUserId, teamId: A().teamId }));
    const wk = await worker.getWorkspaceUsage(
      await worker.resolveWorkspaceScopeForEvidence({ ownerUserId: A().ownerUserId, teamId: A().teamId }),
    );
    return { api, wk };
  }

  it("owner clients see the record's state; attestations and certificates are covered and never offered a replacement; in-app notice; history and usage are untouched", async () => {
    await clearRates();
    const t = randomUUID().slice(0, 8);
    const ePem = keyPem();
    const pPem = keyPem();
    const qPem = keyPem();
    const eSha = await register(`kf-e-${t}`, ePem, "EVIDENCE_SIGNATURE");
    const pSha = await register(`kf-p-${t}`, pPem, "PACKAGE_SEAL");
    await register(`kf-pe-${t}`, pPem, "EVIDENCE_SIGNATURE");
    const qSha = await register(`kf-q-${t}`, qPem, "PACKAGE_SEAL");
    process.env.SIGNING_KEY_ID = `kf-e-${t}`;
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.PACKAGE_SIGNING_KEY_ID = `kf-p-${t}`;
    process.env.PACKAGE_SIGNING_KEY_VERSION = "1";

    const sealedByP = await issuedRecord({ evidenceKey: `kf-e-${t}`, evidenceSha: eSha, sealKey: `kf-p-${t}`, sealSha: pSha });
    const signedByP = await issuedRecord({ evidenceKey: `kf-pe-${t}`, evidenceSha: pSha, sealKey: `kf-q-${t}`, sealSha: qSha });
    const attestedByP = await issuedRecord({ evidenceKey: `kf-e-${t}`, evidenceSha: eSha, sealKey: `kf-q-${t}`, sealSha: qSha });
    const unaffected = await issuedRecord({ evidenceKey: `kf-e-${t}`, evidenceSha: eSha, sealKey: `kf-q-${t}`, sealSha: qSha });
    // A custody-event attestation of `attestedByP` signed by the material (the
    // row shape custody-attestation.service writes).
    await prisma.securityEvent.create({
      data: {
        teamId: A().teamId,
        eventType: "custody_attestation_signed",
        severity: "INFO",
        details: {
          custodyEventId: randomUUID(),
          keyId: `kf-pe-${t}`,
          keyVersion: "1",
          signerId: `custody_event:local_pem:kf-pe-${t}:1`,
          attestation: { evidenceId: attestedByP, keyId: `kf-pe-${t}`, keyVersion: "1" },
        },
      },
    });
    // A destruction certificate signed by the material (the body destruction-governance writes).
    const destructionRequest = await prisma.destructionRequest.create({
      data: { teamId: A().teamId, state: "CERTIFIED", evidenceIds: [], reason: "fixture", requestedByUserId: A().ownerUserId },
      select: { id: true },
    });
    const certificate = await prisma.destructionCertificate.create({
      data: {
        requestId: destructionRequest.id,
        teamId: A().teamId,
        evidenceCount: 0,
        executedAtUtc: new Date(),
        certifiedAtUtc: new Date(),
        approvalChainUserIds: [],
        certificateHash: "c".repeat(64),
        certificateBody: JSON.stringify(
          { certificateHash: "c".repeat(64), signatureEd25519: { keyId: `kf-pe-${t}`, keyVersion: 1, publicKeySha256: pSha, purpose: "DESTRUCTION_CERTIFICATE" } },
          null,
          2,
        ),
      },
      select: { id: true },
    });

    // Nothing is withdrawn yet: no state for any record.
    expect((await status(sealedByP)).keyCompromise).toBeNull();
    const historyBefore = await history(sealedByP);
    const signedHistoryBefore = await history(signedByP);
    const usageBefore = await bothHosts();

    const signers = await registry.listAllSigners({ teamId: A().teamId });
    const pSigner = signers.find((s) => s.signerPurpose === "verification_package")!.signerId;
    const declared = (await rotation.revokeSigner({
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      signerId: pSigner,
      reason: "lane-e final: key material exposed",
      scope: "key_compromise",
    })) as unknown as { ok: boolean; ownerNotices?: Record<string, number> | null };
    expect(declared.ok).toBe(true);
    // sealedByP (seal), signedByP (record signature), attestedByP (custody attestation) + one certificate.
    expect(declared.ownerNotices).toMatchObject({
      affectedRecords: 3,
      affectedCertificates: 1,
      certificateNotices: 1,
      inAppNotices: 4,
      failed: 0,
      deferred: 0,
    });

    // ---- the owner's clients read the state (artifact status) ----
    expect((await status(sealedByP)).keyCompromise).toEqual({
      outputs: { recordSignature: false, packageSeal: true, latestPackageSeal: true, custodyAttestations: false },
      replacement: "NO_TRUSTWORTHY_SIGNER",
      replacesReportVersion: null,
      callerMayRequest: true,
    });
    expect((await status(signedByP)).keyCompromise).toMatchObject({
      outputs: { recordSignature: true, packageSeal: false },
      replacement: "RECORD_SIGNATURE_NOT_REPLACEABLE",
    });
    expect((await status(attestedByP)).keyCompromise).toMatchObject({
      outputs: { recordSignature: false, packageSeal: false, custodyAttestations: true },
      replacement: "NOT_OFFERED",
    });
    expect((await status(unaffected)).keyCompromise).toBeNull();
    // The shared copy never offers a control for these, and states what is not replaced.
    const described = shared.describeRecordKeyCompromise(shared.parseRecordKeyCompromise((await status(attestedByP)).keyCompromise)!);
    expect(described.actionLabel).toBeNull();
    expect(described.notReplaced.join(" ")).toMatch(/Custody-event attestations made with the withdrawn key are not re-signed/);

    // The action agrees with the state it was shown.
    const notOffered = await replace(attestedByP);
    expect(notOffered.statusCode, notOffered.body).toBe(409);
    expect(notOffered.json().code).toBe("KEY_COMPROMISE_REPLACEMENT_NOT_AFFECTED");

    // ---- in-app: one caller-scoped item per subject, linking to it ----
    const inApp = await prisma.securityEvent.findMany({
      where: { eventType: IN_APP, userId: A().ownerUserId },
      select: { details: true, severity: true },
    });
    const subjects = inApp.map((r) => r.details as Record<string, unknown>);
    expect(subjects.filter((d) => d.evidenceId === sealedByP)).toHaveLength(1);
    expect(subjects.filter((d) => d.evidenceId === attestedByP)).toHaveLength(1);
    expect(subjects.filter((d) => d.certificateId === certificate.id)).toHaveLength(1);
    expect(subjects.filter((d) => d.evidenceId === unaffected)).toHaveLength(0);
    const inbox = await h.app.inject({ method: "GET", url: "/v1/me/inbox", headers: { authorization: `Bearer ${A().ownerToken}` } });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const hrefs = ((inbox.json() as { items: Array<{ category: string; href: string }> }).items ?? [])
      .filter((i) => i.category === "security_event_high")
      .map((i) => i.href);
    expect(hrefs).toContain(`/evidence/${sealedByP}`);
    expect(hrefs).toContain("/governance/destruction");
    // A repeated declaration writes no second notice of either kind.
    const again = (await rotation.revokeSigner({
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      signerId: pSigner,
      reason: "lane-e final: repeat",
      scope: "key_compromise",
    })) as unknown as { ownerNotices?: Record<string, number> | null };
    expect(again.ownerNotices).toMatchObject({ inAppNotices: 0, certificateNotices: 0, alreadyNotified: 4 });
    expect(await prisma.securityEvent.count({ where: { eventType: IN_APP, userId: A().ownerUserId } })).toBe(inApp.length);

    // ---- rotate to an unaffected seal: AVAILABLE, then IN_PROGRESS ----
    const nPem = keyPem();
    const nSha = await register(`kf-n-${t}`, nPem, "PACKAGE_SEAL");
    process.env.PACKAGE_SIGNING_KEY_ID = `kf-n-${t}`;
    expect((await status(sealedByP)).keyCompromise).toMatchObject({ replacement: "AVAILABLE", replacesReportVersion: 1, callerMayRequest: true });
    const credits = await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: sealedByP } });
    const asked = await replace(sealedByP);
    expect(asked.statusCode, asked.body).toBe(202);
    expect((await status(sealedByP)).keyCompromise).toMatchObject({ replacement: "IN_PROGRESS", replacesReportVersion: 1 });

    // ---- the replacement commits (as the worker would): v2 sealed by N ----
    await prisma.report.create({
      data: { evidenceId: sealedByP, version: 2, previousReportVersion: 1, storageBucket: "b", storageKey: `reports/${sealedByP}/v2.pdf`, generatedAtUtc: new Date(), sizeBytes: 3n * MIB } as never,
    });
    const v2 = await prisma.verificationPackage.create({
      data: {
        evidenceId: sealedByP,
        version: 2,
        reportVersion: 2,
        state: "PUBLISHED",
        packageFormatVersion: 5,
        storageBucket: "b",
        storageKey: `verification/${sealedByP}/v2.zip`,
        generatedAtUtc: new Date(),
        sizeBytes: 50n * MIB,
        sealSigningKeyId: `kf-n-${t}`,
        sealSigningKeyVersion: 1,
        sealSigningKeySha256: nSha,
        sealSha256: createHash("sha256").update(`${sealedByP}:2`).digest("hex"),
      } as never,
      select: { id: true },
    });
    await prisma.reportGenerationRequest.updateMany({
      where: { evidenceId: sealedByP, purpose: "signing_key_compromise_replacement" },
      data: { state: "SUCCEEDED", stage: "PACKAGE_PUBLISHED", reportVersion: 2, completedAtUtc: new Date() } as never,
    });
    const after = (await status(sealedByP)) as { keyCompromise: unknown; versions: { versions: Array<{ reportVersion: number; package: { sealKey: unknown } | null }> } };
    expect(after.keyCompromise).toMatchObject({ replacement: "LATEST_UNAFFECTED", outputs: { packageSeal: true, latestPackageSeal: false } });

    // ---- history: v1 rows unchanged, listed with its own seal key, still verifies as revoked ----
    expect(await history(sealedByP)).toEqual(historyBefore);
    expect(await history(signedByP)).toEqual(signedHistoryBefore);
    const v1 = after.versions.versions.find((v) => v.reportVersion === 1)!;
    expect(v1.package?.sealKey).toEqual({ keyId: `kf-p-${t}`, version: 1, fingerprintSha256: pSha });
    expect(after.versions.versions.map((v) => v.reportVersion)).toEqual([2, 1]);
    const v1Public = await publicRecord.projectPublicPackageRecord((await publicRecord.findPublishedPackageById(historyBefore.packages[0]!.id))!);
    expect(v1Public.keyBinding).toBe("BOUND_KEY_REVOKED");
    const v2Public = await publicRecord.projectPublicPackageRecord((await publicRecord.findPublishedPackageById(v2.id))!);
    expect(v2Public.keyBinding).toBe("BOUND");
    // The record signature made by the material reads REVOKED_KEY.
    const facts = await runtime.loadRecordSigningKeyFacts(prisma as never, { keyId: `kf-pe-${t}`, version: 1, recordSigningKeySha256: pSha });
    expect(shared.resolveRecordSignatureValidity({ signed: true, cryptoValid: true, key: facts.key, keyMatchesRecord: facts.keyMatchesRecord }).state).toBe("REVOKED_KEY");

    // ---- no charge: the replacement's 53 MiB is stored but not customer storage, on BOTH hosts ----
    const usageAfter = await bothHosts();
    expect(usageAfter.api.actualStorageBytes - usageBefore.api.actualStorageBytes).toBe(53n * MIB);
    expect(usageAfter.api.storageBytesUsed).toBe(usageBefore.api.storageBytesUsed);
    expect(usageAfter.wk.storageBytesUsed).toBe(usageBefore.wk.storageBytesUsed);
    expect(usageAfter.wk.storageBytesUsed).toBe(usageAfter.api.storageBytesUsed);
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: sealedByP } })).toBe(credits);
  });

  it("the inline fan-out is bounded: over the limit the rest is deferred, and a repeat continues where it stopped", async () => {
    const owners = await import("../src/services/operations/signing-key-compromise-owners.service.js");
    const t = randomUUID().slice(0, 8);
    const xPem = keyPem();
    const xSha = await register(`kl-x-${t}`, xPem, "PACKAGE_SEAL");
    const eSha = await register(`kl-e-${t}`, keyPem(), "EVIDENCE_SIGNATURE");
    const a = await issuedRecord({ evidenceKey: `kl-e-${t}`, evidenceSha: eSha, sealKey: `kl-x-${t}`, sealSha: xSha });
    const b = await issuedRecord({ evidenceKey: `kl-e-${t}`, evidenceSha: eSha, sealKey: `kl-x-${t}`, sealSha: xSha });
    const declaredAt = new Date(Date.now() - 1_000);
    await prisma.signingKey.updateMany({ where: { keyId: `kl-x-${t}` }, data: { revokedAt: declaredAt } });
    const material = { fingerprints: [xSha], keyIdentities: [{ keyId: `kl-x-${t}`, version: 1 }], declaredAt, actorUserId: null, inlineLimit: 1 };
    expect(owners.KEY_COMPROMISE_INLINE_NOTICE_LIMIT).toBe(500);
    const first = await owners.notifyOwnersOfKeyCompromise(material, prisma as never);
    expect(first).toMatchObject({ affectedRecords: 2, inAppNotices: 1, deferred: 1, alreadyNotified: 0 });
    const second = await owners.notifyOwnersOfKeyCompromise(material, prisma as never);
    expect(second).toMatchObject({ affectedRecords: 2, inAppNotices: 1, deferred: 0, alreadyNotified: 1 });
    const third = await owners.notifyOwnersOfKeyCompromise(material, prisma as never);
    expect(third).toMatchObject({ inAppNotices: 0, deferred: 0, alreadyNotified: 2 });
    for (const id of [a, b]) {
      expect(
        await prisma.securityEvent.count({ where: { eventType: IN_APP, userId: A().ownerUserId, details: { path: ["evidenceId"], equals: id } } }),
      ).toBe(1);
    }
  });
});
