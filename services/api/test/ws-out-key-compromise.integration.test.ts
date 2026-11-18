/**
 * WS-OUT / RG-03 — the key-compromise replacement and owner notices
 * (live PostgreSQL, real routes).
 *
 *   PRO-W1-08 / PRO-O1-01  a replacement attempt that ended terminally is
 *       offered again and asked as a NEW request (bounded), never replayed dead.
 *   PRO-W1-02  the replacement is its own request identity: it never collapses
 *       onto another purpose's forced request at the same baseline, and a live
 *       other-purpose request is reported truthfully (409), not "ok".
 *   PRO-O1Z-01 / DEC-03  the replacement is owed whatever the subject's plan is
 *       now: a FREE / lapsed workspace record without an earned fact gets it.
 *   PRO-O1-13  a record whose owner left the workspace notifies the current
 *       OWNER/ADMIN; deferred records are completed by the continuation sweep.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const ENV_KEYS = ["SIGNING_KEY_ID", "SIGNING_KEY_VERSION", "PACKAGE_SIGNING_KEY_ID", "PACKAGE_SIGNING_KEY_VERSION"] as const;
const IN_APP = "signing_key_compromise_notice";
const PURPOSE = "signing_key_compromise_replacement";

describe("WS-OUT RG-03 — key-compromise replacement and notices (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let owners: typeof import("../src/services/operations/signing-key-compromise-owners.service.js");
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
    runtime = await import("@proovra/shared-runtime");
    owners = await import("../src/services/operations/signing-key-compromise-owners.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
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
  async function register(keyId: string, purpose: "EVIDENCE_SIGNATURE" | "PACKAGE_SEAL") {
    const pem = keyPem();
    const sha = runtime.publicKeySpkiSha256(pem);
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: pem, purpose, fingerprintSha256: sha } as never,
    });
    return sha;
  }

  /** A record whose v1 package was sealed by `seal`, and a healthy current signer pair. */
  async function compromisedRecord(plan: "ENTERPRISE" | "FREE" = "ENTERPRISE") {
    await clearRates();
    const t = randomUUID().slice(0, 8);
    const eSha = await register(`wo-e-${t}`, "EVIDENCE_SIGNATURE");
    const xSha = await register(`wo-x-${t}`, "PACKAGE_SEAL");
    await register(`wo-n-${t}`, "PACKAGE_SEAL");
    process.env.SIGNING_KEY_ID = `wo-e-${t}`;
    process.env.SIGNING_KEY_VERSION = "1";
    process.env.PACKAGE_SIGNING_KEY_ID = `wo-n-${t}`;
    process.env.PACKAGE_SIGNING_KEY_VERSION = "1";
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: plan, billingStatus: "ACTIVE" } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const e = await prisma.evidence.create({
      data: {
        title: "ws-out key compromise fixture",
        type: "PHOTO",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        sizeBytes: 5_000n,
        signingKeyId: `wo-e-${t}`,
        signingKeyVersion: 1,
        signingKeySha256: eSha,
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
        sealSigningKeyId: `wo-x-${t}`,
        sealSigningKeyVersion: 1,
        sealSigningKeySha256: xSha,
        sealSha256: createHash("sha256").update(e.id).digest("hex"),
      } as never,
    });
    await prisma.signingKey.updateMany({ where: { keyId: `wo-x-${t}` }, data: { revokedAt: new Date(Date.now() - 1_000) } });
    return { evidenceId: e.id, t, xSha };
  }

  const status = async (evidenceId: string) => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/artifacts/status`,
      headers: { authorization: `Bearer ${A().ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { keyCompromise: { replacement: string } | null }).keyCompromise;
  };
  const replace = (evidenceId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${evidenceId}/reports/regenerate`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
      payload: { intent: "KEY_COMPROMISE_REPLACEMENT" },
    });

  it("PRO-W1-08 / O1-01: a terminal replacement attempt is offered again and asked as a new request", async () => {
    const { evidenceId } = await compromisedRecord();
    expect((await status(evidenceId))?.replacement).toBe("AVAILABLE");
    const first = await replace(evidenceId);
    expect(first.statusCode, first.body).toBe(202);
    const row = await prisma.reportGenerationRequest.findFirstOrThrow({
      where: { evidenceId, purpose: PURPOSE },
      select: { id: true },
    });
    // The worker ends it terminally (its own signer check failed during a deploy skew).
    await prisma.reportGenerationRequest.update({
      where: { id: row.id },
      data: { state: "FAILED_TERMINAL", terminalReasonCode: "REPLACEMENT_SIGNER_NOT_USABLE", completedAtUtc: new Date() } as never,
    });
    expect((await status(evidenceId))?.replacement).toBe("AVAILABLE");
    const second = await replace(evidenceId);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().outcome).not.toBe("REPLAYED");
    const rows = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId, purpose: PURPOSE },
      select: { id: true, state: true, clientRequestKey: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id !== row.id)?.state).toBe("QUEUED");
    // A repeat of the live attempt replays it (no third row).
    const third = await replace(evidenceId);
    expect(third.statusCode, third.body).toBe(202);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId, purpose: PURPOSE } })).toBe(2);
  });

  it("PRO-W1-02: a terminal updated_report at the same baseline does not swallow the replacement; a live one is reported truthfully", async () => {
    const { evidenceId } = await compromisedRecord();
    const other = await prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId,
        artifactType: "REPORT",
        purpose: "updated_report",
        forceRegenerate: true,
        requestedByUserId: A().ownerUserId,
        idempotencyKey: `REPORT:${evidenceId}:v1:force`,
        state: "FAILED_TERMINAL",
        terminalReasonCode: "VERIFICATION_PACKAGE_STORAGE_REJECTED",
      } as never,
      select: { id: true },
    });
    const asked = await replace(evidenceId);
    expect(asked.statusCode, asked.body).toBe(202);
    const mine = await prisma.reportGenerationRequest.findFirst({
      where: { evidenceId, purpose: PURPOSE },
      select: { id: true, state: true },
    });
    expect(mine?.id).toBeDefined();
    expect(mine?.id).not.toBe(other.id);
    expect(mine?.state).toBe("QUEUED");

    // Live variant: another purpose's forced request is running.
    const { evidenceId: second } = await compromisedRecord();
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: A().teamId,
        evidenceId: second,
        artifactType: "REPORT",
        purpose: "updated_report",
        forceRegenerate: true,
        requestedByUserId: A().ownerUserId,
        idempotencyKey: `REPORT:${second}:v1:force`,
        state: "QUEUED",
      } as never,
    });
    expect((await status(second))?.replacement).toBe("IN_PROGRESS");
    const refused = await replace(second);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("KEY_COMPROMISE_REPLACEMENT_OTHER_REQUEST_ACTIVE");
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: second, purpose: PURPOSE } })).toBe(0);
  });

  it("PRO-O1Z-01: a FREE workspace record with no earned fact is still given the owed replacement", async () => {
    const { evidenceId } = await compromisedRecord("FREE");
    try {
      expect((await status(evidenceId))?.replacement).toBe("AVAILABLE");
      const asked = await replace(evidenceId);
      expect(asked.statusCode, asked.body).toBe(202);
      expect(await prisma.reportGenerationRequest.count({ where: { evidenceId, purpose: PURPOSE } })).toBe(1);
    } finally {
      await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE" } });
    }
  });

  it("PRO-O1-13: a departed owner's record notifies the workspace owner; deferred records are completed by the continuation sweep", async () => {
    const { evidenceId, xSha, t } = await compromisedRecord();
    // The record's owner is a member who has since been removed.
    const departed = await prisma.user.create({
      data: { email: `departed-${t}@test.proovra.local`, provider: "EMAIL", providerUserId: `departed-${t}` } as never,
      select: { id: true },
    });
    await prisma.evidence.update({ where: { id: evidenceId }, data: { ownerUserId: departed.id } });
    const declaredAt = new Date(Date.now() - 500);
    await prisma.signingKey.updateMany({ where: { keyId: `wo-x-${t}` }, data: { revokedAt: declaredAt } });
    const material = {
      fingerprints: [xSha],
      keyIdentities: [{ keyId: `wo-x-${t}`, version: 1 }],
      declaredAt,
      actorUserId: null,
      inlineLimit: 0,
    };
    // Inline budget exhausted: everything is deferred.
    const inline = await owners.notifyOwnersOfKeyCompromise(material, prisma as never);
    expect(inline.deferred).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.securityEvent.count({ where: { eventType: IN_APP, details: { path: ["evidenceId"], equals: evidenceId } } }),
    ).toBe(0);
    // The continuation pass (the maintenance sweep's step) completes it, for the
    // workspace's current owner — not the departed member.
    await owners.notifyOwnersOfKeyCompromise({ ...material, inlineLimit: 50 }, prisma as never);
    const notices = await prisma.securityEvent.findMany({
      where: { eventType: IN_APP, details: { path: ["evidenceId"], equals: evidenceId } },
      select: { userId: true },
    });
    expect(notices.map((n) => n.userId)).toContain(A().ownerUserId);
    expect(notices.map((n) => n.userId)).not.toContain(departed.id);
    // The sweep entry point exists and is idempotent on a finished compromise.
    const swept = await owners.continueKeyCompromiseNotices({}, prisma as never);
    expect(swept.failed).toBe(0);
    expect(
      await prisma.securityEvent.count({ where: { eventType: IN_APP, details: { path: ["evidenceId"], equals: evidenceId } } }),
    ).toBe(notices.length);
  });
});
