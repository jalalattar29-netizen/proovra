/**
 * FREE-USER AUDIT 0ea0 — B7A-F-006 (live PostgreSQL).
 *
 * A signing key declared COMPROMISED: the owners of records whose ISSUED
 * outputs it signed or sealed are told — once each, nobody else — and a linked,
 * non-charging replacement can be asked for only when the server itself finds
 * the package seal compromised AND the signers that would produce the
 * replacement are unaffected. Nothing issued is rewritten.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

const ENV_KEYS = [
  "SIGNING_KEY_ID",
  "SIGNING_KEY_VERSION",
  "PACKAGE_SIGNING_KEY_ID",
  "PACKAGE_SIGNING_KEY_VERSION",
] as const;
const NOTICE = "SIGNING_KEY_COMPROMISE_NOTICE";

describe("free-audit 0ea0 — B7A-F-006 key compromise: owner notice and linked replacement (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let rotation: typeof import("../src/services/operations/signer-rotation.service.js");
  let registry: typeof import("../src/services/operations/signer-registry.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let fx: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let clearRates: () => Promise<unknown>;
  let deps: FixtureDeps;
  let bystander: SeededUser;
  const saved: Record<string, string | undefined> = {};
  const A = () => h.fixtures.teamA;
  const dir = mkdtempSync(path.join(tmpdir(), "proovra-lane-e-compromise-"));

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
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    deps = {
      prisma: prisma as never,
      tag: `lane-e-kc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    bystander = await fx.seedUser(deps, "kc-bystander");
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: bystander.userId, role: "ADMIN", status: "ACTIVE" } });
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
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
    writeFileSync(path.join(dir, `${randomUUID()}.pem`), pem);
    return pem;
  }
  async function register(keyId: string, pem: string, purpose: "EVIDENCE_SIGNATURE" | "PACKAGE_SEAL") {
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: pem, purpose, fingerprintSha256: runtime.publicKeySpkiSha256(pem) } as never,
    });
    return runtime.publicKeySpkiSha256(pem);
  }

  /** A record with an issued v1 report and a PUBLISHED v1 package. */
  async function issuedRecord(opts: { ownerUserId: string; evidenceKey: string; evidenceSha: string; sealKey: string; sealSha: string }) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const e = await prisma.evidence.create({
      data: {
        title: "compromise fixture",
        type: "PHOTO",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: opts.ownerUserId,
        sizeBytes: 5_000n,
        signingKeyId: opts.evidenceKey,
        signingKeyVersion: 1,
        signingKeySha256: opts.evidenceSha,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    await prisma.report.create({
      data: { evidenceId: e.id, version: 1, storageBucket: "b", storageKey: `reports/${e.id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: e.id,
        version: 1,
        reportVersion: 1,
        storageBucket: "b",
        storageKey: `verification/${e.id}/v1.zip`,
        generatedAtUtc: new Date(),
        sizeBytes: 9_000n,
        sealSigningKeyId: opts.sealKey,
        sealSigningKeyVersion: 1,
        sealSigningKeySha256: opts.sealSha,
        sealSha256: createHash("sha256").update(e.id).digest("hex"),
      } as never,
    });
    return e.id;
  }

  const notices = (evidenceId?: string, recipientUserId?: string) =>
    prisma.notificationDelivery.findMany({
      where: { eventType: NOTICE, ...(evidenceId ? { evidenceId } : {}), ...(recipientUserId ? { recipientUserId } : {}) },
      select: { recipientUserId: true, evidenceId: true, subject: true, renderedPreview: true },
    });
  const replace = (evidenceId: string, token: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${evidenceId}/reports/regenerate`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { intent: "KEY_COMPROMISE_REPLACEMENT" },
    });

  it("owners of affected records only are told once each; a replacement needs an unaffected signer, is linked, idempotent and not charged", async () => {
    await clearRates();
    const t = randomUUID().slice(0, 8);
    // Evidence signer E (unaffected), seal P (to be compromised; the same
    // material also registered as an evidence identity PE), seal Q (unaffected).
    const ePem = keyPem();
    const pPem = keyPem();
    const qPem = keyPem();
    const eSha = await register(`kc-e-${t}`, ePem, "EVIDENCE_SIGNATURE");
    const pSha = await register(`kc-p-${t}`, pPem, "PACKAGE_SEAL");
    await register(`kc-pe-${t}`, pPem, "EVIDENCE_SIGNATURE");
    const qSha = await register(`kc-q-${t}`, qPem, "PACKAGE_SEAL");
    process.env.SIGNING_KEY_ID = `kc-e-${t}`;
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.PACKAGE_SIGNING_KEY_ID = `kc-p-${t}`;
    process.env.PACKAGE_SIGNING_KEY_VERSION = "1";

    const owner = A().ownerUserId;
    const sealedByP = await issuedRecord({ ownerUserId: owner, evidenceKey: `kc-e-${t}`, evidenceSha: eSha, sealKey: `kc-p-${t}`, sealSha: pSha });
    const signedByP = await issuedRecord({ ownerUserId: owner, evidenceKey: `kc-pe-${t}`, evidenceSha: pSha, sealKey: `kc-q-${t}`, sealSha: qSha });
    const unaffected = await issuedRecord({ ownerUserId: bystander.userId, evidenceKey: `kc-e-${t}`, evidenceSha: eSha, sealKey: `kc-q-${t}`, sealSha: qSha });
    const historyBefore = await prisma.verificationPackage.findMany({ where: { evidenceId: sealedByP }, orderBy: { version: "asc" } });

    const signers = await registry.listAllSigners({ teamId: A().teamId });
    const pSigner = signers.find((s) => s.signerPurpose === "verification_package")!.signerId;
    const declared = (await rotation.revokeSigner({
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      signerId: pSigner,
      reason: "lane-e: key material exposed",
      scope: "key_compromise",
    })) as unknown as { ok: boolean; state?: string; ownerNotices?: Record<string, number> | null };
    expect(declared.ok).toBe(true);
    expect(declared.ownerNotices).toMatchObject({ affectedRecords: 2, noticesEnqueued: 2, alreadyNotified: 0, failed: 0 });

    // Only the owner, only the affected records, one each.
    expect((await notices(sealedByP, owner)).length).toBe(1);
    expect((await notices(signedByP, owner)).length).toBe(1);
    expect((await notices(unaffected)).length).toBe(0);
    expect((await notices(undefined, bystander.userId)).length).toBe(0);

    // Retry: a repeated declaration writes no second notice.
    const again = (await rotation.revokeSigner({
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      signerId: pSigner,
      reason: "lane-e: repeat",
      scope: "key_compromise",
    })) as unknown as { ok: boolean; state?: string; ownerNotices?: Record<string, number> | null };
    expect(again.ok).toBe(true);
    expect(again.state).toBe("already");
    expect(again.ownerNotices).toMatchObject({ affectedRecords: 2, noticesEnqueued: 0, alreadyNotified: 2 });
    expect((await notices(sealedByP)).length + (await notices(signedByP)).length).toBe(2);

    // History is untouched: the issued package rows are exactly as they were.
    expect(await prisma.verificationPackage.findMany({ where: { evidenceId: sealedByP }, orderBy: { version: "asc" } })).toEqual(historyBefore);

    // No trustworthy replacement while the configured package signer is the compromised one.
    const blocked = await replace(sealedByP, A().ownerToken);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().code).toBe("KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER");
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: sealedByP } })).toBe(0);

    // A record whose OWN signature used the material cannot be restored by a re-issue.
    const recordSig = await replace(signedByP, A().ownerToken);
    expect(recordSig.statusCode, recordSig.body).toBe(409);
    expect(recordSig.json().code).toBe("KEY_COMPROMISE_REPLACEMENT_RECORD_SIGNATURE_NOT_REPLACEABLE");

    // An unaffected record has nothing to replace.
    const nothing = await replace(unaffected, bystander.token);
    expect(nothing.statusCode, nothing.body).toBe(409);
    expect(nothing.json().code).toBe("KEY_COMPROMISE_REPLACEMENT_NOT_AFFECTED");

    // Rotate the package seal to an approved, unaffected key: the replacement is requested.
    const nPem = keyPem();
    await register(`kc-n-${t}`, nPem, "PACKAGE_SEAL");
    process.env.PACKAGE_SIGNING_KEY_ID = `kc-n-${t}`;
    const credits = await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: sealedByP } });
    const first = await replace(sealedByP, A().ownerToken);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ operation: "KEY_COMPROMISE_REPLACEMENT", replacesReportVersion: 1 });
    const second = await replace(sealedByP, A().ownerToken);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().requestId).toBe(first.json().requestId);
    expect(second.json().outcome).toBe("REPLAYED");
    const rows = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: sealedByP },
      select: { purpose: true, clientRequestKey: true, intent: true, forceRegenerate: true },
    });
    expect(rows).toEqual([
      {
        purpose: "signing_key_compromise_replacement",
        clientRequestKey: `compromise-reissue:${sealedByP}:v1`,
        intent: "NEW_VERSION",
        forceRegenerate: true,
      },
    ]);
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: sealedByP } })).toBe(credits);

    // A caller cannot occupy the server's key space.
    const squat = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${unaffected}/reports/regenerate`,
      headers: { authorization: `Bearer ${bystander.token}`, "content-type": "application/json" },
      payload: { intent: "NEW_VERSION", reason: "A later verification fact was added", clientRequestKey: `compromise-reissue:${unaffected}:v1` },
    });
    expect(squat.statusCode, squat.body).toBe(400);
    expect(squat.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("a committed compromise replacement of a first issuance is first issuance for the allowance", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        organizationId: team.organizationId,
        title: "allowance fixture",
        type: "PHOTO",
        status: "REPORTED",
        teamId: A().teamId,
        ownerUserId: A().ownerUserId,
        sizeBytes: 1n,
      } as never,
      select: { id: true },
    });
    await prisma.report.create({ data: { evidenceId: ev.id, version: 1, storageBucket: "b", storageKey: `r/${ev.id}/1`, generatedAtUtc: new Date(), sizeBytes: 1n } });
    await prisma.report.create({
      data: { evidenceId: ev.id, version: 2, previousReportVersion: 1, storageBucket: "b", storageKey: `r/${ev.id}/2`, generatedAtUtc: new Date(), sizeBytes: 1n } as never,
    });
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId: ev.id,
        artifactType: "REPORT",
        purpose: "signing_key_compromise_replacement",
        forceRegenerate: true,
        requestedByUserId: A().ownerUserId,
        expectedPolicyVersion: 0,
        idempotencyKey: `LANE-E:${randomUUID()}`,
        state: "SUCCEEDED",
        stage: "PACKAGE_PUBLISHED",
        reportVersion: 2,
      } as never,
    });
    const first = await runtime.firstIssuanceVersionsByRecord(prisma as never, [ev.id]);
    expect([...(first.get(ev.id) ?? [])].sort()).toEqual([1, 2]);
  });
});
