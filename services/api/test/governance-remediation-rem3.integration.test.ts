/**
 * Round 3 governance follow-up, on live PostgreSQL 16 and Redis:
 *
 *   GOV-005   one retention policy store: the lifecycle page writes the store
 *             records bind to; the retired table refuses writes; the copy
 *             migration moves a legacy row under its own id
 *   GOV-012   a held record is released to the workspace (recorded on custody)
 *             and refused to the public
 *   GOV-015   the organization owner's offboarding export: owner only, built
 *             by the tick, links bound to the sealed version, custody per record
 *   CRYPTO-008 the recovery sweep asks the verifier once and enqueues nothing
 *             while it cannot answer (measured against a dead loopback port)
 *   CAP-6/7   the legacy contract fallback is audited once per organization per window
 *   CAP-8     a routine ALLOW is recorded once per window; a BLOCK always
 *   REPORT-014 a seal byte check stored by one process answers another
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = typeof import("../src/db.js")["prisma"];

describe("round 3 governance follow-up (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let lifecycleRetention: typeof import("../src/services/lifecycle/retention-engine.service.js");
  let exportGate: typeof import("../src/services/governance-lifecycle/export-governance.service.js");
  let downloadGate: typeof import("../src/services/evidence/artifact-download-gate.service.js");
  let orgExport: typeof import("../src/services/organization/organization-data-export.service.js");
  let binding: typeof import("@proovra/shared-runtime");
  let otsReconciler: typeof import("../../worker/src/ots-initialization-reconciler.js");
  let otsVerifier: typeof import("../../worker/src/ots-bitcoin-verifier.js");
  let contracts: typeof import("../src/services/organization/enterprise-contract.service.js");
  let evaluation: typeof import("../src/services/governance/policy-evaluation.service.js");
  let sealCheck: typeof import("../src/services/public-verify/package-seal-check.service.js");

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  async function record(teamId: string, ownerUserId: string, extra: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title: `rem3-gov ${randomUUID().slice(0, 8)}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId, ...extra } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    binding = await import("@proovra/shared-runtime");
    binding.registerPrisma(prisma as never);
    lifecycleRetention = await import("../src/services/lifecycle/retention-engine.service.js");
    exportGate = await import("../src/services/governance-lifecycle/export-governance.service.js");
    downloadGate = await import("../src/services/evidence/artifact-download-gate.service.js");
    orgExport = await import("../src/services/organization/organization-data-export.service.js");
    otsReconciler = await import("../../worker/src/ots-initialization-reconciler.js");
    otsVerifier = await import("../../worker/src/ots-bitcoin-verifier.js");
    contracts = await import("../src/services/organization/enterprise-contract.service.js");
    evaluation = await import("../src/services/governance/policy-evaluation.service.js");
    sealCheck = await import("../src/services/public-verify/package-seal-check.service.js");
    // The fixture plan allows one year; the lifecycle page's templates need more.
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({ teamId: A().teamId, key: "RETENTION_MAX_YEARS", value: 100, kind: "QUOTA", source: "CUSTOM", grantedByUserId: A().ownerUserId } as never);
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  describe("GOV-005 one retention store", () => {
    it("a lifecycle-page policy is written to the store records bind to, and binds a new record", async () => {
      const name = `rem3 lifecycle ${randomUUID().slice(0, 6)}`;
      const created = await lifecycleRetention.createRetentionPolicy({
        prisma: prisma as never,
        teamId: A().teamId,
        name,
        template: "INSURANCE_7Y",
        scopeKind: "WORKSPACE",
        createdByUserId: A().ownerUserId,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));
      const row = await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id: created.policyId } });
      expect(row).toMatchObject({ teamId: A().teamId, status: "ACTIVE", scope: "WORKSPACE", retentionDays: Math.round(7 * 365.25) });
      expect(row.description).toBe("lifecycle-template:INSURANCE_7Y");
      // Nothing was written to the retired table.
      expect(await prisma.retentionPolicyConfig.count({ where: { id: created.policyId } })).toBe(0);
      // The record binding sees it (before: it never could).
      const bound = await binding.resolveRecordRetentionBinding(prisma as never, { teamId: A().teamId });
      expect(bound?.retentionDays).toBeGreaterThanOrEqual(Math.round(7 * 365.25));
      // The page's list shows it in the page's shape.
      const listed = await lifecycleRetention.listRetentionPolicies({ prisma: prisma as never, teamId: A().teamId });
      expect(listed.find((p) => p.id === created.policyId)).toMatchObject({ name, template: "INSURANCE_7Y", years: 7 });
      // Release archives it in the one store.
      expect((await lifecycleRetention.releaseRetentionPolicy({ prisma: prisma as never, teamId: A().teamId, policyId: created.policyId, actorUserId: A().ownerUserId })).ok).toBe(true);
      expect((await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id: created.policyId } })).status).toBe("ARCHIVED");
      // Another workspace cannot release it.
      expect((await lifecycleRetention.releaseRetentionPolicy({ prisma: prisma as never, teamId: B().teamId, policyId: created.policyId, actorUserId: B().ownerUserId })).ok).toBe(false);
    });

    it("what the binding cannot honour is refused, not stored and ignored", async () => {
      const base = { prisma: prisma as never, teamId: A().teamId, template: "CUSTOM" as const, years: 3, createdByUserId: A().ownerUserId };
      expect(await lifecycleRetention.createRetentionPolicy({ ...base, name: "dept", scopeKind: "DEPARTMENT", scopeTargetId: randomUUID() })).toMatchObject({ ok: false, reason: "scope_not_bindable" });
      expect(await lifecycleRetention.createRetentionPolicy({ ...base, name: "zero", years: 0, scopeKind: "WORKSPACE" })).toMatchObject({ ok: false, reason: "years_out_of_range" });
      expect(await lifecycleRetention.createRetentionPolicy({ ...base, name: "exc", scopeKind: "WORKSPACE", exceptions: [randomUUID()] })).toMatchObject({ ok: false, reason: "not_supported_by_binding" });
      // A case of another workspace is not a scope target here.
      expect(await lifecycleRetention.createRetentionPolicy({ ...base, name: "foreign case", scopeKind: "CASE", scopeTargetId: B().caseId })).toMatchObject({ ok: false, reason: "case_not_in_workspace" });
    });

    it("the retired table refuses writes; the copy migration moves a legacy row under its own id", async () => {
      await expect(
        prisma.retentionPolicyConfig.create({
          data: { teamId: A().teamId, name: "late", template: "CUSTOM", years: 2, scopeKind: "WORKSPACE", createdByUserId: A().ownerUserId },
        }),
      ).rejects.toThrow(/retired/);
      // A row written before the migration (inserted with triggers off, as the
      // pre-migration table allowed), then the migration's copy re-run.
      const legacyId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        await tx.$executeRawUnsafe(
          `INSERT INTO retention_policy_configs (id, team_id, name, template, years, scope_kind, exceptions, created_by_user_id, updated_at) VALUES ($1::uuid, $2::uuid, 'legacy wizard policy', 'CORPORATE_5Y', 5, 'WORKSPACE', '[]'::jsonb, $3::uuid, now()),
                  (gen_random_uuid(), $2::uuid, 'legacy dept', 'CUSTOM', 4, 'DEPARTMENT', '[]'::jsonb, $3::uuid, now())`,
          legacyId,
          A().teamId,
          A().ownerUserId,
        );
      });
      const sql = readFileSync(new URL("../prisma/migrations/20281119100100_retention_policy_single_store/migration.sql", import.meta.url), "utf8");
      const statements = sql
        .split(/;\s*\n/)
        .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter((s) => s.startsWith("INSERT INTO"));
      for (const statement of statements) await prisma.$executeRawUnsafe(statement);
      const copied = await prisma.evidenceRetentionPolicy.findUniqueOrThrow({ where: { id: legacyId } });
      expect(copied).toMatchObject({ status: "ACTIVE", scope: "WORKSPACE", retentionDays: Math.round(5 * 365.25), description: "lifecycle-template:CORPORATE_5Y" });
      expect(await prisma.evidenceRetentionPolicyVersion.count({ where: { retentionPolicyId: legacyId, version: 1 } })).toBe(1);
      const dept = await prisma.evidenceRetentionPolicy.findFirstOrThrow({ where: { teamId: A().teamId, displayName: "legacy dept" } });
      expect(dept.status).toBe("ARCHIVED");
      expect(dept.description).toMatch(/DEPARTMENT scope cannot bind/);
      // Idempotent, and the historic row is still there.
      for (const statement of statements) await prisma.$executeRawUnsafe(statement);
      expect(await prisma.evidenceRetentionPolicy.count({ where: { id: legacyId } })).toBe(1);
      expect(await prisma.retentionPolicyConfig.count({ where: { id: legacyId } })).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe("GOV-012 a hold preserves", () => {
    it("a held record is released to the workspace with the hold on its custody event, and refused to the public", async () => {
      const own = await record(A().teamId, A().ownerUserId);
      const hold = await prisma.evidenceLegalHold.create({
        data: { teamId: A().teamId, scope: "EVIDENCE", evidenceId: own.id, status: "ACTIVE", title: "rem3 hold", placedByUserId: A().ownerUserId },
        select: { id: true },
      });
      const workspace = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: own.id });
      expect(workspace).toMatchObject({ outcome: "ALLOWED", underLegalHold: true });
      const publicRelease = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: own.id, audience: "public" });
      expect(publicRelease.outcome).toBe("BLOCKED_BY_HOLD");
      await downloadGate.recordDownloadAuthorized({ evidenceId: own.id, actorUserId: A().ownerUserId, artifact: "report" });
      const event = await prisma.custodyEvent.findFirstOrThrow({
        where: { evidenceId: own.id, eventType: "DOWNLOAD_AUTHORIZED" },
        orderBy: { atUtc: "desc" },
      });
      expect((event.payload as { underLegalHold?: boolean }).underLegalHold).toBe(true);
      // Destruction stays refused under hold (lifecycle gate unchanged): a
      // destroyed or pending-destruction record is still blocked for everyone.
      const pending = await record(A().teamId, A().ownerUserId, { lifecycleState: "PENDING_DESTRUCTION" });
      expect((await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: pending.id })).outcome).toBe("BLOCKED_BY_LIFECYCLE");
      // Released: no hold flag.
      await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } });
      const after = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: own.id });
      expect(after).toMatchObject({ outcome: "ALLOWED", reason: "ok" });
      expect(after.underLegalHold).toBeUndefined();
      // Another workspace's record is never found through this workspace.
      const theirs = await record(B().teamId, B().ownerUserId);
      expect((await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: theirs.id })).outcome).toBe("BLOCKED_BY_POLICY");
    });
  });

  // ---------------------------------------------------------------------------
  describe("GOV-015 organization offboarding export", () => {
    const orgOf = async (teamId: string) =>
      (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId!;

    it("only the organization owner may ask; a member of another organization gets 404", async () => {
      const orgId = await orgOf(A().teamId);
      const call = (token: string) =>
        h.app.inject({ method: "POST", url: `/v1/orgs/${orgId}/data-export`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: "{}" });
      expect((await call(B().ownerToken)).statusCode).toBe(404);
      const owner = await call(A().ownerToken);
      // Without proof the owner is asked to step up, and nothing is created.
      expect(owner.statusCode).not.toBe(201);
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it("the tick builds a manifest of every workspace's records with sealed versions; links are custody-recorded", async () => {
      const orgId = await orgOf(A().teamId);
      const held = await record(A().teamId, A().ownerUserId, { storageBucket: "rem3-org-export", storageKey: `org/${randomUUID()}.jpg`, storageVersionId: "v-sealed-1", fileSha256: "a".repeat(64), sizeBytes: 10n });
      await prisma.evidenceLegalHold.create({
        data: { teamId: A().teamId, scope: "EVIDENCE", evidenceId: held.id, status: "ACTIVE", title: "rem3 org export hold", placedByUserId: A().ownerUserId },
      });
      const foreign = await record(B().teamId, B().ownerUserId, { storageBucket: "rem3-org-export", storageKey: `org/${randomUUID()}.jpg` });
      const req = await prisma.organizationDataExportRequest.create({
        data: { organizationId: orgId, requestedByUserId: A().ownerUserId },
        select: { id: true },
      });
      const storage = { listObjectVersions: async () => [{ versionId: "v-sealed-1", isDeleteMarker: false }] } as never;
      const summary = await orgExport.processOrganizationDataExports(new Date(), { client: prisma as never, storage });
      expect(summary.generated).toBeGreaterThanOrEqual(1);
      const row = await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe("READY");
      expect(row.expiresAtUtc!.getTime()).toBeGreaterThan(Date.now());
      const pkg = JSON.parse(row.manifestJson!) as import("../src/services/organization/organization-data-export.service.js").OrganizationExportPackage;
      const entry = pkg.manifest.records.find((r) => r.evidenceId === held.id);
      expect(entry).toMatchObject({ legalHold: true });
      expect(entry!.objects[0]).toMatchObject({ versionId: "v-sealed-1", sha256: "a".repeat(64) });
      // The other organization's record is not in it.
      expect(pkg.manifest.records.some((r) => r.evidenceId === foreign.id)).toBe(false);
      // Links are bound to the sealed version and recorded on custody.
      const page = await orgExport.issueOrganizationExportLinks({ manifest: pkg.manifest, exportId: req.id, actorUserId: A().ownerUserId, offset: 0 });
      const link = page.links.find((l) => l.evidenceId === held.id)!;
      expect(link.url).toContain("versionId=v-sealed-1");
      const custody = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: held.id, eventType: "DOWNLOAD_AUTHORIZED" }, orderBy: { atUtc: "desc" } });
      expect(custody.payload).toMatchObject({ accessedByUserId: A().ownerUserId, underLegalHold: true });
      // A second request while one is READY is refused at the route; expiry clears the manifest.
      await prisma.organizationDataExportRequest.update({ where: { id: req.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
      await orgExport.processOrganizationDataExports(new Date(), { client: prisma as never, storage });
      expect(await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: req.id }, select: { status: true, manifestJson: true } })).toEqual({ status: "EXPIRED", manifestJson: null });
    });
  });

  // ---------------------------------------------------------------------------
  it("CRYPTO-008: with the verifier down the sweep probes once and enqueues no chain check; when it answers, the owed checks are enqueued", async () => {
    const anchoredAt = new Date(Date.now() - 30 * 86_400_000);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(
        (await record(A().teamId, A().ownerUserId, {
          otsStatus: "ANCHORED",
          otsProofBase64: Buffer.from(`rem3-proof-${i}`).toString("base64"),
          otsAnchoredAtUtc: anchoredAt,
          otsChainVerificationStatus: "UNAVAILABLE",
          otsChainCheckedAtUtc: new Date(Date.now() - 2 * 86_400_000),
        })).id,
      );
    }
    const saved = { enabled: process.env.OTS_BITCOIN_VERIFY_ENABLED, url: process.env.OTS_BITCOIN_RPC_URL };
    process.env.OTS_BITCOIN_VERIFY_ENABLED = "true";
    process.env.OTS_BITCOIN_RPC_URL = "http://127.0.0.1:1"; // a stopped node
    try {
      let probes = 0;
      const realProbe = async (config: import("../../worker/src/ots-bitcoin-config.js").OtsBitcoinVerifierConfig) => {
        probes += 1;
        return (await otsVerifier.probeOtsBitcoinVerifierReadiness({ config }).catch(() => ({ ready: false }))).ready === true;
      };
      const down = await otsReconciler.runOtsInitializationReconciler({ trigger: "rem3", batchSize: 50, probeVerifierReadiness: realProbe });
      expect(probes).toBe(1);
      // Before: every one of the 12 was re-enqueued on every tick.
      expect(down.chainRescheduled).toBe(0);
      expect(down.chainSkippedVerifierUnavailable).toBe(1);
      const up = await otsReconciler.runOtsInitializationReconciler({ trigger: "rem3", batchSize: 50, probeVerifierReadiness: async () => true });
      expect(up.chainScanned).toBeGreaterThanOrEqual(ids.length);
    } finally {
      if (saved.enabled === undefined) delete process.env.OTS_BITCOIN_VERIFY_ENABLED;
      else process.env.OTS_BITCOIN_VERIFY_ENABLED = saved.enabled;
      if (saved.url === undefined) delete process.env.OTS_BITCOIN_RPC_URL;
      else process.env.OTS_BITCOIN_RPC_URL = saved.url;
    }
  }, 180_000);

  // ---------------------------------------------------------------------------
  it("CAP-6 / CAP-7: the legacy contract fallback is audited once per organization per window and counted every time", async () => {
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId!;
    await prisma.enterpriseContract.deleteMany({ where: { organizationId: orgId } });
    contracts.resetLegacyFallbackAuditWindows();
    const since = new Date();
    for (let i = 0; i < 5; i += 1) await contracts.resolveEnterpriseContract(orgId, prisma as never);
    // emitTenantAudit is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 500));
    expect(
      await prisma.adminAuditLog.count({ where: { action: "billing.enterprise_contract_legacy_fallback", createdAt: { gte: since } } }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it("CAP-8: a routine ALLOW is recorded once per window; a different workspace still gets its own row", async () => {
    evaluation.resetRoutineEvaluationAuditWindows();
    const rows = (teamId: string) => prisma.governancePolicyAudit.count({ where: { teamId, code: "POLICY_EVALUATED" } });
    const a0 = await rows(A().teamId);
    for (let i = 0; i < 4; i += 1) await evaluation.evaluateRedactionPolicy({ teamId: A().teamId, evidenceId: randomUUID() });
    expect((await rows(A().teamId)) - a0).toBe(1);
    const b0 = await rows(B().teamId);
    await evaluation.evaluateRedactionPolicy({ teamId: B().teamId, evidenceId: randomUUID() });
    expect((await rows(B().teamId)) - b0).toBe(1);
    // A later window records again.
    expect(evaluation.coalesceRoutineEvaluation(A().teamId, null, "x", Date.now())).toBe(false);
    expect(evaluation.coalesceRoutineEvaluation(A().teamId, null, "x", Date.now() + 1000)).toBe(true);
    expect(evaluation.coalesceRoutineEvaluation(A().teamId, null, "x", Date.now() + evaluation.ROUTINE_EVALUATION_AUDIT_WINDOW_MS + 1)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  it("REPORT-014: a seal byte check stored by one process answers another without re-reading the package", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const fp = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const keyId = `rem3-seal-${randomUUID().slice(0, 6)}`;
    await prisma.signingKey.create({ data: { keyId, version: 1, purpose: "PACKAGE_SEAL", publicKeyPem: pem, fingerprintSha256: fp, algorithm: "Ed25519" } as never });
    const pkg = {
      id: randomUUID(),
      packageFormatVersion: 5,
      sealSha256: "b".repeat(64),
      sealSigningKeySha256: fp,
      sealSigningKeyId: keyId,
      sealSigningKeyVersion: 1,
      storageBucket: "rem3-no-such-bucket",
      storageKey: `pkg/${randomUUID()}.zip`,
      s3VersionId: "v1",
    };
    sealCheck.clearPackageSealCheckMemo();
    // Nothing stored and the bytes unreadable: not checked now, and nothing stored.
    expect((await sealCheck.resolvePackageSealCheck(pkg)).fact.kind).toBe("NOT_CHECKED_NOW");
    expect(await prisma.packageSealByteCheck.count({ where: { packageId: pkg.id } })).toBe(0);
    // Another process stored the definitive outcome of this seal identity.
    const identity = createHash("sha256")
      .update([pkg.id, pkg.sealSha256, fp, pkg.storageBucket, pkg.storageKey, pkg.s3VersionId].join("|"), "utf8")
      .digest("hex");
    await prisma.packageSealByteCheck.create({ data: { identitySha256: identity, packageId: pkg.id, outcome: "VERIFIED", complete: true } });
    sealCheck.clearPackageSealCheckMemo();
    expect((await sealCheck.resolvePackageSealCheck(pkg)).fact).toMatchObject({ kind: "PUBLISHED", completenessVerified: true });
    // Revocation is still read live: a stored VERIFIED never hides it.
    await prisma.$executeRawUnsafe(`UPDATE signing_keys SET revoked_at = now() WHERE key_id = $1`, keyId);
    expect((await sealCheck.resolvePackageSealCheck(pkg)).fact.kind).toBe("KEY_REVOKED");
  });
});
