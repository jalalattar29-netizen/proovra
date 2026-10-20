/**
 * AUD-48 (2026-10-20) — Public Verify details, over real HTTP against live
 * PostgreSQL 16 with a genuinely signed record:
 *
 *   * the history lists EVERY issued report (not only the latest);
 *   * TSA validation is a declared live-delta category;
 *   * a recorded TSA failure is stated by its code — the provider's raw
 *     response text never leaves the server;
 *   * the retired auto-refresh flag is not sent.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TSA_FAILURE_NOTES } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";
import { shareLinkFor } from "../helpers/verify-share.js";

describe("AUD-48 Public Verify details (live PostgreSQL 16, real HTTP)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  const keyId = `aud48-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    await prisma.signingKey.create({ data: { keyId, version: 1, publicKeyPem } });
    // The rich page (history, live delta, timestamp details) is a paid tier.
    await prisma.team.update({ where: { id: harness.fixtures.teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
  }, 180_000);
  afterAll(async () => {
    await harness?.cleanup();
  });

  const RAW_PROVIDER_TEXT = "HTTP 403 Kontingent verbraucht https://tsa.internal.example/api?key=abc";

  async function signedRecordWithTwoReports() {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "AUD-48 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(),
        tsaStatus: "FAILED",
        tsaFailureCode: "tsa_provider_quota_exceeded",
        tsaFailureReason: RAW_PROVIDER_TEXT,
      } as never,
    });
    for (const version of [1, 2]) {
      await prisma.report.create({
        data: { evidenceId: row.id, version, storageBucket: "b", storageKey: `r/${row.id}/${version}.pdf`, generatedAtUtc: new Date(Date.now() - (3 - version) * 60_000), pdfSha256: createHash("sha256").update(`r${version}${row.id}`).digest("hex") } as never,
      });
    }
    return row.id;
  }

  it("lists every issued report, declares TSA validation as live, words the TSA failure by its code, and sends no auto-refresh flag", async () => {
    const id = await signedRecordWithTwoReports();
    const res = await harness.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      versioning?: { history?: Array<{ kind: string; version: number }> };
      outputContext?: { liveDeltaMaterials?: string[] };
      liveAnchoring?: Record<string, unknown>;
    };
    expect(body.versioning?.history?.filter((h) => h.kind === "report").map((h) => h.version)).toEqual([1, 2]);
    expect(body.outputContext?.liveDeltaMaterials).toContain("timestampValidation");
    expect(body.liveAnchoring ?? {}).not.toHaveProperty("autoRefreshRecommended");
    expect(res.body).not.toContain("Kontingent");
    expect(res.body).not.toContain("tsa.internal.example");
    if (res.body.includes("failureReason")) expect(res.body).toContain(TSA_FAILURE_NOTES.QUOTA);
  });

  it("a reference to a record with no recorded seal answers its truthful state, not 'not signed' / not found", async () => {
    const { generateVerificationRef } = await import("@proovra/shared-runtime");
    const A = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ref = generateVerificationRef();
    await prisma.evidence.create({
      data: { title: "unsealed", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, verificationRef: ref } as never,
    });
    const res = await harness.app.inject({ method: "GET", url: `/public/verify/${ref}` });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERIFICATION_RECORD_NOT_SEALED" });
    expect(res.body).not.toContain("not signed");
  });
});
