/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G4B-BILLING-STORAGE (live PostgreSQL + Redis).
 *
 * Billing correctness and Free storage / output accounting. Every exclusion
 * has a control that still counts (a later customer version, a paid record,
 * a record whose report was issued), and every billing change keeps the
 * billing sweep holds: the switches stay at their default (off) here.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), the API over HTTP (create,
 * part presign, complete, add-on cancel, Stripe webhook), the capacity lock,
 * both hosts' usage measures and the worker's own report/package gates, the
 * worker's first-issuance sweep (dry run) and capture reaper.
 * DOUBLED: the object store (in-process), the evidence signer, the RFC 3161
 * authority, and every payment provider client (no socket is opened).
 * SIMULATED: the worker's COMMIT of report/package rows after its gate admits
 * them (fixture rows with the sizes the worker would record), exactly as in
 * free-first-issuance-allowance.integration.test.ts.
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
import type { StorageAddonProviderCanceller } from "../src/services/billing/storage-addon-cancellation.service.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const stripeRequestMock = vi.hoisted(() => vi.fn(async () => ({ cancel_at_period_end: true })));
const paypalCancelMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `https://g4b-test-store.invalid/${encodeURIComponent(id(p))}`,
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
        signatureBase64: Buffer.from(`g4b-test-signature:${hex}`).toString("base64"),
        keyId: "g4b-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

// Payment providers: never a network call.
vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeRequest: (...args: unknown[]) => stripeRequestMock(...(args as [])),
    stripeRequestRaw: async () => ({}),
  };
});
vi.mock("../src/services/paypal.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cancelPayPalSubscription: (...args: unknown[]) => paypalCancelMock(...(args as [])),
  };
});

process.env.S3_BUCKET = "g4b-billing-storage-test-bucket";
const BUCKET = process.env.S3_BUCKET;
const MIB = 1024 * 1024;
const MiB = (n: number) => BigInt(n) * BigInt(MIB);
const GB = BigInt(1024) ** BigInt(3);
const DAY = 24 * 60 * 60 * 1000;

describe("free-audit 0ea0 — API-G4B-BILLING-STORAGE (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let enforcement: typeof import("../src/services/billing-enforcement.service.js");
  let worker: typeof import("../../worker/src/workspace-billing.js");
  let sweep: typeof import("../../worker/src/first-issuance-reconciliation.js");
  let reaper: typeof import("../../worker/src/capture-reaper.js");
  let outputs: typeof import("../src/services/reports/output-recovery.service.js");
  let projection: typeof import("../src/services/billing/billing-account-projection.service.js");
  let cancelSubscription: (typeof import("../src/services/billing/subscription-cancellation.service.js"))["requestSubscriptionCancellation"];
  let activity: typeof import("../src/services/billing/billing-activity.service.js");
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
    enforcement = await import("../src/services/billing-enforcement.service.js");
    worker = await import("../../worker/src/workspace-billing.js");
    sweep = await import("../../worker/src/first-issuance-reconciliation.js");
    reaper = await import("../../worker/src/capture-reaper.js");
    outputs = await import("../src/services/reports/output-recovery.service.js");
    projection = await import("../src/services/billing/billing-account-projection.service.js");
    ({ requestSubscriptionCancellation: cancelSubscription } = await import(
      "../src/services/billing/subscription-cancellation.service.js"
    ));
    activity = await import("../src/services/billing/billing-activity.service.js");
    pool = randomBytes(160 * MIB);
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `g4b-${Date.now().toString(36)}`,
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
    stripeRequestMock.mockClear();
    paypalCancelMock.mockClear();
  });

  afterAll(async () => {
    if (savedTsa === undefined) delete process.env.TSA_ENABLED;
    else process.env.TSA_ENABLED = savedTsa;
    objects.clear();
    await h?.cleanup();
  }, 120_000);

  const call = (method: "GET" | "POST", url: string, token: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: typeof payload === "string" ? payload : JSON.stringify(payload) } : {}),
    });

  function original(mib: number): Buffer {
    poolOffset = (poolOffset + 4099) % (8 * MIB);
    return pool.subarray(poolOffset, poolOffset + mib * MIB);
  }

  async function capture(token: string, body: Buffer): Promise<string> {
    const created = await call("POST", "/v1/evidence", token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
      partIndex: 0,
      mimeType: "text/plain",
      originalFileName: "g4b.bin",
      sizeBytes: body.length,
    });
    expect(part.statusCode, part.body).toBe(201);
    const u = part.json().upload;
    objects.set(`${u.bucket}/${u.key}`, body);
    const done = await call("POST", `/v1/evidence/${id}/complete`, token, {});
    expect(done.statusCode, done.body).toBe(200);
    return id;
  }

  /** The worker's gates in processor order, then the rows the worker commits. */
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
        ...(version > 1 ? { previousReportVersion: version - 1, issueReason: "g4b later version" } : {}),
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
    await prisma.reportGenerationRequest.updateMany({
      where: { evidenceId, state: { in: ["QUEUED", "PROCESSING"] } },
      data: { state: "SUCCEEDED", completedAtUtc: new Date(), reportVersion: version, stage: "PACKAGE_PUBLISHED", resultReportId: report.id } as never,
    });
    return report.id;
  }

  async function bothHosts(t: PersonalTenant) {
    const api = await apiUsage(await enforcement.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await worker.getWorkspaceUsage(
      await worker.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    expect(wk.storageBytesUsed, "worker = API").toBe(api.storageBytesUsed);
    expect(wk.actualStorageBytes, "worker actual = API actual").toBe(api.actualStorageBytes);
    return api;
  }

  // ===========================================================================
  // Free storage / output accounting
  // ===========================================================================

  it("B4-F-001 — an integrity-rejected record with no report frees its Free slot (storage still counted); one with a report keeps it", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ids = [await capture(t.owner.token, original(1)), await capture(t.owner.token, original(1)), await capture(t.owner.token, original(1))];
    expect(await enforcement.countPersonalEvidenceRecords(t.owner.userId)).toBe(3);
    const refused = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(refused.statusCode, "3/3 refuses a 4th").not.toBe(201);

    // The worker's integrity rejection (integrity-rejection.service.ts).
    await prisma.evidence.update({ where: { id: ids[0]! }, data: { status: "FAILED_HASH_MISMATCH", verificationStatus: "FAILED" } });
    expect(await enforcement.countPersonalEvidenceRecords(t.owner.userId), "meter 2/3").toBe(2);
    const usage = await bothHosts(t);
    expect(usage.storageBytesUsed, "its bytes stay counted until destroyed").toBe(MiB(3));
    const admitted = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // Control: a rejected record whose report was committed keeps its slot,
    // trashed or not (trash never frees a slot).
    const c = await seedPersonalTenant(deps, "FREE");
    const cid = [await capture(c.owner.token, original(1)), await capture(c.owner.token, original(1)), await capture(c.owner.token, original(1))];
    await issuePair(cid[0]!, { report: MiB(1), full: MiB(1), ext: MiB(1) });
    await prisma.evidence.update({
      where: { id: cid[0]! },
      data: { status: "FAILED_HASH_MISMATCH", verificationStatus: "FAILED", deletedAt: new Date(), lifecycleState: "TRASHED" as never },
    });
    expect(await enforcement.countPersonalEvidenceRecords(c.owner.userId)).toBe(3);
    const still = await call("POST", "/v1/evidence", c.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(still.statusCode).not.toBe(201);
  }, 300_000);

  it("B4-F-003 — a multi-file record over the remaining Free storage is refused at the presign that crosses it, before upload", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const created = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const presign = (partIndex: number) =>
      call("POST", `/v1/evidence/${id}/parts`, t.owner.token, {
        partIndex,
        mimeType: "text/plain",
        originalFileName: `g4b-${partIndex}.bin`,
        sizeBytes: 100 * MIB,
      });
    expect((await presign(0)).statusCode).toBe(201);
    expect((await presign(1)).statusCode).toBe(201);
    // An idempotent re-presign of a declared index is not counted twice.
    expect([200, 201]).toContain((await presign(1)).statusCode);
    const third = await presign(2);
    expect(third.statusCode, third.body).toBe(409);
    expect(third.json().code ?? third.json().error?.code).toBe("STORAGE_LIMIT_REACHED");
  }, 300_000);

  it("B5B-F-400 — the automatic chain-verified version of a Free record is first issuance on both hosts; records 2 and 3 still fit", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const r1 = await capture(t.owner.token, original(100));
    await issuePair(r1, { report: MiB(1), full: MiB(101), ext: MiB(1) });
    expect((await bothHosts(t)).storageBytesUsed).toBe(MiB(100));

    // ensureOtsAnchoredReportVersion: purpose ots_upgrade_completed, machine
    // principal, the worker's reserved version 2.
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: t.personalTeamId,
        evidenceId: r1,
        artifactType: "REPORT",
        purpose: "ots_upgrade_completed",
        forceRegenerate: true,
        regenerateReason: "ots_chain_verified",
        requestedByMachineId: "worker.ots-chain-verified",
        idempotencyKey: `g4b-ots:${r1}`,
        intent: "NEW_VERSION",
        state: "QUEUED",
        reportVersion: 2,
      },
    });
    await issuePair(r1, { report: MiB(2), full: MiB(101), ext: MiB(1) }, 2);
    const after = await bothHosts(t);
    expect(after.storageBytesUsed, "the automatic version is not customer storage").toBe(MiB(100));
    expect(after.actualStorageBytes).toBe(MiB(100 + 103 + 104));

    const r2 = await capture(t.owner.token, original(75));
    const r3 = await capture(t.owner.token, original(75));
    expect([r2, r3].every(Boolean)).toBe(true);
    expect((await bothHosts(t)).storageBytesUsed).toBe(MiB(250));

    // Control: a CUSTOMER's updated report (any later version not issued by a
    // system re-issue) still counts.
    const c = await seedPersonalTenant(deps, "FREE");
    const c1 = await capture(c.owner.token, original(10));
    await issuePair(c1, { report: MiB(1), full: MiB(11), ext: MiB(1) });
    await issuePair(c1, { report: MiB(1), full: MiB(11), ext: MiB(1) }, 2);
    expect((await bothHosts(c)).storageBytesUsed).toBe(MiB(10 + 13));
  }, 600_000);

  it("B5B-F-403 + B4-F-002 — a credit-funded record's first issuance and a Free record's derived materials are not customer storage; a paid record's derived bytes still count", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
    const free = [await capture(t.owner.token, original(1)), await capture(t.owner.token, original(1)), await capture(t.owner.token, original(1))];
    const credit = await capture(t.owner.token, original(90));
    const consumed = await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: credit, entryType: "CONSUMPTION" } });
    expect(consumed, "the 4th record is credit-funded").toBe(1);
    await issuePair(credit, { report: MiB(1), full: MiB(91), ext: MiB(1) });
    let usage = await bothHosts(t);
    expect(usage.storageBytesUsed, "credit first issuance excluded").toBe(MiB(93));

    // Derived review materials of an entitled Free record.
    const part = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId: free[0]! }, select: { id: true } });
    await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: t.personalTeamId,
        evidenceId: free[0]!,
        evidencePartId: part.id,
        assetKind: "screen_recording_combined",
        status: "SUPERSEDED",
        sizeBytes: 20 * MIB,
        variantKey: `g4b-${randomUUID().slice(0, 8)}`,
        storageBucket: BUCKET,
        storageKey: `derived/${free[0]}/g4b-${randomUUID()}`,
      } as never,
    });
    usage = await bothHosts(t);
    expect(usage.storageBytesUsed, "derived bytes of a Free record excluded").toBe(MiB(93));
    expect(usage.actualStorageBytes, "still observable").toBe(MiB(93 + 93 + 20));

    // Control: on PRO a record's derived bytes count (UC-0 D5 unchanged).
    const p = await seedPersonalTenant(deps, "PRO");
    const pr = await capture(p.owner.token, original(1));
    const pp = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId: pr }, select: { id: true } });
    await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: p.personalTeamId,
        evidenceId: pr,
        evidencePartId: pp.id,
        assetKind: "screen_recording_combined",
        status: "SUPERSEDED",
        sizeBytes: 5 * MIB,
        variantKey: `g4b-${randomUUID().slice(0, 8)}`,
        storageBucket: BUCKET,
        storageKey: `derived/${pr}/g4b-${randomUUID()}`,
      } as never,
    });
    expect((await bothHosts(p)).storageBytesUsed).toBe(MiB(6));
  }, 600_000);

  it("B5B-F-101 — a Free record without newer facts is not offered an updated report; a credit-funded record still is", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
    const free = await capture(t.owner.token, original(1));
    await capture(t.owner.token, original(1));
    await capture(t.owner.token, original(1));
    const credit = await capture(t.owner.token, original(1));
    for (const id of [free, credit]) {
      await issuePair(id, { report: MiB(1), full: MiB(1), ext: MiB(1) });
      await prisma.evidence.update({ where: { id }, data: { status: "REPORTED" } });
    }
    const facts = await outputs.loadEvidenceOutputFacts({ evidenceIds: [free, credit], callerUserId: t.owner.userId });
    expect(facts.get(free)!.actions.newVersion).toMatchObject({ action: "NONE", reason: "NO_MATERIAL_CHANGE" });
    expect(facts.get(credit)!.actions.newVersion.reason).not.toBe("NO_MATERIAL_CHANGE");
  }, 300_000);

  it("B5B-F-402 — a storage-refused package is not re-requested every sweep until the allowance would admit it", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const r1 = await capture(t.owner.token, original(100));
    await issuePair(r1, { report: MiB(1), full: MiB(101), ext: MiB(1) });
    // A customer v2 report committed; its package was refused for storage.
    await prisma.report.create({
      data: {
        evidenceId: r1,
        version: 2,
        storageBucket: BUCKET,
        storageKey: `reports/${r1}/v2-${randomUUID()}.pdf`,
        generatedAtUtc: new Date(),
        sizeBytes: MiB(2),
        issueKind: "UPDATED_REPORT",
        previousReportVersion: 1,
        issueReason: "g4b updated",
      } as never,
    });
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: t.personalTeamId,
        evidenceId: r1,
        artifactType: "REPORT",
        purpose: "updated_report",
        idempotencyKey: `g4b-refused:${r1}`,
        intent: "NEW_VERSION",
        state: "NOT_APPLICABLE",
        terminalReasonCode: "NOT_APPLICABLE_STORAGE_LIMIT",
        reportVersion: 2,
        stage: "REPORT_COMMITTED",
      },
    });
    await prisma.evidence.update({ where: { id: r1 }, data: { status: "REPORTED" } });
    await capture(t.owner.token, original(120)); // 222 MiB used; the package estimate (102 MiB) does not fit.

    const held = await sweep.runFirstIssuanceReconciliation({ trigger: "test", dryRun: true });
    expect(held.packageSkippedStorageRefused).toBe(1);
    expect(held.packageScheduled).toBe(0);

    // Storage added (an upgrade): the package is asked for again.
    await setAccountPlan(deps, t.owner.userId, "PRO");
    const freed = await sweep.runFirstIssuanceReconciliation({ trigger: "test", dryRun: true });
    expect(freed.packageSkippedStorageRefused).toBe(0);
    expect(freed.packageScheduled).toBe(1);
    await prisma.evidence.update({ where: { id: r1 }, data: { status: "SIGNED" } });
  }, 600_000);

  it("B4-F-004 — a released reservation whose object delete failed is retried by the next reaper run", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: "g4b reservation", type: "PHOTO", status: "UPLOADING", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const key = `parts/${ev.id}/0`;
    await prisma.evidencePart.create({
      data: { evidenceId: ev.id, partIndex: 0, storageBucket: "g4b-sweep-bucket", storageKey: key, mimeType: "image/jpeg" } as never,
    });
    const at = new Date(Date.now() - 2 * DAY);
    await prisma.$executeRaw`UPDATE evidence SET created_at = ${at}, updated_at = ${at} WHERE id = ${ev.id}::uuid`;

    const first: string[] = [];
    await reaper.runCaptureReaperSweep({
      trigger: "test",
      deleteObject: async (o) => {
        first.push(o.key);
        return { deleted: false, deletedVersions: 0, retainedVersions: 0, deleteMarkerOnly: false, failed: 1 };
      },
    });
    expect(first).toContain(key);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { deletedAt: true } })).deletedAt).not.toBeNull();

    const second: string[] = [];
    await reaper.runCaptureReaperSweep({
      trigger: "test",
      deleteObject: async (o) => {
        second.push(o.key);
        return { deleted: true, deletedVersions: 1, retainedVersions: 0, deleteMarkerOnly: false, failed: 0 };
      },
    });
    expect(second, "the failed delete is retried").toContain(key);

    const third: string[] = [];
    await reaper.runCaptureReaperSweep({
      trigger: "test",
      deleteObject: async (o) => {
        third.push(o.key);
        return { deleted: true, deletedVersions: 1, retainedVersions: 0, deleteMarkerOnly: false, failed: 0 };
      },
    });
    expect(third, "a completed delete is not carried further").not.toContain(key);
  }, 300_000);

  // ===========================================================================
  // Billing correctness
  // ===========================================================================

  async function seedAddon(ownerUserId: string, extra: Record<string, unknown> = {}) {
    return prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        teamId: null,
        addonKey: "TEAM_100_GB",
        extraStorageBytes: BigInt(10) * GB,
        billingCycle: "MONTHLY",
        status: "ACTIVE",
        paymentProvider: "STRIPE",
        externalSubscriptionId: `addon-${randomUUID()}`,
        ...extra,
      } as never,
      select: { id: true, externalSubscriptionId: true },
    });
  }

  async function seedBase(userId: string, extra: Record<string, unknown> = {}) {
    return prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `sub-${randomUUID()}`,
        status: "ACTIVE",
        plan: "TEAM",
        teamId: null,
        activatedAtUtc: new Date(Date.now() - 20 * DAY),
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  const accepting = () => {
    const calls: string[] = [];
    const fn: StorageAddonProviderCanceller = async ({ providerRef, mode }) => {
      calls.push(providerRef);
      return { ok: true, mode, terminal: mode === "IMMEDIATE" };
    };
    return { fn, calls };
  };

  it("B6-F-83 — another payer's add-on and an unknown id answer byte-identical 404s", async () => {
    const a = await seedPersonalTenant(deps, "PRO");
    const b = await seedPersonalTenant(deps, "PRO");
    const theirs = await seedAddon(b.owner.userId);
    const other = await call("POST", "/v1/billing/storage-addons/cancel", a.owner.token, { addonId: theirs.id });
    const unknown = await call("POST", "/v1/billing/storage-addons/cancel", a.owner.token, { addonId: randomUUID() });
    expect(other.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(other.body).toBe(unknown.body);
    expect(stripeRequestMock).not.toHaveBeenCalled();
  }, 120_000);

  it("B6-F-61 — a repeat add-on cancel is a no-op: no provider call, the recorded cancellation time kept", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const canceledAt = new Date(Date.now() - 60_000);
    const addon = await seedAddon(t.owner.userId, { canceledAtUtc: canceledAt });
    const res = await call("POST", "/v1/billing/storage-addons/cancel", t.owner.token, { addonId: addon.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ alreadyCanceled: true, addon: { id: addon.id, canceledAtUtc: canceledAt.toISOString() } });
    expect(stripeRequestMock).not.toHaveBeenCalled();
    const row = await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id }, select: { canceledAtUtc: true } });
    expect(row.canceledAtUtc?.toISOString()).toBe(canceledAt.toISOString());
  }, 120_000);

  it("B6-F-61 / B6-F-62 — add-on canCancel follows BILLING_CANCEL and is false on an ending row", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    const live = await seedAddon(t.owner.userId);
    const ending = await seedAddon(t.owner.userId, { canceledAtUtc: new Date(), currentPeriodEnd: new Date(Date.now() + 5 * DAY) });
    const asManagedPayer = await projection.buildBillingAccountProjection({
      account: {
        type: "PERSONAL",
        id: t.owner.userId,
        displayName: "Personal",
        capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"],
        billingOwnerMissing: false,
      },
      viewerUserId: t.owner.userId,
    });
    const rows = (asManagedPayer as unknown as { storageAddons?: { active: Array<{ id: string; canCancel: boolean; canRecheck: boolean }> } }).storageAddons?.active ?? [];
    expect(rows.find((r) => r.id === live.id)?.canCancel, "managed payer may cancel a live add-on").toBe(true);
    expect(rows.find((r) => r.id === ending.id)?.canCancel, "an ending add-on offers no Cancel").toBe(false);
  }, 120_000);

  it("B6-F-82 — a customer's plan cancel records obligations only for its own dependants; a held orphan stays NONE (switch off)", async () => {
    expect(process.env.BILLING_AUTO_ADDON_CANCELLATION ?? "").not.toBe("on");
    const t = await seedPersonalTenant(deps, "PRO");
    const oldBase = await seedBase(t.owner.userId, { status: "CANCELED", currentPeriodEnd: new Date(Date.now() - 30 * DAY), activatedAtUtc: new Date(Date.now() - 60 * DAY) });
    const orphan = await seedAddon(t.owner.userId, { dependsOnSubscriptionId: oldBase.id });
    const live = await seedBase(t.owner.userId, { plan: "PRO" });
    const own = await seedAddon(t.owner.userId, { addonKey: "TEAM_500_GB", dependsOnSubscriptionId: live.id });

    const { fn, calls } = accepting();
    await cancelSubscription({ subscriptionId: live.id, cancelAddonAtProvider: fn });

    const state = async (id: string) =>
      (await prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id }, select: { dependentCancellationState: true } })).dependentCancellationState;
    expect(await state(orphan.id), "held orphan untouched").toBe("NONE");
    expect(calls).not.toContain(orphan.externalSubscriptionId);
    expect(await state(own.id), "its own dependant is cancelled").not.toBe("NONE");
    expect(calls).toContain(own.externalSubscriptionId);
  }, 120_000);

  it("B6-F-84 — a repeat cancel records the dependent obligation a crash swallowed", async () => {
    const t = await seedPersonalTenant(deps, "TEAM");
    // The provider agreed and the webhook wrote cancelAtPeriodEnd, but the
    // obligation transaction never committed.
    const base = await seedBase(t.owner.userId, { cancelAtPeriodEnd: true });
    const addon = await seedAddon(t.owner.userId, { dependsOnSubscriptionId: base.id });
    const { fn, calls } = accepting();
    const res = await cancelSubscription({ subscriptionId: base.id, cancelAddonAtProvider: fn });
    expect(res.alreadyScheduled).toBe(true);
    expect(res.dependentAddonsFound).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(addon.externalSubscriptionId);
    expect(stripeRequestMock, "the base is never re-cancelled").not.toHaveBeenCalled();
  }, 120_000);

  it("B6-F-01 — a managed payer may abandon its own pending plan attempt (no 403)", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const attempt = await prisma.billingCheckoutAttempt.create({
      data: {
        userId: t.owner.userId,
        product: "PLAN",
        provider: "STRIPE",
        planKey: "PRO",
        amountCents: 1900,
        currency: "USD",
        status: "PENDING",
        checkoutState: "PROVIDER_CREATE_IN_PROGRESS",
      } as never,
      select: { id: true },
    });
    const managedPayer = {
      type: "PERSONAL" as const,
      id: t.owner.userId,
      displayName: "Personal",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"] as never,
      billingOwnerMissing: false,
    };
    const result = await activity
      .abandonBillingAttempt({ account: managedPayer, attemptId: attempt.id, providers: {} as never })
      .catch((err: unknown) => err as { statusCode?: number; code?: string });
    expect((result as { code?: string }).code).not.toBe("BILLING_CAPABILITY_REQUIRED");
    expect((result as { attemptId?: string }).attemptId).toBe(attempt.id);
  }, 120_000);

  it("B6-F-80 — a Stripe delivery while STRIPE_WEBHOOK_SECRET is unset is 503 (retryable), not a forged-signature 400", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const before = await prisma.securityEvent.count({ where: { eventType: "webhook_signature_failure" } });
      const res = await call("POST", "/webhooks/stripe", null, JSON.stringify({ id: "evt_g4b", type: "ping" }), {
        "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`,
      });
      expect(res.statusCode, res.body).toBe(503);
      await new Promise((r) => setImmediate(r));
      expect(await prisma.securityEvent.count({ where: { eventType: "webhook_signature_failure" } })).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  }, 120_000);
});
